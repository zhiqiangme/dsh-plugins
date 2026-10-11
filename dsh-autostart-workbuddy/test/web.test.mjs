/**
 * Web 面板宿主半侧测试：GET 的取数与回显、POST 的「写白名单 + 立即重新同步」，
 * 以及路由边界（来源、方法、请求体）。
 *
 * 路由要宿主 webserver 才存在，所以这里用只收集 handler 的假 webServer 直接调用；
 * 写配置走宿主 configEditor，用 fixtures/fake-config-editor.mjs 替身。
 * 覆盖的是本插件自己的判定逻辑，不测 DSH 的 webserver / configEditor 实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../lib/config.js';
import {
  BACKEND_PATH,
  MODELS_PATH,
  VERSION_PATH,
  applySelection,
  describeModels,
  loopbackOrigin,
  registerPanelRoutes,
} from '../lib/web.js';
import { createFakeConfigEditor, profileRows } from '../fixtures/fake-config-editor.mjs';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));
const PLUGIN_ID = 'dsh-autostart-workbuddy';

/** 起一个假后端；端口由子进程打印，避免抢占竞态。 */
function startFixture(env = {}) {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, TEST_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('fixture 启动超时')), 10_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /listening (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fixture 提前退出 code=${code}`));
    });
  });
  return { child, ready, stop: () => child.kill() };
}

/** 一个确定没人监听的端口：先占住再放开。 */
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

/** 用插件真实的配置解析拼出 spec + models，避免测试里手搓配置结构。 */
function configFor(port, models = {}) {
  return resolvePluginConfig(
    { port, models: { enabled: true, only: ['cn:alpha'], apiKey: 'test-key', timeoutMs: 5_000, ...models } },
    { PATH: '' },
  );
}

/** 与 configFor 对应的宿主侧 profile：本插件那一行的 config 与插件手里那份一致。 */
function editorFor(models = { enabled: true, only: ['cn:alpha'] }) {
  return createFakeConfigEditor(profileRows({ models }));
}

function fakeRes() {
  return {
    status: undefined,
    body: undefined,
    writeHead(status) {
      this.status = status;
    },
    end(payload) {
      this.body = payload === undefined ? undefined : JSON.parse(payload);
    },
  };
}

function fakeReq(method, { origin, body, url } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    url,
    headers: origin === undefined ? {} : { origin },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeCtx(services = {}) {
  const routes = [];
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return {
    routes,
    lines,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    webServer: {
      register(spec) {
        routes.push(spec);
        return () => {};
      },
    },
    get(name) {
      return services[name];
    },
    effect(factory) {
      return factory();
    },
  };
}

test('GET：返回后端全量模型，并按当前白名单标记勾选状态', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const resolved = configFor(port);
  const editor = editorFor();
  try {
    const payload = await describeModels({ spec: resolved.spec, models: resolved.models, editor, env: process.env });

    assert.equal(payload.ok, true);
    assert.equal(payload.provider, 'workbuddy');
    assert.equal(payload.enabled, true);
    assert.deepEqual(payload.only, ['cn:alpha']);
    assert.equal(payload.patchPath, editor.documentPath);
    assert.equal(payload.models.length, 2);

    const alpha = payload.models.find((row) => row.id === 'cn:alpha');
    assert.equal(alpha.label, 'CN Alpha 0.11');
    assert.equal(alpha.credits, '0.11');
    assert.equal(alpha.contextWindow, 1000000);
    assert.equal(alpha.vision, true);
    assert.equal(alpha.selected, true);

    const beta = payload.models.find((row) => row.id === 'global:beta');
    assert.equal(beta.label, 'GL Beta Free');
    assert.equal(beta.credits, 'Free');
    assert.equal(beta.vision, false);
    assert.equal(beta.selected, false);
  } finally {
    fixture.stop();
  }
});

test('GET：白名单为空 = 同步全部，所有条目都算已勾选', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const resolved = configFor(port, { only: [] });
  try {
    const payload = await describeModels({ spec: resolved.spec, models: resolved.models, env: process.env });
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.only, []);
    assert.equal(payload.models.every((row) => row.selected), true);
  } finally {
    fixture.stop();
  }
});

test('GET：后端不可达时返回 ok:false 与原因，而不是抛异常', async () => {
  const resolved = configFor(await freePort());
  const editor = editorFor();
  const payload = await describeModels({ spec: resolved.spec, models: resolved.models, editor, env: process.env });
  assert.equal(payload.ok, false);
  assert.match(payload.reason, /请求失败/);
  assert.equal(payload.patchPath, editor.documentPath);
});

test('POST：经 configEditor 写白名单，并立即重新生成 provider 的模型清单', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const resolved = configFor(port);
  const editor = editorFor();
  try {
    const result = await applySelection({ resolved, editor, env: process.env, only: ['global:beta', ' cn:alpha '] });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.sync.state, 'updated');
    assert.equal(result.sync.count, 2);

    // 白名单按勾选顺序写进本插件自己那一行（去掉首尾空白），其它字段不丢。
    assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, { enabled: true, only: ['global:beta', 'cn:alpha'] });
    // 插件手里那份配置立即可见（宿主钩子之外也兜底刷新）。
    assert.deepEqual(resolved.models.only, ['global:beta', 'cn:alpha']);
    // provider 的模型清单被同一动作重写成后端真实模型（含倍率展示名），顺序跟白名单走。
    assert.deepEqual(
      editor.entry('llm-pi-ai').options.config.providers.workbuddy.models.map((model) => model.name),
      ['GL Beta Free', 'CN Alpha 0.11'],
    );
    assert.deepEqual(editor.edits.map((edit) => edit.id), [PLUGIN_ID, 'llm-pi-ai']);
  } finally {
    fixture.stop();
  }
});

test('POST：白名单没变时不编辑本插件那一行，但清单仍会重算', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const resolved = configFor(port);
  const editor = editorFor();
  try {
    const result = await applySelection({ resolved, editor, env: process.env, only: ['cn:alpha'] });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    // 白名单本来就有 cn:alpha，但 provider 清单里还是过期条目 → 这一步要把它修正
    assert.equal(result.sync.state, 'updated');
    assert.deepEqual(editor.edits.map((edit) => edit.id), ['llm-pi-ai']);
  } finally {
    fixture.stop();
  }
});

test('POST：参数非法 / 没有 configEditor / 编辑被拒时都如实报错，且不动配置', async () => {
  const resolved = configFor(await freePort());
  const editor = editorFor();

  const badOnly = await applySelection({ resolved, editor, only: 'cn:alpha' });
  assert.equal(badOnly.ok, false);
  assert.match(badOnly.reason, /only/);

  const noEditor = await applySelection({ resolved, editor: undefined, only: ['cn:alpha'] });
  assert.equal(noEditor.ok, false);
  assert.match(noEditor.reason, /configEditor/);

  editor.failWith = new Error('Configuration entry is no longer available');
  const rejected = await applySelection({ resolved, editor, only: ['global:beta'] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /no longer available/);
  assert.equal(editor.edits.length, 0);
  assert.deepEqual(resolved.models.only, ['cn:alpha'], '写入失败时插件手里的白名单不能先变');
});

test('路由：来源、方法与请求体边界', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const resolved = configFor(port);
  const ctx = fakeCtx({ configEditor: editorFor() });
  try {
    registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env, checkVersion: async () => ({ ok: true }) });
    assert.equal(ctx.routes.length, 3);
    const modelsRoute = ctx.routes.find((route) => route.path === MODELS_PATH);
    const backendRoute = ctx.routes.find((route) => route.path === BACKEND_PATH);
    assert.ok(modelsRoute, '应注册模型路由');
    assert.ok(backendRoute, '应注册后端版本路由');
    assert.equal(modelsRoute.kind, 'exact');
    const handler = modelsRoute.handler;

    // 外部来源直接拒绝
    const foreign = fakeRes();
    await handler(fakeReq('GET', { origin: 'http://evil.example' }), foreign);
    assert.equal(foreign.status, 403);

    // 不支持的方法
    const wrongMethod = fakeRes();
    await handler(fakeReq('DELETE'), wrongMethod);
    assert.equal(wrongMethod.status, 405);

    // 请求体不是 JSON
    const badBody = fakeRes();
    await handler(fakeReq('POST', { body: 'not json' }), badBody);
    assert.equal(badBody.status, 400);
    assert.match(badBody.body.reason, /JSON/);

    // 缺 only
    const noOnly = fakeRes();
    await handler(fakeReq('POST', { body: '{}' }), noOnly);
    assert.equal(noOnly.status, 400);

    // 正常 GET
    const okGet = fakeRes();
    await handler(fakeReq('GET', { origin: 'http://127.0.0.1:19387' }), okGet);
    assert.equal(okGet.status, 200);
    assert.equal(okGet.body.ok, true);
    assert.equal(okGet.body.models.length, 2);

    // 正常 POST
    const okPost = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ only: ['cn:alpha'] }) }), okPost);
    assert.equal(okPost.status, 200);
    assert.equal(okPost.body.ok, true);
  } finally {
    fixture.stop();
  }
});

test('路由：宿主没有 webServer 时只记 warn，不抛也不影响插件其它部分', () => {
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    effect() {
      throw new Error('不该注册任何 effect');
    },
  };
  assert.doesNotThrow(() => registerPanelRoutes(ctx, { logger: ctx.logger, resolved: {} }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /webServer/);
});

test('路由：用 ctx.inject 等 webServer 就绪，而不是在 apply 时直接读属性', () => {
  const mounted = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(factory) {
      return factory();
    },
    inject(deps, callback) {
      mounted.push({ deps, callback });
    },
  };

  registerPanelRoutes(ctx, { logger: ctx.logger, resolved: { spec: {}, models: {} } });
  assert.equal(mounted.length, 1);
  assert.deepEqual(mounted[0].deps, ['webServer']);

  // 服务就绪前不该挂任何路由；回调触发后才注册
  const routes = [];
  mounted[0].callback({
    webServer: {
      register(spec) {
        routes.push(spec);
        return () => {};
      },
    },
  });
  assert.equal(routes.length, 3);
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [BACKEND_PATH, MODELS_PATH, VERSION_PATH].sort(),
  );
  for (const route of routes) assert.equal(route.kind, 'exact');
});

test('后端路由：GET 给版本快照且默认不联网，POST 校验动作，其它方法 405', async () => {
  const resolved = configFor(await freePort());
  const ctx = fakeCtx();
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env });
  const handler = ctx.routes.find((route) => route.path === BACKEND_PATH).handler;

  const status = fakeRes();
  await handler(fakeReq('GET'), status);
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true);
  assert.ok(status.body.backend, '应带 backend 快照');
  assert.equal(status.body.check, null, '首屏那次 GET 不应联网');

  const foreign = fakeRes();
  await handler(fakeReq('GET', { origin: 'http://evil.example' }), foreign);
  assert.equal(foreign.status, 403);

  const wrongMethod = fakeRes();
  await handler(fakeReq('PUT'), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const unknownAction = fakeRes();
  await handler(fakeReq('POST', { body: JSON.stringify({ action: 'nope' }) }), unknownAction);
  assert.equal(unknownAction.status, 400);
  assert.match(unknownAction.body.reason, /不认识的动作/);
});

test('插件版本路由：GET 交给版本检查器，只有 ?force=1 绕过缓存；其它方法 405、外部来源 403', async () => {
  const ctx = fakeCtx();
  const calls = [];
  registerPanelRoutes(ctx, {
    logger: ctx.logger,
    resolved: {},
    env: process.env,
    checkVersion: async (options) => {
      calls.push(options);
      return { ok: true, currentVersion: '26.10.11', latestVersion: '26.10.12', updateAvailable: true };
    },
  });
  const handler = ctx.routes.find((route) => route.path === VERSION_PATH).handler;
  assert.equal(VERSION_PATH, '/plugins/dsh-autostart-workbuddy/version');

  const cached = fakeRes();
  await handler(fakeReq('GET', { url: VERSION_PATH }), cached);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.updateAvailable, true);
  await handler(fakeReq('GET', { url: `${VERSION_PATH}?force=1` }), fakeRes());
  assert.deepEqual(calls, [{ force: false }, { force: true }]);

  const wrongMethod = fakeRes();
  await handler(fakeReq('POST'), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const foreign = fakeRes();
  await handler(fakeReq('GET', { origin: 'http://evil.example' }), foreign);
  assert.equal(foreign.status, 403);
});

test('loopbackOrigin：无 Origin 放行，loopback 放行，其它拒绝', () => {
  assert.equal(loopbackOrigin({ headers: {} }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://127.0.0.1:19387' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://localhost:5173' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://[::1]:19387' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'https://evil.example' } }), false);
  assert.equal(loopbackOrigin({ headers: { origin: 'null' } }), false);
});
