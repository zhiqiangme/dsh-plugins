import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { describeModels, setHubMode } from '../lib/web.js';
import { syncModels } from '../lib/models.js';
import { diagnose } from '../lib/diagnostics.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

async function setup(t) {
  const hub = { realm: 'intl', wrongBinding: false, hits: [] };
  const server = createServer((req, res) => {
    const key = req.headers.authorization;
    const realm = hub.wrongBinding ? 'intl' : key === 'Bearer follow-secret' ? req.headers['x-realm'] || hub.realm : key === 'Bearer cn-secret' ? 'cn' : 'intl';
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
  return { hub, resolved, editor, credentials, options };
}

test('HUB 双区域：独立凭据、同名模型独立分组、模型 id 不改、关闭时还原单区域', async (t) => {
  const { hub, resolved, editor, credentials, options } = await setup(t);
  const saved = await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' });
  assert.equal(saved.ok, true);
  assert.equal(saved.sync.state, 'updated');
  const config = () => editor.entry('llm-pi-ai').options.config;
  const cn = config().providers['workbuddy-hub-cn'];
  const gl = config().providers['workbuddy-hub-global'];
  assert.equal(cn.models[0].id, 'shared');
  assert.equal(cn.models[0].name, 'Shared CN Free');
  assert.equal(gl.models[0].name, 'Shared GL Free');
  assert.deepEqual(config().providers.workbuddy.models, []);
  assert.ok(!JSON.stringify(editor.edits).includes('cn-secret'));
  assert.ok(!JSON.stringify(saved).includes('gl-secret'));
  for (const [provider, expected] of [[cn, 'cn'], [gl, 'intl']]) {
    const key = (await credentials.resolve(provider.apiKeyEnv)).value;
    const reply = await fetch(`${provider.baseURL}chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
    assert.equal((await reply.json()).realm, expected);
  }
  hub.realm = 'cn';
  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  assert.deepEqual(snapshot.models.map((row) => row.id), ['cn:shared', 'global:shared']);
  assert.equal(snapshot.realm, 'dual');
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'unchanged');
  assert.equal((await setHubMode({ ...options, enabled: false })).ok, true);
  assert.equal(config().providers['workbuddy-hub-cn'], undefined);
  assert.equal(config().providers.workbuddy.models[0].id, 'shared');
  assert.ok(config().providers.openrouter);
});

test('区域 Key 绑定错误和 provider 名称冲突时，不保存模式或凭据', async (t) => {
  const { hub, editor, credentials, options } = await setup(t);
  hub.wrongBinding = true;
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' })).ok, false);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);
  hub.wrongBinding = false;
  editor.entry('llm-pi-ai').options.config.providers['workbuddy-hub-cn'] = { apiKeyEnv: 'USER_KEY' };
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' })).ok, false);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);
});

test('未绑定 Key 单独存入凭据库，关闭双区域后可以继续跟随看板出口', async (t) => {
  const { hub, resolved, editor, credentials, options } = await setup(t);
  const enabled = await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret', followKey: 'follow-secret' });
  assert.equal(enabled.ok, true);
  assert.equal((await credentials.resolve('WORKBUDDY_PROXY_KEY')).value, 'follow-secret');
  assert.ok(!JSON.stringify(editor.edits).includes('follow-secret'));
  hub.realm = 'cn';
  assert.equal((await setHubMode({ ...options, enabled: false })).ok, true);
  const provider = editor.entry('llm-pi-ai').options.config.providers.workbuddy;
  assert.equal(provider.models[0].name, 'Shared CN Free');
  assert.equal(resolved.models.apiKeyRef, 'WORKBUDDY_PROXY_KEY');
});

test('双区域诊断使用各自凭据并遮盖两把 Key，白名单暂时缺席时不清空分组', async (t) => {
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
