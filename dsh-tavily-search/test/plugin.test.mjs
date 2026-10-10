/**
 * 插件生命周期测试：用替身 Cordis ctx 跑 apply，真的监听一个空闲端口。
 *
 * 钉住的行为：
 *   - 监听后 DSH 形状的请求能走通，key 从凭据服务现取；凭据服务缺席时退回环境变量；
 *   - 端口被同类适配服务占着 → external（不抢端口）；被别的程序占着 → conflict；
 *   - 卸载（effect 的 disposer）后端口释放；
 *   - importEnvFile：凭据库未配置才导入，已配置 / 只读时不动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, name } from '../lib/index.js';
import { createKeyResolver, importLegacyKey, ShimRuntime } from '../lib/runtime.js';
import { dshBody, freePort, memoryLogger, okTavily, post, startMockTavily } from './helpers.mjs';

/** 替身凭据服务：只实现插件用到的 resolve / describe / set。 */
function fakeCredentials(initial = {}, { writable = true } = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref), source: 'store' } : undefined;
    },
    async describe(ref) {
      return { configured: Boolean(values.get(ref)), writable };
    },
    async set(ref, value) {
      values.set(ref, value);
    },
  };
}

/** 替身 ctx：收集 effect 的 disposer，按 name 提供 Host Service。 */
function fakeContext(services = {}) {
  const disposers = [];
  const logger = memoryLogger();
  return {
    logger,
    disposers,
    get: (key) => services[key],
    effect(factory) {
      disposers.push(factory());
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) await dispose?.();
    },
  };
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

test('入口导出：名字与包名一致，不声明 Host Service 依赖', () => {
  assert.equal(name, 'dsh-tavily-search');
  assert.deepEqual(inject, []);
});

test('apply 后监听端口，key 从凭据服务现取；卸载后端口释放', async (t) => {
  const scenario = { requests: [], handler: okTavily([{ title: 'T', url: 'https://example.com/x', content: 's' }]) };
  const mock = await startMockTavily(scenario);
  t.after(() => mock.server.close());

  const port = await freePort();
  const credentials = fakeCredentials({ TAVILY_API_KEY: 'tvly-from-store' });
  const ctx = fakeContext({ credentials });
  apply(ctx, { port, tavilyBaseUrl: `http://127.0.0.1:${mock.port}` });

  await waitFor(() => healthy(port));
  const { status, json } = await post(`http://127.0.0.1:${port}`, '/v1/messages', dshBody);
  assert.equal(status, 200);
  assert.equal(json.content[1].content[0].url, 'https://example.com/x');
  assert.equal(scenario.requests[0].auth, 'Bearer tvly-from-store');

  // 轮换：凭据库里的值变了，下一次请求就用新值
  credentials.values.set('TAVILY_API_KEY', 'tvly-rotated');
  await post(`http://127.0.0.1:${port}`, '/v1/messages', dshBody);
  assert.equal(scenario.requests[1].auth, 'Bearer tvly-rotated');

  await ctx.dispose();
  assert.equal(await healthy(port), false, '卸载后端口应释放');
});

test('凭据库里没有 key：请求返回 401，提示去插件页填写', async (t) => {
  const port = await freePort();
  const ctx = fakeContext({ credentials: fakeCredentials() });
  apply(ctx, { port });
  t.after(() => ctx.dispose());

  await waitFor(() => healthy(port));
  const { status, json } = await post(`http://127.0.0.1:${port}`, '/v1/messages', dshBody);
  assert.equal(status, 401);
  assert.match(json.error.message, /插件」页的 Tavily 联网搜索卡片/);
});

test('凭据服务缺席时退回环境变量', async () => {
  const resolve = createKeyResolver({ get: () => undefined }, 'TAVILY_API_KEY', { TAVILY_API_KEY: ' tvly-env ' });
  assert.equal(await resolve(), 'tvly-env');
  const none = createKeyResolver({ get: () => undefined }, 'TAVILY_API_KEY', {});
  assert.equal(await none(), undefined);
});

test('enabled:false 时不监听', async () => {
  const port = await freePort();
  const ctx = fakeContext();
  apply(ctx, { enabled: false, port });
  assert.equal(ctx.disposers.length, 0);
  assert.equal(await healthy(port), false);
});

test('端口上已有同类适配服务 → external；被别的程序占着 → conflict', async (t) => {
  const logger = memoryLogger();

  // 同类：/health 返回同样的服务标识
  const shimLike = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'tavily-anthropic-search', provider: 'tavily' }));
  });
  await new Promise((resolve) => shimLike.listen(0, '127.0.0.1', resolve));
  t.after(() => shimLike.close());
  const external = new ShimRuntime({
    host: '127.0.0.1',
    port: shimLike.address().port,
    endpoint: 'x',
    shim: {},
    resolveApiKey: async () => 'k',
    logger,
    label: 'test',
  });
  assert.equal((await external.start()).state, 'external');

  // 异类：随便一个不认识的 HTTP 服务
  const other = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => other.close());
  const conflict = new ShimRuntime({
    host: '127.0.0.1',
    port: other.address().port,
    endpoint: 'x',
    shim: {},
    resolveApiKey: async () => 'k',
    logger,
    label: 'test',
  });
  const status = await conflict.start();
  assert.equal(status.state, 'conflict');
  assert.match(status.reason, /已被其它程序占用/);
});

test('importLegacyKey：只在未配置且可写时写入', async () => {
  const empty = fakeCredentials();
  assert.equal(await importLegacyKey(empty, { ref: 'TAVILY_API_KEY', value: 'tvly-file' }), 'imported');
  assert.equal(empty.values.get('TAVILY_API_KEY'), 'tvly-file');

  const configured = fakeCredentials({ TAVILY_API_KEY: 'tvly-kept' });
  assert.equal(await importLegacyKey(configured, { ref: 'TAVILY_API_KEY', value: 'tvly-file' }), 'configured');
  assert.equal(configured.values.get('TAVILY_API_KEY'), 'tvly-kept');

  const readOnly = fakeCredentials({}, { writable: false });
  assert.equal(await importLegacyKey(readOnly, { ref: 'TAVILY_API_KEY', value: 'tvly-file' }), 'read-only');
  assert.equal(readOnly.values.size, 0);

  assert.equal(await importLegacyKey(empty, { ref: 'TAVILY_API_KEY', value: '' }), 'absent');
  assert.equal(await importLegacyKey(undefined, { ref: 'TAVILY_API_KEY', value: 'v' }), 'unavailable');
});

test('apply 配了 importEnvFile：从 .env 导入到凭据库', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tavily-import-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'TAVILY_API_KEY=tvly-legacy\n', 'utf8');

  const port = await freePort();
  const credentials = fakeCredentials();
  const ctx = fakeContext({ credentials });
  apply(ctx, { port, importEnvFile: file });
  t.after(() => ctx.dispose());

  await waitFor(() => credentials.values.get('TAVILY_API_KEY'));
  assert.equal(credentials.values.get('TAVILY_API_KEY'), 'tvly-legacy');
  assert.ok(ctx.logger.lines.some((line) => line.text.includes('导入 DSH 凭据库')));
});
