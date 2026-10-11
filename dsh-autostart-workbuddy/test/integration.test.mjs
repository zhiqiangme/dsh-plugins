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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** 最小 Cordis Context 替身：收集 effect 的 disposer，记录日志；services 供 ctx.get 软取。 */
function fakeContext(services = {}) {
  const disposers = [];
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return {
    lines,
    disposers,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    get(key) {
      return services[key];
    },
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

/** 托管一个假服务，端口随机，避免碰到真实的 7863。 */
function fakeServiceConfig(port, extra = {}) {
  return {
    logDir: mkdtempSync(join(tmpdir(), 'autostart-wb-int-')),
    readinessTimeoutMs: 10_000,
    port,
    exe: process.execPath,
    cwd: process.cwd(),
    args: [DUMMY],
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
  return { ...process.env, TEST_PORT: String(port), TEST_MODE: mode };
}

test('插件导出 Cordis 契约：name / inject / apply', () => {
  assert.equal(name, 'dsh-autostart-workbuddy');
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

/** 轮询等待任意条件（用于"文件被回写"这类异步落盘结果）。 */
async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
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

test('启动失败不抛异常：只记录错误，不影响宿主', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  // 断言失败也必须收尾：否则真起来的那个子进程会让测试运行器永远不退出。
  t.after(() => ctx.disposeAll());
  apply(ctx, fakeServiceConfig(port, { exe: 'Z:\\nope\\missing.exe' }));

  assert.ok(await waitForLog(ctx, '启动失败'), ctx.lines.join('\n'));
});

/** 与真实 profile 同构的最小 patch，用于验证"启动即同步模型列表"这条链路。 */
const PATCH_FIXTURE = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        baseURL: http://127.0.0.1:7863/v1/
        models:
          - id: cn:stale
            name: 过期条目
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
`;

test('开启模型同步后：apply 会在后端就绪后回写 profile 的 models 段', async (t) => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'autostart-wb-sync-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, PATCH_FIXTURE, 'utf8');

  const ctx = fakeContext();
  t.after(() => ctx.disposeAll());

  const began = Date.now();
  apply(
    ctx,
    fakeServiceConfig(port, {
      // 假后端同时提供 /v1/models，才能把"拉起服务 → 拉模型 → 回写配置"整条链路跑通。
      env: dummyEnv(port, 'http-models'),
      models: { enabled: true, profilePatch: patchPath, apiKey: 'test-key', timeoutMs: 5_000 },
    }),
  );
  const elapsed = Date.now() - began;
  // 模型同步是后台动作，不能拖住插件树加载。
  assert.ok(elapsed < 200, `apply 应立刻返回，实际耗时 ${elapsed}ms`);

  assert.ok(
    await waitFor(() => readFileSync(patchPath, 'utf8').includes('name: CN Alpha 0.11')),
    `models 段应被回写：\n${readFileSync(patchPath, 'utf8')}`,
  );

  const after = readFileSync(patchPath, 'utf8');
  assert.ok(after.includes('          - id: cn:alpha'));
  assert.ok(after.includes('          - id: global:beta'));
  assert.ok(after.includes('            name: GL Beta Free'), '国际版模型要带 GL 前缀与 Free 倍率');
  assert.ok(after.includes('            reasoningEfforts:'), '默认给低/高/最大三档');
  assert.ok(after.includes('- id: locale'), '其余配置不能被改动');
  assert.ok(await waitForLog(ctx, '模型列表已同步'), ctx.lines.join('\n'));
});

test('未显式配 profilePatch 时：取宿主 profileContext.patchPath 回写', async (t) => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'autostart-wb-hostprofile-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, PATCH_FIXTURE, 'utf8');

  // 宿主进程的 process.env 里没有 DSH_PROFILE_DIR / DSH_PROFILE，路径只能来自 profileContext。
  const ctx = fakeContext({ profileContext: { name: 'desktop', dir, patchPath } });
  t.after(() => ctx.disposeAll());

  const env = dummyEnv(port, 'http-models');
  delete env.DSH_PROFILE_DIR;
  delete env.DSH_PROFILE;
  apply(
    ctx,
    fakeServiceConfig(port, {
      env,
      models: { enabled: true, apiKey: 'test-key', timeoutMs: 5_000 },
    }),
  );

  assert.ok(
    await waitFor(() => readFileSync(patchPath, 'utf8').includes('name: CN Alpha 0.11')),
    `models 段应被回写：\n${readFileSync(patchPath, 'utf8')}\n${ctx.lines.join('\n')}`,
  );
});

test('模型同步未开启时：不碰 profile 文件', async (t) => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'autostart-wb-nosync-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, PATCH_FIXTURE, 'utf8');

  const ctx = fakeContext();
  t.after(() => ctx.disposeAll());

  apply(ctx, fakeServiceConfig(port, { env: dummyEnv(port, 'http-models') }));
  assert.ok(await waitForLog(ctx, '已启动'), ctx.lines.join('\n'));

  assert.equal(readFileSync(patchPath, 'utf8'), PATCH_FIXTURE);
});
