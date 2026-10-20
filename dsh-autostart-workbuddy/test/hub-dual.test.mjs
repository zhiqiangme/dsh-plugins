import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { describeModels, setHubMode } from '../lib/web.js';
import { syncModels } from '../lib/models.js';
import { diagnose } from '../lib/diagnostics.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

/**
 * 假 hub：与 v1.7.16 的 _request_realm 同序——绑定区域的 Key 优先，其次 X-Realm 头，最后看板全局出口。
 * cn-secret / gl-secret 是绑定 Key；其余 Key 视为未绑定，boundShared 时模拟网关 Key 在 HUB 里被绑到国际。
 */
async function setup(t) {
  const hub = { realm: 'intl', wrongBinding: false, boundShared: false, hits: [] };
  const server = createServer((req, res) => {
    const key = req.headers.authorization;
    const bound = key === 'Bearer cn-secret' ? 'cn' : key === 'Bearer gl-secret' ? 'intl' : hub.boundShared ? 'intl' : '';
    const realm = hub.wrongBinding ? 'intl' : bound || req.headers['x-realm'] || hub.realm;
    hub.hits.push([req.url, realm]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/models') ? { realm, data: [{ id: 'shared', name: 'Shared', credits: 'x0.00' }] } : { realm }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, baseURL: `http://127.0.0.1:${server.address().port}` } }, {});
  const editor = createFakeConfigEditor(profileRows());
  const credentials = createFakeCredentials();
  const options = { resolved, editor, credentials, env: {} };
  const config = () => editor.entry('llm-pi-ai').options.config;
  return { hub, resolved, editor, credentials, options, config };
}

/** 按 llm-pi-ai 的方式发一条对话：provider 的 headers 加上凭据库里 apiKeyEnv 的值。 */
async function chatRealm(provider, credentials) {
  const key = (await credentials.resolve(provider.apiKeyEnv)).value;
  const reply = await fetch(`${provider.baseURL}chat/completions`, { method: 'POST', headers: { ...provider.headers, authorization: `Bearer ${key}` } });
  return (await reply.json()).realm;
}

test('HUB 双区域：无需另建 Key，按 X-Realm 头分出 CN / GL 分组，原分组照旧跟随看板出口', async (t) => {
  const { hub, resolved, editor, credentials, options, config } = await setup(t);
  const saved = await setHubMode({ ...options, enabled: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.sync.state, 'updated');
  const { workbuddy, 'workbuddy-hub-cn': cn, 'workbuddy-hub-global': gl } = config().providers;
  assert.equal(cn.models[0].id, 'shared');
  assert.equal(cn.models[0].name, 'Shared CN Free');
  assert.equal(gl.models[0].name, 'Shared GL Free');
  assert.deepEqual([cn.headers, gl.headers], [{ 'X-Realm': 'cn' }, { 'X-Realm': 'intl' }]);
  // 与原分组共用一个凭据引用，不另建区域凭据。
  assert.equal(cn.apiKeyEnv, workbuddy.apiKeyEnv);
  assert.equal(gl.apiKeyEnv, workbuddy.apiKeyEnv);
  assert.ok(!credentials.sets.some((row) => /_CN$|_GLOBAL$/.test(row.ref)));
  // 已有会话和默认模型引用的 workbuddy/shared 仍然可用。
  assert.equal(workbuddy.models[0].id, 'shared');
  assert.equal(workbuddy.models[0].name, 'Shared GL Free');
  assert.equal(await chatRealm(cn, credentials), 'cn');
  assert.equal(await chatRealm(gl, credentials), 'intl');

  hub.realm = 'cn';
  const switched = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  assert.equal(switched.state, 'updated');
  assert.equal(switched.realm, 'cn', 'realm 仍报跟随分组的出口，定时同步靠它认出切换');
  assert.equal(switched.dual.state, 'unchanged');
  assert.equal(config().providers.workbuddy.models[0].name, 'Shared CN Free');
  assert.equal(await chatRealm(config().providers['workbuddy-hub-global'], credentials), 'intl', '看板切到 CN 后 GL 分组仍走国际');

  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  assert.deepEqual(snapshot.models.map((row) => row.id), ['cn:shared', 'global:shared']);
  assert.equal(snapshot.realm, 'dual');
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'unchanged');

  assert.equal((await setHubMode({ ...options, enabled: false })).ok, true);
  assert.equal(config().providers['workbuddy-hub-cn'], undefined);
  assert.equal(config().providers['workbuddy-hub-global'], undefined);
  assert.equal(config().providers.workbuddy.models[0].id, 'shared');
  assert.ok(config().providers.openrouter);
});

test('区域 Key 是可选覆盖：填了的区域改用专用凭据，Key 不进 profile 和返回值', async (t) => {
  const { credentials, options, config } = await setup(t);
  const saved = await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' });
  assert.equal(saved.ok, true);
  const { 'workbuddy-hub-cn': cn, 'workbuddy-hub-global': gl } = config().providers;
  assert.deepEqual([cn.apiKeyEnv, gl.apiKeyEnv], ['WORKBUDDY_PROXY_KEY_CN', 'WORKBUDDY_PROXY_KEY_GLOBAL']);
  assert.equal(await chatRealm(cn, credentials), 'cn');
  assert.equal(await chatRealm(gl, credentials), 'intl');
  assert.ok(!JSON.stringify(config()).includes('cn-secret'));
  assert.ok(!JSON.stringify(saved).includes('gl-secret'));
});

test('网关 Key 在 HUB 里绑了区域时 X-Realm 无效：拒绝开启；只给被挡住的区域补 Key 即可', async (t) => {
  const { hub, editor, credentials, options, config } = await setup(t);
  hub.boundShared = true;
  const refused = await setHubMode({ ...options, enabled: true });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /跟随面板切换/);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);

  // 网关 Key 绑的是国际：只补 CN 区域 Key，GL 继续用网关 Key。
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret' })).ok, true);
  const { workbuddy, 'workbuddy-hub-cn': cn, 'workbuddy-hub-global': gl } = config().providers;
  assert.equal(cn.apiKeyEnv, 'WORKBUDDY_PROXY_KEY_CN');
  assert.equal(gl.apiKeyEnv, workbuddy.apiKeyEnv);
});

test('区域 Key 绑定错误和 provider 名称冲突时，不保存模式或凭据', async (t) => {
  const { hub, editor, credentials, options } = await setup(t);
  hub.wrongBinding = true;
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' })).ok, false);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);
  hub.wrongBinding = false;
  editor.entry('llm-pi-ai').options.config.providers['workbuddy-hub-cn'] = { apiKeyEnv: 'USER_KEY' };
  assert.equal((await setHubMode({ ...options, enabled: true })).ok, false);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);
});

test('从旧版双区域升级：认得旧分组，补上 X-Realm 头，清空过的原分组恢复模型', async (t) => {
  const { resolved, editor, credentials, config } = await setup(t);
  const providers = config().providers;
  const legacy = (ref) => ({ displayName: 'old', apiKeyEnv: ref, baseURL: providers.workbuddy.baseURL, api: 'openai-completions', models: [] });
  providers['workbuddy-hub-cn'] = legacy('WORKBUDDY_PROXY_KEY_CN');
  providers['workbuddy-hub-global'] = legacy('WORKBUDDY_PROXY_KEY_GLOBAL');
  providers.workbuddy = { ...providers.workbuddy, models: [] };
  await credentials.set('WORKBUDDY_PROXY_KEY_CN', 'cn-secret');
  await credentials.set('WORKBUDDY_PROXY_KEY_GLOBAL', 'gl-secret');
  const result = await syncModels({ spec: resolved.spec, models: { ...resolved.models, hubDual: true }, editor, credentials, env: {} });
  assert.equal(result.state, 'updated');
  assert.equal(config().providers.workbuddy.models[0].id, 'shared');
  assert.equal(config().providers['workbuddy-hub-cn'].headers['X-Realm'], 'cn');
  assert.equal(config().providers['workbuddy-hub-cn'].apiKeyEnv, 'WORKBUDDY_PROXY_KEY_CN');
});

test('未绑定 Key 单独存入凭据库，关闭双区域后可以继续跟随看板出口', async (t) => {
  const { hub, resolved, editor, credentials, options } = await setup(t);
  const enabled = await setHubMode({ ...options, enabled: true, followKey: 'follow-secret' });
  assert.equal(enabled.ok, true);
  assert.equal((await credentials.resolve('WORKBUDDY_PROXY_KEY')).value, 'follow-secret');
  assert.ok(!JSON.stringify(editor.edits).includes('follow-secret'));
  hub.realm = 'cn';
  assert.equal((await setHubMode({ ...options, enabled: false })).ok, true);
  const provider = editor.entry('llm-pi-ai').options.config.providers.workbuddy;
  assert.equal(provider.models[0].name, 'Shared CN Free');
  assert.equal(resolved.models.apiKeyRef, 'WORKBUDDY_PROXY_KEY');
});

test('双区域诊断遮盖所有 Key，白名单暂时缺席时不清空分组', async (t) => {
  const { resolved, editor, credentials, options } = await setup(t);
  await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' });
  const report = await diagnose({ ...options, service: { recentStderr: ['cn-secret gl-secret'] }, driver: {
    title: 'fixture', probe: async () => ({ ok: true, servable: true, healthy: 2, total: 2 }),
  } });
  assert.deepEqual(report.checks.find((check) => check.id === 'models').detail, { count: 2, realm: 'dual' });
  assert.ok(!JSON.stringify(report).includes('cn-secret'));
  assert.ok(!JSON.stringify(report).includes('gl-secret'));
  assert.ok(!report.checks.some((check) => check.id === 'credential' && !check.ok));
  resolved.models.only = ['cn:missing'];
  resolved.models.rules = { freeOnly: true };
  const before = structuredClone(editor.entry('llm-pi-ai').options.config);
  const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  assert.equal(result.state, 'skipped');
  assert.deepEqual(editor.entry('llm-pi-ai').options.config, before);
});
