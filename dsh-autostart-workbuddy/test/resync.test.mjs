import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { confirmRemovals, syncModels } from '../lib/models.js';
import { createModelResync, healthTarget } from '../lib/resync.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

const READY = async () => ({ ok: true, servable: true });
const ALPHA = { id: 'cn:alpha', name: 'Alpha', credits: 'x0.11' };
const BETA = { id: 'global:beta', name: 'Beta', credits: 'x0.00' };

function memoryLogger() {
  const lines = [];
  const push = (level) => (line) => lines.push([level, line]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

/** 进程内的 /v1/models：目录可随时替换，记录请求次数。 */
async function serve(t, backend) {
  const server = createServer((_req, res) => {
    backend.hits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: backend.models }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * 已经过一次启动同步的 profile（与真实运行顺序一致：启动同步不带移除确认，之后才轮到定时同步）。
 * credentials 默认是空凭据库：启动同步会补一次 WORKBUDDY_PROXY_KEY。
 */
async function setup(t, { probe = READY, credentials = createFakeCredentials() } = {}) {
  const backend = { models: [ALPHA, BETA], hits: 0 };
  const url = await serve(t, backend);
  const resolved = resolvePluginConfig({ models: { enabled: true, apiKey: 'gw-key', baseURL: url } }, { PATH: '' });
  const editor = createFakeConfigEditor(profileRows());
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'updated');
  backend.hits = 0;
  const logger = memoryLogger();
  const resync = createModelResync({ resolved, logger, env: {}, probe, editor: () => editor, credentials: () => credentials });
  const ids = () => editor.entry('llm-pi-ai').options.config.providers.workbuddy.models.map((model) => model.id);
  return { backend, resolved, editor, credentials, logger, resync, ids };
}

test('双区域定时同步不被看板当前出口的空账号池挡住', async () => {
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, hubDual: true } }, {});
  let calls = 0;
  const resync = createModelResync({ resolved, logger: memoryLogger(), editor: () => undefined, credentials: () => undefined,
    probe: async () => ({ ok: true, servable: false, realm: 'intl' }),
    sync: async ({ models }) => { calls++; assert.equal(models.hubDual, true); return { state: 'unchanged', entries: [], realm: 'dual' }; },
  });
  assert.equal((await resync.tick()).state, 'unchanged');
  assert.equal(calls, 1);
  assert.equal(resync.status.realm, 'dual');
});

test('上游下架的模型连续两轮缺席后从 DSH 移除，之后保持不变', async (t) => {
  const { backend, editor, resync, ids } = await setup(t);
  const edits = editor.edits.length;
  assert.equal((await resync.tick()).state, 'unchanged');

  backend.models = [ALPHA];
  const first = await resync.tick();
  assert.equal(first.state, 'deferred');
  assert.deepEqual(first.missing, ['global:beta']);
  assert.deepEqual(ids(), ['cn:alpha', 'global:beta'], '只缺席一轮不删');
  assert.equal(editor.edits.length, edits);

  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(ids(), ['cn:alpha']);
  assert.equal((await resync.tick()).state, 'unchanged');
});

test('上游抖动：缺席一轮又回来的模型不会被删，确认状态随之清零', async (t) => {
  const { backend, editor, resync, ids } = await setup(t);
  const edits = editor.edits.length;
  backend.models = [ALPHA];
  assert.equal((await resync.tick()).state, 'deferred');
  backend.models = [ALPHA, BETA];
  assert.equal((await resync.tick()).state, 'unchanged');
  backend.models = [ALPHA];
  assert.equal((await resync.tick()).state, 'deferred', '中间恢复过一轮，要重新确认');
  assert.deepEqual(ids(), ['cn:alpha', 'global:beta']);
  assert.equal(editor.edits.length, edits);
});

test('CN 模型因网络故障移除后，恢复的下一轮自动补回且不改变白名单', async (t) => {
  const { backend, resolved, editor, resync, ids } = await setup(t);
  resolved.models.only = [ALPHA.id, BETA.id];
  backend.models = [BETA];
  assert.equal((await resync.tick()).state, 'deferred');
  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(ids(), [BETA.id]);

  backend.models = [ALPHA, BETA];
  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(ids(), [ALPHA.id, BETA.id]);
  assert.deepEqual(resolved.models.only, [ALPHA.id, BETA.id]);
  assert.ok(editor.edits.every((edit) => edit.id === 'llm-pi-ai'));
});

test('只新增模型时当轮写入；白名单里已不存在的 id 被滤掉', async (t) => {
  const { backend, resolved, resync, ids } = await setup(t);
  backend.models = [ALPHA, BETA, { id: 'cn:gamma', name: 'Gamma' }];
  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(ids(), ['cn:alpha', 'global:beta', 'cn:gamma']);

  resolved.models = { ...resolved.models, only: ['cn:gamma', 'cn:gone', 'cn:alpha', 'global:beta'] };
  assert.equal((await resync.tick()).state, 'updated', '只是换顺序，没有移除');
  assert.deepEqual(ids(), ['cn:gamma', 'cn:alpha', 'global:beta']);
});

test('后端返回空列表时不清空，也不算作缺席', async (t) => {
  const { backend, editor, resync, ids } = await setup(t);
  const edits = editor.edits.length;
  backend.models = [];
  assert.equal((await resync.tick()).state, 'skipped');
  assert.deepEqual(ids(), ['cn:alpha', 'global:beta']);
  assert.equal(editor.edits.length, edits);
  assert.deepEqual([...resync.removalGuard.missing], []);
});

test('网关密钥只在启动同步时补一次，定时同步不会每轮重写', async (t) => {
  const { backend, credentials, resync } = await setup(t);
  assert.deepEqual(credentials.sets, [{ ref: 'WORKBUDDY_PROXY_KEY', value: 'gw-key' }]);
  for (let i = 0; i < 3; i += 1) assert.equal((await resync.tick()).state, 'unchanged');
  backend.models = [ALPHA, BETA, { id: 'cn:gamma' }];
  assert.equal((await resync.tick()).state, 'updated');
  assert.equal(credentials.sets.length, 1);
});

test('用户自己存的网关密钥不被定时同步覆盖；推迟的那一轮不读凭据库', async (t) => {
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'user-key' } });
  let resolves = 0;
  const resolve = credentials.resolve.bind(credentials);
  credentials.resolve = (ref) => { resolves += 1; return resolve(ref); };
  const { backend, resync } = await setup(t, { credentials });
  assert.equal((await resync.tick()).state, 'unchanged');
  assert.deepEqual(credentials.sets, []);
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'user-key');

  const before = resolves;
  backend.models = [ALPHA];
  assert.equal((await resync.tick()).state, 'deferred');
  assert.equal(resolves, before);
});

for (const [label, health] of [['/healthz 不通', { ok: false, reason: '探测 /healthz 失败：ECONNREFUSED' }], ['账号池暂无可用账号', { ok: true, servable: false }]]) {
  test(`后端未就绪（${label}）时整轮跳过，不拉目录不写配置，同一原因只记一次日志`, async (t) => {
    const { backend, editor, logger, resync } = await setup(t, { probe: async () => health });
    const edits = editor.edits.length;
    backend.models = [ALPHA];
    assert.equal((await resync.tick()).state, 'not-ready');
    assert.equal((await resync.tick()).state, 'not-ready');
    assert.equal(backend.hits, 0);
    assert.equal(editor.edits.length, edits);
    assert.equal(logger.lines.length, 1);
  });
}

test('同步开关关闭时不探测后端', async () => {
  let probed = 0;
  const resolved = resolvePluginConfig({ models: { enabled: false } }, { PATH: '' });
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: async () => { probed += 1; return { ok: true, servable: true }; },
    editor: () => undefined, credentials: () => undefined,
  });
  assert.equal((await resync.tick()).state, 'disabled');
  assert.equal(probed, 0);
});

test('上一轮未结束时再次触发不会并发同步', async () => {
  let calls = 0;
  let release;
  const resolved = resolvePluginConfig({ models: { enabled: true } }, { PATH: '' });
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: () => { calls += 1; return new Promise((resolve) => { release = () => resolve({ state: 'unchanged' }); }); },
  });
  const a = resync.tick();
  assert.equal(resync.tick(), a);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await a;
  assert.equal(calls, 1);
});

test('定时器按间隔触发，stop 后不再触发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const resolved = resolvePluginConfig({ models: { enabled: true, resyncIntervalMs: 60_000 } }, { PATH: '' });
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: async () => { calls += 1; return { state: 'unchanged' }; },
  });
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

  resync.start();
  resync.start();
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 1, '重复 start 只排一条定时链');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 2);

  resync.stop();
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls, 2);
});

test('间隔为 0 时 start 不排定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const resolved = resolvePluginConfig({ models: { enabled: true, resyncIntervalMs: 0 } }, { PATH: '' });
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: async () => { calls += 1; return { state: 'unchanged' }; },
  });
  resync.start();
  t.mock.timers.tick(10 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('启动时面板正在同步，也会排上后续自动同步，失败后仍继续重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let release;
  const resolved = resolvePluginConfig({ models: { enabled: true } }, { PATH: '' });
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = () => resolve({ state: 'unchanged' }); });
      if (calls === 2) throw new Error('temporary failure');
      return { state: 'unchanged' };
    },
  });
  t.after(() => resync.stop());
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const refresh = resync.tick();
  await flush();
  resync.start();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 1, '到期时与正在进行的面板同步共用同一轮');
  release();
  await refresh;
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 3, '失败不会中断定时链');
});

test('resyncIntervalMs：默认 1 分钟，0 关闭，过小抬到 1 分钟，非法值退回默认', () => {
  const interval = (value) => resolvePluginConfig({ models: { resyncIntervalMs: value } }, { PATH: '' }).models.resyncIntervalMs;
  assert.equal(interval(undefined), 60_000);
  assert.equal(interval(0), 0);
  assert.equal(interval(5_000), 60_000);
  assert.equal(interval('bad'), 60_000);
  assert.equal(interval(1_800_000), 1_800_000);
});

test('confirmRemovals：缺席集合是上一轮的子集才放行', () => {
  const guard = {};
  assert.equal(confirmRemovals(guard, ['a', 'b'], ['a', 'b']).ok, true);
  assert.equal(confirmRemovals(guard, ['a', 'b', 'c'], ['a']).ok, false);
  assert.equal(confirmRemovals(guard, ['a', 'b', 'c'], ['a', 'b']).ok, true, 'c 上一轮已缺席');
  assert.equal(confirmRemovals({}, [], ['x']).ok, true, '新 provider 没有可删的');
});

test('healthTarget 跟随 models.baseURL，解析不了退回托管端口', () => {
  assert.deepEqual(healthTarget('http://127.0.0.1:9090/v1', { host: '127.0.0.1', port: 7863 }), { host: '127.0.0.1', port: 9090 });
  assert.deepEqual(healthTarget('', { host: '127.0.0.1', port: 7863 }), { host: '127.0.0.1', port: 7863 });
});

/** 假 hub：/v1/models 只列当前出口的裸 id，出口写在应答顶层（与真 hub 同形状）。 */
async function serveHub(t, hub) {
  const server = createServer((_req, res) => {
    hub.hits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: hub.models[hub.realm], realm: hub.realm }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('hub 切出口：下一轮立即按新出口的那组勾选重写 DSH，不等"连续两轮缺席"', async (t) => {
  const hub = {
    realm: 'intl',
    hits: 0,
    models: {
      intl: [{ id: 'flash', name: 'Flash', credits: 'x0.00' }, { id: 'gpt-5.5', name: 'GPT-5.5', credits: 'x1' }],
      cn: [{ id: 'flash', name: 'Flash', credits: 'x0.11' }, { id: 'minimax-m3', name: 'MiniMax', credits: 'x0.2' }],
    },
  };
  const url = await serveHub(t, hub);
  const only = ['global:flash', 'global:gpt-5.5', 'cn:minimax-m3'];
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, apiKey: 'gw-key', baseURL: url, only } }, { PATH: '' });
  const editor = createFakeConfigEditor(profileRows());
  const credentials = createFakeCredentials();
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'updated');
  const probe = async () => ({ ok: true, servable: true, realm: hub.realm });
  const logger = memoryLogger();
  const resync = createModelResync({ resolved, logger, env: {}, probe, editor: () => editor, credentials: () => credentials });
  const listed = () => editor.entry('llm-pi-ai').options.config.providers.workbuddy.models.map((model) => `${model.id}|${model.name}`);
  assert.deepEqual(listed(), ['flash|Flash GL Free', 'gpt-5.5|GPT-5.5 GL 1']);

  assert.equal((await resync.tick()).state, 'unchanged', '先认下当前出口');
  hub.realm = 'cn';
  const switched = await resync.tick();
  assert.equal(switched.state, 'updated', '少了 gpt-5.5 也当轮写入');
  assert.deepEqual(listed(), ['minimax-m3|MiniMax CN 0.2'], 'CN 只勾了 minimax-m3');
  assert.ok(logger.lines.some(([, line]) => line.includes('出口从 intl 切到 cn')), JSON.stringify(logger.lines));

  // 同一出口里的上游抖动照旧要两轮确认。
  hub.models.cn = [{ id: 'flash', name: 'Flash', credits: 'x0.11' }];
  assert.equal((await resync.tick()).state, 'skipped', 'minimax 暂时不在：白名单里 cn 只有它，过滤后为空则不写');
  hub.realm = 'intl';
  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(listed(), ['flash|Flash GL Free', 'gpt-5.5|GPT-5.5 GL 1'], '切回来恢复 GL 那一组');
});

for (const outcome of ['unchanged', 'failed', 'stopped', 'switched-back']) {
  test(`出口切换撞上旧同步（${outcome}）：旧任务结束后补同步当前出口，关闭后不补`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = () => new Promise((done) => setImmediate(done));
    let realm = 'intl';
    let finishOld;
    const oldRequest = new Promise((done) => { finishOld = done; });
    const calls = [];
    const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, resyncIntervalMs: 60_000 } }, { PATH: '' });
    const resync = createModelResync({
      resolved, logger: memoryLogger(), editor: () => undefined, credentials: () => undefined, realmPollMs: 5,
      probe: async () => ({ ok: true, servable: true, realm }),
      sync: async () => {
        const requestedRealm = realm;
        calls.push(requestedRealm);
        const first = calls.length === 1;
        if (first) await oldRequest;
        return { state: first ? 'unchanged' : outcome, realm: requestedRealm };
      },
    });
    let oldTick;
    try {
      resync.start();
      t.mock.timers.tick(5);
      await flush();
      oldTick = resync.tick();
      await flush();
      assert.deepEqual(calls, ['intl']);

      realm = 'cn';
      t.mock.timers.tick(5);
      await flush();
      assert.deepEqual(calls, ['intl'], '旧任务未结束时仍串行执行');
      if (outcome === 'stopped') resync.stop();
      if (outcome === 'switched-back') realm = 'intl';
      finishOld();
      await oldTick;
      await flush();
      const expected = ['stopped', 'switched-back'].includes(outcome) ? ['intl'] : ['intl', 'cn'];
      assert.deepEqual(calls, expected, '无需等到 60 秒定时同步，也不重写已经切回去的出口');

      for (let i = 0; i < 3; i += 1) {
        t.mock.timers.tick(5);
        await flush();
      }
      assert.equal(calls.length, expected.length, '新出口真正尝试失败后仍交给普通定时重试');
    } finally {
      resync.stop();
      finishOld();
      await oldTick;
    }
  });
}

test('出口探测：几秒内发现切换并立即同步一次；同步没成也不每轮重打，wb2api 不探', async () => {
  let realm = 'intl';
  let probes = 0;
  const calls = [];
  let outcome = 'unchanged';
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true } }, { PATH: '' });
  const resync = createModelResync({
    resolved, logger: memoryLogger(), editor: () => undefined, credentials: () => undefined, realmPollMs: 5,
    probe: async () => { probes += 1; return { ok: true, servable: true, realm }; },
    sync: async (options) => { calls.push({ realm, guarded: Boolean(options.removalGuard) }); return { state: outcome, realm }; },
  });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    resync.start();
    await wait(40);
    assert.equal(calls.length, 0, '第一次探到只记下当前出口，不同步');
    realm = 'cn';
    await wait(40);
    assert.deepEqual(calls, [{ realm: 'cn', guarded: false }], '切换后立即同步一次，且不走两轮确认');

    outcome = 'failed';
    realm = 'intl';
    await wait(60);
    assert.equal(calls.length, 2, '同步没成：交给定时同步重试，不每 5 秒再打一次');
  } finally {
    resync.stop();
  }
  const seen = probes;
  await wait(30);
  assert.equal(probes, seen, 'stop 之后不再探');

  let wbProbes = 0;
  const wb = createModelResync({
    resolved: resolvePluginConfig({ models: { enabled: true } }, { PATH: '' }), logger: memoryLogger(),
    editor: () => undefined, credentials: () => undefined, realmPollMs: 5,
    probe: async () => { wbProbes += 1; return { ok: true, servable: true }; }, sync: async () => ({ state: 'unchanged' }),
  });
  wb.start();
  await wait(30);
  wb.stop();
  assert.equal(wbProbes, 0, 'wb2api 两个出口同时列出，不需要盯');
});
