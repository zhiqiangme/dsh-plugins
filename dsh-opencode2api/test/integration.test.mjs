/**
 * 集成测试：按 Cordis 的契约调用插件入口（apply + ctx.effect），验证
 *   1) apply 立即返回，不阻塞插件树加载；
 *   2) 已在监听的服务被识别为 already-running 而不是重复拉起；
 *   3) disposer 只停止本插件自己拉起的进程。
 *
 * ctx 用一个最小替身：effect（注册清理函数）、logger、get（软取宿主服务），以及
 * on('internal/update') + update(config)——按 cordis 的瀑布语义把配置变更交给插件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, inject, name } from '../lib/index.js';
import { MODELS_PATH } from '../lib/web.js';
import { createFakeConfigEditor, profileRows } from '../fixtures/fake-config-editor.mjs';

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
  const updateHooks = [];
  services.credentials ??= {resolve: async()=> ({ value: 'test-key', source: 'file' }), set: async()=>{}, describe:async()=>({writable:true})};
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return {
    lines,
    disposers,
    /** update() 走到默认处理（即 cordis 会重启插件）的次数。 */
    restarts: 0,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    get(key) {
      return services[key];
    },
    on(event, listener) {
      if (event === 'internal/update') updateHooks.push(listener);
    },
    /** 模拟 fiber.update：依次调钩子，钩子都调了 next 才落到默认的"重启"。 */
    update(config) {
      const queue = [...updateHooks];
      const next = () => {
        const hook = queue.shift();
        if (hook) return hook(config, true, next);
        this.restarts += 1;
        return undefined;
      };
      return next();
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

/** 托管一个假服务，端口随机，避免碰到真实的 8080。 */
function fakeServiceConfig(port, extra = {}) {
  return {
    logDir: mkdtempSync(join(tmpdir(), 'autostart-wb-int-')),
    readinessTimeoutMs: 10_000,
    port,
    exe: process.execPath,
    cwd: process.cwd(),
    args: [DUMMY],
    backend: { checkOnStart: false },
    ...extra,
  };
}

/**
 * 让假服务监听哪个端口由它自己的环境变量决定，所以这里给假服务一条独立的 env。
 *
 * 必须显式传 env 而不是改写 process.env：node --test 的用例之间会并发跑，
 * 改全局 process.env 会串到别的用例上。
 */
function dummyEnv(port, mode = 'http-health') {
  return { ...process.env, TEST_PORT: String(port), TEST_MODE: mode };
}

test('插件导出 Cordis 契约：name / inject / apply', () => {
  assert.equal(name, 'dsh-opencode2api');
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
  const occupied = createHttpServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'v1',ready:true,models:{},keys:{},proxies:{}}));});
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

test('开启模型同步后：apply 会在后端就绪后经 configEditor 写进 llm-pi-ai', async (t) => {
  const port = await freePort();
  const editor = createFakeConfigEditor(profileRows());
  const ctx = fakeContext({ configEditor: editor });
  t.after(() => ctx.disposeAll());

  const began = Date.now();
  apply(
    ctx,
    fakeServiceConfig(port, {
      // 假后端同时提供 /v1/models，才能把"拉起服务 → 拉模型 → 写配置"整条链路跑通。
      env: dummyEnv(port, 'http-models'),
      models: { enabled: true, apiKey: 'test-key', timeoutMs: 5_000 },
    }),
  );
  const elapsed = Date.now() - began;
  // 模型同步是后台动作，不能拖住插件树加载。
  assert.ok(elapsed < 200, `apply 应立刻返回，实际耗时 ${elapsed}ms`);

  assert.ok(await waitForLog(ctx, '模型列表已同步'), ctx.lines.join('\n'));
  const opencode2api = editor.entry('llm-pi-ai').options.config.providers.opencode2api;
  assert.deepEqual(opencode2api.models.map((model) => model.name), ['Alpha', 'Beta']);
  assert.deepEqual(Object.keys(opencode2api.models[0].reasoningEfforts), ['low', 'high', 'max'], '默认给低/高/最大三档');
  assert.equal(opencode2api.apiKeyEnv, 'OPENCODE2API_PROXY_KEY', 'provider 的其它字段不能被动');
  assert.deepEqual(editor.edits.map((edit) => edit.id), ['llm-pi-ai'], '只编辑 llm-pi-ai 那一行');
});

test('宿主没有 configEditor 时：只跳过模型同步并记日志，后端照常拉起', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  t.after(() => ctx.disposeAll());

  apply(
    ctx,
    fakeServiceConfig(port, {
      env: dummyEnv(port, 'http-models'),
      models: { enabled: true, apiKey: 'test-key', timeoutMs: 5_000 },
    }),
  );
  assert.ok(await waitForLog(ctx, '已启动'), ctx.lines.join('\n'));
  assert.ok(await waitForLog(ctx, '模型列表未同步'), ctx.lines.join('\n'));
  assert.ok(ctx.lines.some((line) => line.includes('configEditor')), ctx.lines.join('\n'));
});

test('模型同步未开启时：不编辑任何配置', async (t) => {
  const port = await freePort();
  const editor = createFakeConfigEditor(profileRows());
  const ctx = fakeContext({ configEditor: editor });
  t.after(() => ctx.disposeAll());

  apply(ctx, fakeServiceConfig(port, { env: dummyEnv(port, 'http-models') }));
  assert.ok(await waitForLog(ctx, '已启动'), ctx.lines.join('\n'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(editor.edits.length, 0);
});

test('面板首次开启同步：不重启托管后端，保存后立即补建模型清单', async (t) => {
  const port = await freePort();
  const models = { only: ['cn:alpha'], apiKey: 'test-key', timeoutMs: 5_000 };
  const config = fakeServiceConfig(port, { env: dummyEnv(port, 'http-models'), models, backend: { checkOnStart: false } });
  const editor = createFakeConfigEditor(profileRows({ models, withProvider: false }));
  editor.entry(name).options.config = structuredClone(config);
  const routes = [];
  const ctx = fakeContext({ configEditor: editor });
  ctx.webServer = { register: (route) => { routes.push(route); return () => {}; } };
  editor.onUpdate(name, (next) => ctx.update(next));
  t.after(() => ctx.disposeAll());

  apply(ctx, config);
  assert.ok(await waitForLog(ctx, '已启动'), ctx.lines.join('\n'));
  assert.equal(editor.edits.length, 0);

  let status;
  let result;
  await routes.find((route) => route.path === MODELS_PATH).handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ only: ['cn:alpha'], enabled: true }));
    },
  }, {
    writeHead(code) { status = code; },
    end(body) { result = JSON.parse(body); },
  });

  assert.equal(status, 200);
  assert.equal(result.sync.state, 'updated');
  assert.equal(result.sync.created, true);
  assert.equal(ctx.restarts, 0, '开启同步不能重启插件或停止托管后端');
  assert.equal(editor.entry(name).options.config.models.enabled, true);
  assert.deepEqual(editor.entry('llm-pi-ai').options.config.providers.opencode2api.models.map((model) => model.id), ['cn:alpha']);
  assert.deepEqual(editor.edits.map((edit) => edit.id), [name, 'llm-pi-ai']);
});

test('配置变更：只改 models.* 时就地生效、不重启插件；改了别的字段才重启', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  t.after(() => ctx.disposeAll());

  const config = fakeServiceConfig(port, {
    env: dummyEnv(port),
    models: { enabled: false, only: ['cn:alpha'] },
  });
  apply(ctx, config);
  assert.ok(await waitForLog(ctx, '已启动'), ctx.lines.join('\n'));

  // 面板保存白名单就是这种变更：不能重启（重启会把托管的后端停掉再拉起）。
  ctx.update({ ...config, models: { enabled: false, only: ['global:beta'] } });
  assert.equal(ctx.restarts, 0);
  assert.ok(ctx.lines.some((line) => line.includes('就地生效')), ctx.lines.join('\n'));

  // 端口等服务规格变了，必须按 cordis 的默认处理重启，新规格才会生效。
  ctx.update({ ...config, port: port + 1 });
  assert.equal(ctx.restarts, 1);
  assert.ok(ctx.lines.some((line) => line.includes('spec.port')), '重启时应记下是哪个字段变了');
});

test('配置变更：apply 之后宿主 process.env 有变动，保存白名单仍然不重启插件', async (t) => {
  const port = await freePort();
  const ctx = fakeContext();
  const marker = `DSH_WB_TEST_ENV_DRIFT_${process.pid}`;
  t.after(() => {
    delete process.env[marker];
    return ctx.disposeAll();
  });

  // 不传 config.env：spec.env 就是宿主 process.env 的快照，与真实 profile 的形状一致。
  // 假服务换成"已被占用的端口"，只为让 apply 走完整流程而不必真起一个依赖 env 的子进程。
  const occupied = createHttpServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'v1',ready:true,models:{},keys:{},proxies:{}}));});
  await new Promise((done) => occupied.listen(port, '127.0.0.1', done));
  t.after(() => new Promise((done) => occupied.close(done)));

  const config = { ...fakeServiceConfig(port), models: { enabled: false, only: ['cn:alpha'] } };
  apply(ctx, config);
  assert.ok(await waitForLog(ctx, '已在'), ctx.lines.join('\n'));

  // DSH 运行中别的插件改了环境变量：此前会让钩子误判"配置变了"而重启，opencode2api 随之被停掉。
  process.env[marker] = '1';
  ctx.update({ ...config, models: { enabled: false, only: ['cn:alpha', 'global:beta'] } });
  assert.equal(ctx.restarts, 0, ctx.lines.join('\n'));
  assert.ok(ctx.lines.some((line) => line.includes('就地生效')), ctx.lines.join('\n'));
});

test('插件重启后过期的 update 钩子不能吞掉切回原配置的请求',async()=>{
  const ctx=fakeContext();
  const original=fakeServiceConfig(1,{exe:join(tmpdir(),'dsh-missing-first.exe')});
  apply(ctx,original);await ctx.disposeAll();
  apply(ctx,{...original,port:2});
  ctx.update(original);
  assert.equal(ctx.restarts,1,'已释放实例的钩子必须放行，新实例才能处理切回原配置');
  await ctx.disposeAll();
});
