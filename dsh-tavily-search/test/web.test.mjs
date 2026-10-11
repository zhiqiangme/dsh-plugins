/**
 * 宿主半侧路由测试：状态描述、端到端测试搜索、路由注册与来源校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { resolvePluginConfig } from '../lib/config.js';
import { ShimRuntime } from '../lib/runtime.js';
import {
  describeStatus,
  loopbackOrigin,
  registerPanelRoutes,
  runTestSearch,
  STATUS_PATH,
  TEST_PATH,
  VERSION_PATH,
} from '../lib/web.js';
import { freePort, memoryLogger, okTavily, startMockTavily } from './helpers.mjs';

async function startRuntime(t, { handler, apiKey = 'tvly-test' } = {}) {
  const scenario = { requests: [], handler: handler ?? okTavily([]) };
  const mock = await startMockTavily(scenario);
  const port = await freePort();
  const resolved = resolvePluginConfig({ port, tavilyBaseUrl: `http://127.0.0.1:${mock.port}` });
  const runtime = new ShimRuntime({
    ...resolved,
    resolveApiKey: async () => apiKey,
    missingKeyHint: '去插件页填写。',
    logger: memoryLogger(),
    label: 'test',
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    mock.server.close();
  });
  return { scenario, resolved, runtime };
}

test('describeStatus：端点、凭据引用名与运行状态；禁用时 state=disabled', () => {
  const resolved = resolvePluginConfig({ port: 9999 });
  const fakeRuntime = { status: () => ({ state: 'listening', reason: '' }) };
  const status = describeStatus({ resolved, runtime: fakeRuntime });
  assert.equal(status.endpoint, 'http://127.0.0.1:9999/v1');
  assert.equal(status.apiKeyRef, 'TAVILY_API_KEY');
  assert.equal(status.server.state, 'listening');
  assert.equal(JSON.stringify(status).includes('tvly'), false, '状态里不应出现任何 key');

  assert.equal(describeStatus({ resolved, runtime: undefined }).server.state, 'disabled');
});

test('runTestSearch：按 DSH 的请求形状走通，返回条数与标题', async (t) => {
  const { scenario, resolved } = await startRuntime(t, {
    handler: okTavily([
      { title: '一', url: 'https://example.com/1', content: 'a' },
      { title: '', url: 'https://example.com/2', content: 'b' },
      { title: '三', url: 'https://example.com/3', content: 'c' },
      { title: '四', url: 'https://example.com/4', content: 'd' },
    ]),
  });
  const result = await runTestSearch({ resolved, query: '  hello  ' });
  assert.equal(result.ok, true);
  assert.equal(result.query, 'hello');
  assert.equal(result.count, 4);
  // 标题为空时用 URL 顶上，最多回显 3 条
  assert.deepEqual(result.titles, ['一', 'https://example.com/2', '三']);
  assert.equal(scenario.requests[0].body.query, 'hello');
  assert.ok(result.elapsedMs >= 0);
});

test('runTestSearch：缺 key / Tavily 故障 / 连不上接口都返回 ok:false 与原因', async (t) => {
  const missing = await startRuntime(t, { apiKey: '' });
  const noKey = await runTestSearch({ resolved: missing.resolved });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.query, 'DeepSeek');
  assert.match(noKey.reason, /未配置 Tavily API Key。去插件页填写。/);

  const broken = await startRuntime(t, {
    handler: (_req, res) => {
      res.writeHead(401);
      res.end('bad key');
    },
  });
  const upstream = await runTestSearch({ resolved: broken.resolved });
  assert.equal(upstream.ok, false);
  assert.match(upstream.reason, /HTTP 401/);

  const nobody = resolvePluginConfig({ port: await freePort() });
  const unreachable = await runTestSearch({ resolved: nobody });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.reason, /连不上搜索接口/);
});

test('loopbackOrigin：无 Origin 或本机来源放行，外部来源拒绝', () => {
  assert.equal(loopbackOrigin({ headers: {} }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://127.0.0.1:5173' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://localhost' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'https://evil.example' } }), false);
  assert.equal(loopbackOrigin({ headers: { origin: 'not a url' } }), false);
});

/** 替身 req / res：够路由处理函数用即可。 */
function fakeRequest(method, { origin, body, url } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = origin ? { origin } : {};
  return req;
}

function fakeResponse() {
  const res = {
    status: 0,
    body: undefined,
    writeHead(status) {
      res.status = status;
    },
    end(payload) {
      res.body = JSON.parse(payload);
    },
  };
  return res;
}

test('registerPanelRoutes：注册三条路由，校验来源与方法，卸载时释放', async () => {
  const routes = new Map();
  const released = [];
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => released.push(route.path);
    },
  };
  const disposers = [];
  const ctx = { webServer, effect: (factory) => disposers.push(factory()) };
  const resolved = resolvePluginConfig({});
  const versionCalls = [];
  registerPanelRoutes(ctx, {
    logger: memoryLogger(),
    resolved,
    runtime: { status: () => ({ state: 'listening', reason: '' }) },
    checkVersion: async (options) => {
      versionCalls.push(options);
      return { ok: true, currentVersion: '26.10.11', latestVersion: '26.10.12', updateAvailable: true };
    },
  });

  assert.deepEqual([...routes.keys()].sort(), [STATUS_PATH, TEST_PATH, VERSION_PATH].sort());
  assert.equal(STATUS_PATH, '/plugins/dsh-tavily-search/status');

  const ok = fakeResponse();
  await routes.get(STATUS_PATH).handler(fakeRequest('GET'), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.server.state, 'listening');

  const foreign = fakeResponse();
  await routes.get(STATUS_PATH).handler(fakeRequest('GET', { origin: 'https://evil.example' }), foreign);
  assert.equal(foreign.status, 403);

  const wrongMethod = fakeResponse();
  await routes.get(TEST_PATH).handler(fakeRequest('GET'), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const badBody = fakeResponse();
  await routes.get(TEST_PATH).handler(fakeRequest('POST', { body: '[1]' }), badBody);
  assert.equal(badBody.status, 400);

  const version = fakeResponse();
  await routes.get(VERSION_PATH).handler(fakeRequest('GET', { url: VERSION_PATH }), version);
  assert.equal(version.status, 200);
  assert.equal(version.body.updateAvailable, true);
  const forced = fakeResponse();
  await routes.get(VERSION_PATH).handler(fakeRequest('GET', { url: `${VERSION_PATH}?force=1` }), forced);
  // 只有 ?force=1 才绕过缓存
  assert.deepEqual(versionCalls, [{ force: false }, { force: true }]);

  const versionPost = fakeResponse();
  await routes.get(VERSION_PATH).handler(fakeRequest('POST'), versionPost);
  assert.equal(versionPost.status, 405);

  for (const dispose of disposers) dispose();
  assert.deepEqual(released.sort(), [STATUS_PATH, TEST_PATH, VERSION_PATH].sort());
});

test('registerPanelRoutes：宿主没有 webServer 时只记 warn，不抛', () => {
  const logger = memoryLogger();
  registerPanelRoutes({ effect: () => {} }, { logger, resolved: resolvePluginConfig({}), runtime: undefined });
  assert.ok(logger.lines.some((line) => line.level === 'warn' && line.text.includes('webServer')));
});
