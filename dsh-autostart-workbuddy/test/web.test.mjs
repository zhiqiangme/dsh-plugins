/**
 * Web 面板宿主半侧测试：GET 的取数与回显、POST 的「写白名单 + 立即重新同步」，
 * 以及路由边界（来源、方法、请求体）。
 *
 * 路由要宿主 webserver 才存在，所以这里用只收集 handler 的假 webServer 直接调用——
 * 覆盖的是本插件自己的判定逻辑，不测 DSH 的 webserver 实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../lib/config.js';
import { MODELS_PATH, applySelection, describeModels, loopbackOrigin, registerPanelRoutes } from '../lib/web.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));

const PATCH = `# 测试用 profile patch
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        baseURL: http://127.0.0.1:7863/v1/
        models:
          - id: cn:stale
            name: 过期条目
- id: dsh-autostart-workbuddy
  name: dsh-autostart-workbuddy
  config:
    models:
      enabled: true
      only:
        - cn:alpha
`;

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

function tempPatch(text = PATCH) {
  const dir = mkdtempSync(join(tmpdir(), 'autostart-web-'));
  const path = join(dir, 'cordis.patch.yml');
  writeFileSync(path, text, 'utf8');
  return { dir, path };
}

/** 用插件真实的配置解析拼出 spec + models，避免测试里手搓配置结构。 */
function configFor(port, patchPath, models = {}) {
  return resolvePluginConfig(
    {
      port,
      models: { enabled: true, profilePatch: patchPath, apiKey: 'test-key', timeoutMs: 5_000, ...models },
    },
    { PATH: '' },
  );
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

function fakeReq(method, { origin, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    headers: origin === undefined ? {} : { origin },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeCtx() {
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
    effect(factory) {
      return factory();
    },
  };
}

test('GET：返回后端全量模型，并按当前白名单标记勾选状态', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const { path } = tempPatch();
  const resolved = configFor(port, path);
  try {
    const payload = await describeModels({ spec: resolved.spec, models: resolved.models, env: process.env });

    assert.equal(payload.ok, true);
    assert.equal(payload.provider, 'workbuddy');
    assert.equal(payload.enabled, true);
    assert.deepEqual(payload.only, ['cn:alpha']);
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
  const { path } = tempPatch(PATCH.replace('      only:\n        - cn:alpha\n', '      only: []\n'));
  const resolved = configFor(port, path);
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
  const port = await freePort();
  const { path } = tempPatch();
  const resolved = configFor(port, path);
  const payload = await describeModels({ spec: resolved.spec, models: resolved.models, env: process.env });
  assert.equal(payload.ok, false);
  assert.match(payload.reason, /请求失败/);
  assert.equal(payload.patchPath, path);
});

test('POST：写白名单并立即重新生成 provider 的模型清单（留备份）', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const { dir, path } = tempPatch();
  const resolved = configFor(port, path);
  try {
    const result = await applySelection({
      spec: resolved.spec,
      models: resolved.models,
      env: process.env,
      only: ['global:beta', 'cn:alpha'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.sync.state, 'updated');
    assert.equal(result.sync.count, 2);

    const text = readFileSync(path, 'utf8');
    // 白名单按勾选顺序写入
    assert.match(text, /      only:\n        - global:beta\n        - cn:alpha\n/);
    // provider 的模型清单被同一动作重写成后端真实模型（含倍率展示名）
    assert.match(text, /- id: cn:alpha\n            name: CN Alpha 0.11/);
    assert.match(text, /- id: global:beta\n            name: GL Beta Free/);
    // 过期条目被替换掉，且另一个插件（llm-pi-ai）的段落还在
    assert.equal(text.includes('过期条目'), false);
    assert.ok(text.includes('# 测试用 profile patch'));

    const backups = readdirSync(dir).filter((name) => name.includes('bak-before-model-sync'));
    assert.ok(backups.length >= 1, '应留下带时间戳的备份');
  } finally {
    fixture.stop();
  }
});

test('POST：白名单没变时判为无变化（不重写文件），但清单仍会重算', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const { path } = tempPatch();
  const resolved = configFor(port, path);
  try {
    const result = await applySelection({
      spec: resolved.spec,
      models: resolved.models,
      env: process.env,
      only: ['cn:alpha'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    // 白名单本来就有 cn:alpha，但 provider 清单里还是过期条目 → 这一步要把它修正
    assert.equal(result.sync.state, 'updated');
  } finally {
    fixture.stop();
  }
});

test('POST：only 不是字符串数组时拒绝，且不动文件', async () => {
  const { path } = tempPatch();
  const before = readFileSync(path, 'utf8');
  const resolved = configFor(await freePort(), path);

  const result = await applySelection({ spec: resolved.spec, models: resolved.models, only: 'cn:alpha' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /only/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('路由：来源、方法与请求体边界', async () => {
  const fixture = startFixture({ TEST_MODE: 'http-models' });
  const port = await fixture.ready;
  const { path } = tempPatch();
  const resolved = configFor(port, path);
  const ctx = fakeCtx();
  try {
    registerPanelRoutes(ctx, { logger: ctx.logger, resolved, env: process.env });
    assert.equal(ctx.routes.length, 1);
    assert.equal(ctx.routes[0].path, MODELS_PATH);
    assert.equal(ctx.routes[0].kind, 'exact');
    const handler = ctx.routes[0].handler;

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
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, MODELS_PATH);
  assert.equal(routes[0].kind, 'exact');
});

test('loopbackOrigin：无 Origin 放行，loopback 放行，其它拒绝', () => {
  assert.equal(loopbackOrigin({ headers: {} }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://127.0.0.1:19387' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://localhost:5173' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'http://[::1]:19387' } }), true);
  assert.equal(loopbackOrigin({ headers: { origin: 'https://evil.example' } }), false);
  assert.equal(loopbackOrigin({ headers: { origin: 'null' } }), false);
});
