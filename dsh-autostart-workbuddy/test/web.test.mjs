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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../lib/config.js';
import { withBackendLock } from '../lib/gateway.js';
import { createModelResync } from '../lib/resync.js';
import {
  BACKEND_NO_ACCOUNTS,
  BACKEND_NOT_INSTALLED,
  BACKEND_PATH,
  MODELS_PATH,
  PANEL_KEY_PATH,
  VERSION_PATH,
  applySelection,
  describeModels,
  requestRejection,
  registerPanelRoutes,
} from '../lib/web.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

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
    { gateway: 'wb2api', port, models: { enabled: true, only: ['cn:alpha'], apiKey: 'test-key', timeoutMs: 5_000, ...models } },
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

/** POST 默认带 JSON 头，与卡片的真实请求一致；对端默认是回环地址。 */
function fakeReq(method, { origin, body, url, contentType = method === 'POST' ? 'application/json' : undefined, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    url,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:19387', ...(origin === undefined ? {} : { origin }), ...(contentType ? { 'content-type': contentType } : {}) },
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

for (const enabled of [true, false]) {
  test(`POST refresh：上游恢复后立即对齐 DSH，保留白名单；同步开关=${enabled}`, async (t) => {
    const alpha = { id: 'cn:alpha', name: 'Alpha' };
    const beta = { id: 'global:beta', name: 'Beta' };
    let upstream = [alpha, beta];
    const server = createHttpServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: upstream }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const only = [alpha.id, beta.id];
    const resolved = configFor(server.address().port, { only });
    const editor = editorFor({ enabled: true, only });
    const credentials = createFakeCredentials();
    const ctx = fakeCtx({ configEditor: editor, credentials });
    const resync = createModelResync({
      resolved, logger: ctx.logger, env: {}, probe: async () => ({ ok: true, servable: true }),
      editor: () => editor, credentials: () => credentials,
    });
    registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: {}, resync });
    const handler = ctx.routes.find((route) => route.path === MODELS_PATH).handler;
    const ids = () => editor.entry('llm-pi-ai').options.config.providers.workbuddy.models.map((model) => model.id);

    await resync.tick();
    await resync.tick();
    upstream = [beta];
    await resync.tick();
    await resync.tick();
    assert.deepEqual(ids(), [beta.id]);
    const edits = editor.edits.length;
    const keyWrites = credentials.sets.length;

    resolved.models.enabled = enabled;
    upstream = [alpha, beta];
    const response = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ action: 'refresh' }) }), response);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.models.map((model) => model.id), only, '插件页看见恢复的 CN');
    assert.equal(response.body.sync.state, enabled ? 'updated' : 'disabled');
    assert.deepEqual(ids(), enabled ? only : [beta.id]);
    assert.equal(editor.edits.length, edits + Number(enabled));
    assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models.only, only);
    assert.equal(credentials.sets.length, keyWrites, '刷新不重复写网关密钥');
    assert.ok(editor.edits.every((edit) => edit.id === 'llm-pi-ai'), '刷新不写插件选择');

    const unchanged = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ action: 'refresh' }) }), unchanged);
    assert.equal(unchanged.body.sync.state, enabled ? 'unchanged' : 'disabled');
    assert.equal(editor.edits.length, edits + Number(enabled), '清单未变不重复写入');
  });
}

test('切换后自动刷新再保存：立即恢复地址和凭据，不改白名单和规则；再次切换后拒绝旧请求', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const only = ['cn:alpha', 'global:beta'];
  const models = { enabled: true, only, rules: { sort: 'name' } };
  const resolved = configFor(port, models);
  const editor = editorFor(models);
  editor.entry('llm-pi-ai').options.config.providers.workbuddy.baseURL = 'http://127.0.0.1:60727/plugins/dsh-autostart-workbuddy/hub/v1/';
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'hub-key' } });
  const ctx = fakeCtx({ configEditor: editor, credentials });
  const resync = createModelResync({ resolved, logger: ctx.logger, env: {}, probe: async () => ({ ok: true, servable: true }), editor: () => editor, credentials: () => credentials });
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: {}, resync });
  const handler = ctx.routes.find((route) => route.path === MODELS_PATH).handler;
  const post = async (body) => { const res = fakeRes(); await handler(fakeReq('POST', { body: JSON.stringify(body) }), res); return res; };
  const refresh = await post({ action: 'refresh', gateway: 'wb2api' });
  assert.equal(refresh.body.sync.state, 'deferred', '定时刷新保留两轮移除保护');
  const saved = await post({ gateway: 'wb2api', enabled: true });
  assert.equal(saved.body.sync.state, 'updated', saved.body.sync.reason);
  const provider = editor.entry('llm-pi-ai').options.config.providers.workbuddy;
  assert.equal(provider.baseURL, `http://127.0.0.1:${port}/v1/`);
  assert.equal(provider.apiKeyEnv, 'WORKBUDDY_WB2API_KEY');
  assert.equal(credentials.values[provider.apiKeyEnv], 'test-key');
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'hub-key');
  assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, models);
  assert.deepEqual(provider.models.map((model) => model.id), only);

  const writes = editor.edits.length, keyWrites = credentials.sets.length;
  for (const body of [{ action: 'refresh', gateway: 'hub' }, { gateway: 'hub', enabled: true }]) {
    const rejected = await post(body);
    assert.equal(rejected.status, 409);
  }
  assert.equal(editor.edits.length, writes);
  assert.equal(credentials.sets.length, keyWrites);
});

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
    assert.equal(alpha.label, 'Alpha CN 0.11');
    assert.equal(alpha.credits, '0.11');
    assert.equal(alpha.contextWindow, 1000000);
    assert.equal(alpha.vision, true);
    assert.equal(alpha.selected, true);

    const beta = payload.models.find((row) => row.id === 'global:beta');
    assert.equal(beta.label, 'Beta GL Free');
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

test('GET：后端没装且拉不到模型时给出"去点安装"状态；端口上有别的后端能答时照常显示', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-web-'));
  const env = { PATH: '', DSH_WORKBUDDY_BACKEND_ROOT: root };
  const missing = resolvePluginConfig({ gateway: 'wb2api', port: await freePort(), models: { enabled: true, apiKey: 'k', timeoutMs: 5_000 } }, env);
  assert.equal(missing.managedExe, true);
  const payload = await describeModels({ ...missing, editor: editorFor(), env });
  assert.equal(payload.ok, false);
  assert.equal(payload.state, BACKEND_NOT_INSTALLED);
  assert.match(payload.reason, /安装/);

  // 自配 exe（外部后端）时不知道装没装，保留原始错误。
  const external = resolvePluginConfig({ gateway: 'wb2api', exe: join(root, 'nope.exe'), port: await freePort(), models: { apiKey: 'k' } }, env);
  assert.equal((await describeModels({ ...external, env })).state, undefined);

  const fixture = startFixture({ TEST_MODE: 'http-models' });
  try {
    const answering = resolvePluginConfig({ gateway: 'wb2api', port: await fixture.ready, models: { enabled: true, apiKey: 'test-key' } }, env);
    assert.equal((await describeModels({ ...answering, env })).ok, true, 'exe 不在但端口能答时不误报未安装');
  } finally {
    fixture.stop();
  }
});

test('POST：只打开同步开关（省略 only）时沿用已有白名单并立即同步', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const resolved = configFor(await fixture.ready, { enabled: false });
  const editor = editorFor({ enabled: false, only: ['cn:alpha'] });
  try {
    const result = await applySelection({ resolved, editor, env: process.env, enabled: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.only, ['cn:alpha'], '不能把用户之前的勾选清空');
    assert.equal(result.sync.state, 'updated');
    assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, { enabled: true, only: ['cn:alpha'] });
  } finally {
    fixture.stop();
  }
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
      ['Beta GL Free', 'Alpha CN 0.11'],
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

test('POST：首次开启同步，即使白名单没变也会保存开关并补建 provider', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  t.after(() => fixture.stop());
  const port = await fixture.ready;
  for (const previousEnabled of [undefined, false]) {
    const models = { only: ['cn:alpha'], exclude: ['global:beta'], efforts: ['high'] };
    if (previousEnabled !== undefined) models.enabled = previousEnabled;
    const resolved = resolvePluginConfig({ gateway: 'wb2api', port, models: { ...models, apiKey: 'test-key' } }, { PATH: '' });
    const editor = createFakeConfigEditor(profileRows({ models, withWorkbuddy: false }));
    const credentials = createFakeCredentials();

    const result = await applySelection({ resolved, editor, credentials, only: ['cn:alpha'], enabled: true });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.enabled, true);
    assert.equal(result.sync.state, 'updated');
    assert.equal(result.sync.created, true);
    assert.equal(result.sync.credential, 'created', '补建 provider 的同时要把网关密钥补进凭据库');
    assert.equal(credentials.values.WORKBUDDY_WB2API_KEY, 'test-key');
    assert.equal(resolved.models.enabled, true);
    assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, { ...models, enabled: true });
    const provider = editor.entry('llm-pi-ai').options.config.providers.workbuddy;
    assert.deepEqual(provider.models.map((model) => model.id), ['cn:alpha']);
    assert.deepEqual(provider.models[0].reasoningEfforts, { high: 'high' });
    assert.deepEqual(editor.edits.map((edit) => edit.id), [PLUGIN_ID, 'llm-pi-ai']);
  }
});

test('POST：关闭同步会保存开关，保留 provider 原清单且不请求后端', async () => {
  const resolved = configFor(await freePort());
  const editor = editorFor();
  const original = structuredClone(editor.entry('llm-pi-ai').options.config);
  const result = await applySelection({ resolved, editor, only: ['cn:alpha'], enabled: false });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.sync.state, 'disabled');
  assert.equal(resolved.models.enabled, false);
  assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, { enabled: false, only: ['cn:alpha'] });
  assert.deepEqual(editor.entry('llm-pi-ai').options.config, original);
  assert.deepEqual(editor.edits.map((edit) => edit.id), [PLUGIN_ID]);
});

test('POST：旧客户端只发送白名单时，保留关闭或未配置的同步开关', async () => {
  for (const models of [{ enabled: false, only: ['cn:alpha'] }, { only: ['cn:alpha'] }]) {
    const resolved = resolvePluginConfig({ gateway: 'wb2api', models }, { PATH: '' });
    const editor = editorFor(models);
    const result = await applySelection({ resolved, editor, only: ['global:beta'] });

    assert.equal(result.ok, true);
    assert.equal(result.sync.state, 'disabled');
    assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, { ...models, only: ['global:beta'] });
    assert.deepEqual(editor.edits.map((edit) => edit.id), [PLUGIN_ID]);
  }
});

test('POST：开关类型非法或写入失败时，开关与白名单都不能先在内存生效', async () => {
  const models = { enabled: false, only: ['cn:alpha'] };
  const resolved = configFor(await freePort(), models);
  const editor = editorFor(models);
  for (const enabled of ['true', null, 1]) {
    const result = await applySelection({ resolved, editor, only: ['global:beta'], enabled });
    assert.equal(result.ok, false);
    assert.match(result.reason, /enabled/);
    assert.equal(editor.edits.length, 0);
  }

  editor.failWith = new Error('write rejected');
  const result = await applySelection({ resolved, editor, only: ['global:beta'], enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /write rejected/);
  assert.equal(resolved.models.enabled, false);
  assert.deepEqual(resolved.models.only, ['cn:alpha']);
  assert.deepEqual(editor.entry(PLUGIN_ID).options.config.models, models);
  assert.equal(editor.edits.length, 0);
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
    assert.equal(ctx.routes.length, 4);
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

    const badEnabled = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ only: ['cn:alpha'], enabled: 'true' }) }), badEnabled);
    assert.equal(badEnabled.status, 400);
    assert.match(badEnabled.body.reason, /enabled/);

    // 正常 GET
    const okGet = fakeRes();
    await handler(fakeReq('GET', { origin: 'http://127.0.0.1:19387' }), okGet);
    assert.equal(okGet.status, 200);
    assert.equal(okGet.body.ok, true);
    assert.equal(okGet.body.models.length, 2);

    // 正常 POST
    const okPost = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ only: ['cn:alpha'], enabled: false }) }), okPost);
    assert.equal(okPost.status, 200);
    assert.equal(okPost.body.ok, true);
    assert.equal(okPost.body.enabled, false);
    assert.equal(okPost.body.sync.state, 'disabled');
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
  assert.equal(routes.length, 4);
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [BACKEND_PATH, MODELS_PATH, PANEL_KEY_PATH, VERSION_PATH].sort(),
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

  // 清除后端数据必须带 confirm，否则一个误发的请求就能删掉凭证。
  const purge = fakeRes();
  await handler(fakeReq('POST', { body: JSON.stringify({ action: 'purge' }) }), purge);
  assert.equal(purge.status, 400);
  assert.match(purge.body.reason, /二次确认/);
  assert.equal(typeof status.body.backend.rootExists, 'boolean');
  assert.equal(status.body.backend.gateway, 'wb2api');
  assert.deepEqual(status.body.backend.gateways, ['wb2api', 'hub']);
  assert.match(status.body.backend.panelUrl, /\/panel$/);
});

test('后端路由（hub）：快照来自 hub 的目录，面板地址是 hub 看板根路径；gateway 动作写配置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-web-hub-'));
  const resolved = resolvePluginConfig({ gateway: 'hub', port: await freePort() }, { DSH_WORKBUDDY_BACKEND_ROOT: root, PATH: '' });
  const editor = editorFor();
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY_CN: 'cn-secret', WORKBUDDY_HUB_KEY: 'follow-secret' } });
  const ctx = fakeCtx({ configEditor: editor, credentials });
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env });
  const handler = ctx.routes.find((route) => route.path === BACKEND_PATH).handler;

  const status = fakeRes();
  await handler(fakeReq('GET'), status);
  assert.equal(status.body.backend.gateway, 'hub');
  assert.equal(status.body.backend.exeExists, false, '没装 hub 时显示安装');
  assert.equal(status.body.backend.root, root);
  assert.match(status.body.backend.panelUrl, /:\d+\/$/);
  assert.deepEqual(status.body.backend.hubSettings, { enabled: false, keys: { cn: 'saved', global: 'missing', follow: 'saved' } });
  assert.doesNotMatch(JSON.stringify(status.body), /cn-secret|follow-secret/);
  await credentials.set('WORKBUDDY_PROXY_KEY_GLOBAL', 'gl-secret');
  const reloaded = fakeRes();
  await handler(fakeReq('GET'), reloaded);
  assert.equal(reloaded.body.backend.hubSettings.keys.global, 'saved', '状态每次从凭据库读取，刷新后不丢失');

  const switched = fakeRes();
  await handler(fakeReq('POST', { body: JSON.stringify({ action: 'gateway', gateway: 'wb2api' }) }), switched);
  assert.equal(switched.status, 200);
  assert.equal(switched.body.state, 'switched', JSON.stringify(switched.body));
});

test('后端路由：自动更新开关写 backend.autoUpdate（保留 backend 其它字段），打开时立即查一轮；快照带自动更新状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-web-auto-'));
  const resolved = resolvePluginConfig({ gateway: 'wb2api', port: await freePort() }, { DSH_WORKBUDDY_BACKEND_ROOT: root, PATH: '' });
  const editor = createFakeConfigEditor([{ id: PLUGIN_ID, config: { backend: { keepVersions: 5 } } }]);
  const ctx = fakeCtx({ configEditor: editor });
  let ticks = 0;
  const autoUpdater = { tick: async () => { ticks += 1; return { state: 'skipped' }; } };
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env, autoUpdater });
  const handler = ctx.routes.find((route) => route.path === BACKEND_PATH).handler;

  const status = fakeRes();
  await handler(fakeReq('GET'), status);
  assert.deepEqual(status.body.backend.autoUpdate, {
    enabled: true, available: true, delayHours: 2, pending: null, failed: null, last: null, lastCheck: null,
  });

  const off = fakeRes();
  await handler(fakeReq('POST', { body: JSON.stringify({ action: 'autoUpdate', enabled: false }) }), off);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(editor.entry(PLUGIN_ID).options.config.backend, { keepVersions: 5, autoUpdate: false });
  assert.equal(resolved.backend.autoUpdate, false, '手里的配置同步改掉，不等宿主转发');
  assert.equal(off.body.backend.autoUpdate.enabled, false);
  assert.equal(ticks, 0, '关掉时不查');

  const on = fakeRes();
  await handler(fakeReq('POST', { body: JSON.stringify({ action: 'autoUpdate', enabled: true }) }), on);
  assert.equal(on.body.backend.autoUpdate.enabled, true);
  assert.equal(ticks, 1, '打开时立即查一轮');

  const bad = fakeRes();
  await handler(fakeReq('POST', { body: JSON.stringify({ action: 'autoUpdate', enabled: 'yes' }) }), bad);
  assert.equal(bad.status, 400);
  assert.equal(editor.edits.length, 2, '非法值不写配置');
});

test('后端路由：后台自动下载占着锁时，手动更新 409 并说明原因；切换网关不用等它', async () => {
  const resolved = configFor(await freePort());
  const ctx = fakeCtx({ configEditor: editorFor() });
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env });
  const handler = ctx.routes.find((route) => route.path === BACKEND_PATH).handler;

  let releaseLock;
  const held = withBackendLock('auto-prepare', () => new Promise((done) => { releaseLock = done; }));
  try {
    const update = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ action: 'update' }) }), update);
    assert.equal(update.status, 409);
    assert.match(update.body.reason, /后台正在自动下载/);

    const switched = fakeRes();
    await handler(fakeReq('POST', { body: JSON.stringify({ action: 'gateway', gateway: 'hub' }) }), switched);
    assert.equal(switched.body.state, 'switched', JSON.stringify(switched.body));
  } finally {
    releaseLock();
    await held;
  }
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

test('控制台密钥路由：POST 给出 config.json 的 api_key；GET 405、外部来源 403、找不到配置 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-panel-key-'));
  const panelConfig = join(dir, 'config.json');
  writeFileSync(panelConfig, JSON.stringify({ listen: '127.0.0.1:7863', api_key: ' panel-secret ' }));
  // 网关密钥（apiKey）与控制台密钥不同：路由必须给 config.json 里那个，控制台校验的是它。
  const resolved = configFor(await freePort(), { apiKey: 'gateway-key', panelConfig });
  const ctx = fakeCtx();
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env });
  const handler = ctx.routes.find((route) => route.path === PANEL_KEY_PATH).handler;
  assert.equal(PANEL_KEY_PATH, '/plugins/dsh-autostart-workbuddy/panel-key');

  const ok = fakeRes();
  await handler(fakeReq('POST', { origin: 'http://127.0.0.1:19387' }), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.key, 'panel-secret');

  const get = fakeRes();
  await handler(fakeReq('GET'), get);
  assert.equal(get.status, 405, 'GET 的导航/资源引用不带 Origin，不能给密钥');

  const foreign = fakeRes();
  await handler(fakeReq('POST', { origin: 'http://evil.example' }), foreign);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.key, undefined);

  // 没设 api_key：控制台不鉴权，回空字符串
  writeFileSync(panelConfig, JSON.stringify({ listen: '127.0.0.1:7863' }));
  const none = fakeRes();
  await handler(fakeReq('POST'), none);
  assert.equal(none.status, 200);
  assert.equal(none.body.key, '');

  // 后端还没装（配置文件不存在）
  const missingCtx = fakeCtx();
  registerPanelRoutes(missingCtx, {
    logger: missingCtx.logger,
    resolved: configFor(await freePort(), { panelConfig: join(dir, 'nope', 'config.json') }),
    env: process.env,
  });
  const missing = fakeRes();
  await missingCtx.routes.find((route) => route.path === PANEL_KEY_PATH).handler(fakeReq('POST'), missing);
  assert.equal(missing.status, 404);
  assert.match(missing.body.reason, /找不到后端配置文件/);
});

test('requestRejection：有 connection 时以宿主结论为准，否则只放行回环对端的同源请求', () => {
  const local = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: '127.0.0.1:19387', ...headers }, socket: { remoteAddress } });
  assert.equal(requestRejection(local()), undefined);
  assert.equal(requestRejection(local({ origin: 'http://127.0.0.1:19387' })), undefined);
  assert.equal(requestRejection(local({}, '::1')), undefined);
  assert.equal(requestRejection(local({ origin: 'http://localhost:5173' })), 403);
  assert.equal(requestRejection(local({ origin: 'https://evil.example' })), 403);
  assert.equal(requestRejection(local({ origin: 'null' })), 403);
  assert.equal(requestRejection(local({}, '192.168.1.5')), 403);
  assert.equal(requestRejection(local(), { requestRejection: () => 401 }), 401);
  assert.equal(requestRejection(local({}, '10.0.0.2'), { requestRejection: () => undefined }), undefined);
});

test('面板路由：宿主未登录返回 401，text/plain 的 POST 返回 415', async () => {
  const ctx = fakeCtx();
  let verdict = 401;
  ctx.connection = { requestRejection: () => verdict };
  registerPanelRoutes(ctx, { logger: ctx.logger, resolved: configFor(await freePort()), env: process.env });
  const handler = ctx.routes.find((route) => route.path === PANEL_KEY_PATH).handler;
  const denied = fakeRes();
  await handler(fakeReq('POST'), denied);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.key, undefined);
  verdict = undefined;
  const plainText = fakeRes();
  await handler(fakeReq('POST', { body: '{}', contentType: 'text/plain' }), plainText);
  assert.equal(plainText.status, 415);
});

test('GET（hub）：账号池为空时不列模型（hub 的 /v1/models 照样返回内置目录，选了也调不通）', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  try {
    const resolved = resolvePluginConfig({ gateway: 'wb2api', port: await fixture.ready, models: { enabled: true, apiKey: 'test-key' } }, process.env);
    const empty = async () => ({ ok: true, servable: false, healthy: 0, total: 2 });
    const payload = await describeModels({ ...resolved, env: process.env, gateway: 'hub', probe: empty });
    assert.equal(payload.ok, false);
    assert.equal(payload.state, BACKEND_NO_ACCOUNTS);
    assert.equal(payload.accounts, 2);
    assert.equal(payload.models, undefined, '账号池为空时不能带出模型');

    // 有可用账号、探针不通（交给拉取报真实错误）、以及 wb2api（目录本来就靠账号拉）都照常列出。
    const ready = async () => ({ ok: true, servable: true, healthy: 1, total: 1 });
    const down = async () => ({ ok: false, reason: 'down' });
    assert.equal((await describeModels({ ...resolved, env: process.env, gateway: 'hub', probe: ready })).ok, true);
    assert.equal((await describeModels({ ...resolved, env: process.env, gateway: 'hub', probe: down })).ok, true);
    assert.equal((await describeModels({ ...resolved, env: process.env, gateway: 'wb2api', probe: empty })).ok, true);
  } finally {
    fixture.stop();
  }
});

test('GET（hub）：行 id 是带出口前缀的白名单键，老的裸 id 回显成两个出口各一条，勾选按当前出口算', async (t) => {
  const hub = { realm: 'cn', data: [{ id: 'flash', name: 'Flash' }, { id: 'minimax-m3', name: 'MiniMax' }] };
  const server = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: hub.data, realm: hub.realm }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const ready = async () => ({ ok: true, servable: true, healthy: 1, total: 1 });
  const describe = (only) => {
    const resolved = resolvePluginConfig({ gateway: 'wb2api', port: server.address().port, models: { enabled: true, apiKey: 'k', only } }, { PATH: '' });
    return describeModels({ ...resolved, env: {}, gateway: 'hub', probe: ready });
  };

  const legacy = await describe(['flash', 'global:gpt-5.5']);
  assert.equal(legacy.realm, 'cn');
  assert.deepEqual(legacy.models.map((row) => [row.id, row.label, row.selected]), [
    ['cn:flash', 'Flash CN Free', true],
    ['cn:minimax-m3', 'MiniMax CN Free', false],
  ]);
  assert.deepEqual(legacy.only, ['cn:flash', 'global:flash', 'global:gpt-5.5'], '裸 id 拆成两个出口，保存后取消一个出口不连带另一个');

  const neverPicked = await describe(['global:gpt-5.5']);
  assert.deepEqual(neverPicked.models.map((row) => row.selected), [true, true], 'CN 从没勾过：与同步一致，按全部算');
});
