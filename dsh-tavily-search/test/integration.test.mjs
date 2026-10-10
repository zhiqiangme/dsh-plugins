/**
 * 集成测试：按 Cordis 的契约调用插件入口（apply + ctx.effect），验证
 *   1) apply 立即返回，不阻塞插件树加载；
 *   2) 已在监听的服务被识别为 already-running 而不是重复拉起；
 *   3) disposer 只停止本插件自己拉起的进程。
 *
 * ctx 用一个最小替身：只实现 effect（注册清理函数）与 logger。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, inject, name } from '../lib/index.js';

const DUMMY = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** 最小 Cordis Context 替身：收集 effect 的 disposer，记录日志。 */
function fakeContext() {
  const disposers = [];
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return {
    lines,
    disposers,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    async disposeAll() {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

/**
 * 托管一个假服务，端口随机，避免碰到真实的 8787。
 *
 * `envFile` 指向一个不存在的路径：否则会读到工作区里真实的 .env，
 * 让用例依赖本机状态。key 由 `env` 直接给出，足以满足必需变量检查。
 */
function fakeServiceConfig(port, extra = {}) {
  return {
    logDir: mkdtempSync(join(tmpdir(), 'autostart-web-int-')),
    readinessTimeoutMs: 10_000,
    port,
    exe: process.execPath,
    script: DUMMY,
    cwd: process.cwd(),
    envFile: 'Z:\\nope\\.env',
    ...extra,
  };
}

/**
 * 让假服务监听哪个端口由它自己的环境变量决定，所以这里给假服务一条独立的 env。
 *
 * 必须显式传 env 而不是改写 process.env：node --test 的用例之间会并发跑，
 * 改全局 process.env 会串到别的用例上。
 */
function dummyEnv(port, mode = 'listen') {
  return { ...process.env, TEST_PORT: String(port), TEST_MODE: mode, TAVILY_API_KEY: 'test-key' };
}

test('插件导出 Cordis 契约：name / inject / apply', () => {
  assert.equal(name, 'dsh-tavily-search');
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, 'function');
});

/** 轮询等待日志出现某段文本（比直接探测端口稳：端口先就绪、日志后写入）。 */
async function waitForLog(ctx, needle, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.lines.some((l) => l.includes(needle))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('apply 立即返回（后台启动），disposer 能停掉自己拉起的服务', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  // 无论断言是否失败都要收尾，否则残留的子进程会让测试运行器永远无法退出。
  t.after(() => ctx.disposeAll());

  const began = Date.now();
  apply(ctx, fakeServiceConfig(port, { env: dummyEnv(port) }));
  const elapsed = Date.now() - began;
  // apply 里不能 await 端口就绪（最多 30s），否则会拖住整棵插件树。
  assert.ok(elapsed < 200, `apply 应立刻返回，实际耗时 ${elapsed}ms`);
  assert.equal(ctx.disposers.length, 1, '应注册一个生命周期 disposer');

  assert.ok(await waitForLog(ctx, '已启动'), `日志应记录启动：${ctx.lines.join('\n')}`);

  const { probeTcp } = await import('../lib/services.js');
  assert.equal(await probeTcp(port), true, '后台启动应最终让端口就绪');

  await ctx.disposeAll();
  assert.equal(await probeTcp(port), false, 'disposer 应停掉自己拉起的服务');
});

test('服务已在监听时：识别为 already-running，disposer 不会动它', async (t) => {
  const port = await freePort();
  const occupied = createServer();
  await new Promise((done) => occupied.listen(port, '127.0.0.1', done));
  t.after(() => new Promise((done) => occupied.close(done)));

  const ctx = fakeContext();
  apply(ctx, fakeServiceConfig(port, { env: dummyEnv(port) }));

  assert.ok(await waitForLog(ctx, '已在'), `应记录跳过启动：${ctx.lines.join('\n')}`);

  await ctx.disposeAll();
  const { probeTcp } = await import('../lib/services.js');
  assert.equal(await probeTcp(port), true, '外部服务必须仍然存活');
});

test('顶层 enabled:false 时不注册任何启动动作', () => {
  const ctx = fakeContext();
  apply(ctx, { enabled: false });
  assert.ok(ctx.lines.some((l) => l.includes('已禁用')), ctx.lines.join('\n'));
});

test('缺少 TAVILY_API_KEY 时只记录错误（不抛异常、不拉起进程）', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  // 断言失败也必须收尾：否则真起来的那个子进程会让测试运行器永远不退出。
  t.after(() => ctx.disposeAll());

  const config = fakeServiceConfig(port, { env: dummyEnv(port) });
  delete config.env.TAVILY_API_KEY;
  // 宿主环境里也可能已经有这个 key（本机 .env 之外），先确认用例的前提成立。
  const hadKey = Boolean(process.env.TAVILY_API_KEY);
  apply(ctx, config);

  if (hadKey) {
    // 宿主已导出 key 时不该拦：服务会照常尝试启动。
    assert.ok(await waitForLog(ctx, '已启动'), ctx.lines.join('\n'));
  } else {
    assert.ok(await waitForLog(ctx, '启动失败'), ctx.lines.join('\n'));
    assert.ok(
      ctx.lines.some((l) => l.includes('TAVILY_API_KEY')),
      `错误信息应指明缺失的变量：${ctx.lines.join('\n')}`,
    );
  }
});

test('node 缺失导致启动失败时不抛异常：只记录错误，不影响宿主', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  t.after(() => ctx.disposeAll());

  // 本插件的 exe 由 nodePath 决定（server.js 要用 node 跑），所以这里换掉的是 nodePath。
  apply(ctx, fakeServiceConfig(port, { env: dummyEnv(port), nodePath: 'Z:\\nope\\missing.exe' }));

  assert.ok(await waitForLog(ctx, '启动失败'), ctx.lines.join('\n'));
});
