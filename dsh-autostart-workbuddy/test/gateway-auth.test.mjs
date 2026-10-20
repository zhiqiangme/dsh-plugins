import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePluginConfig } from '../lib/config.js';
import { GATEWAY_KEY_REFS, HUB_ROUTER_PATH, resolveModelApiKey, syncModels } from '../lib/models.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

test('HUB → wb2api → HUB 重启后凭据隔离：旧共享 Key 不污染 wb2api，地址和实际调用同时恢复', async (t) => {
  const backend = { gateway: 'hub', wbKey: 'wb-secret' };
  const server = createServer(async (req, res) => {
    if (!req.url.startsWith('/v1/')) { res.writeHead(405); res.end(); return; }
    const accepted = backend.gateway === 'hub' ? ['hub-secret', 'cn-saved', 'gl-saved'] : [backend.wbKey];
    if (!accepted.some((key) => req.headers.authorization === `Bearer ${key}`)) { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify(backend.gateway === 'hub'
        ? { realm: req.headers['x-realm'] || 'intl', data: [{ id: 'shared', name: 'Shared', credits: 'Free' }] }
        : { data: [{ id: 'cn:shared', name: 'Shared', credits: 'Free' }, { id: 'global:shared', name: 'Shared', credits: 'Free' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end(JSON.stringify({ gateway: backend.gateway, model: JSON.parse(Buffer.concat(chunks)).model }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'wb-gateway-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const panelConfig = join(dir, 'config.json');
  const savePanel = () => writeFileSync(panelConfig, JSON.stringify({ api_key: backend.wbKey }));
  savePanel();
  const rawModels = { enabled: true, hubDual: true, baseURL: origin, panelConfig, apiKeyRef: 'WORKBUDDY_PROXY_KEY' };
  const editor = createFakeConfigEditor(profileRows());
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'hub-secret', WORKBUDDY_PROXY_KEY_CN: 'cn-saved', WORKBUDDY_PROXY_KEY_GLOBAL: 'gl-saved' } });
  const sync = async (gateway) => {
    backend.gateway = gateway;
    const resolved = resolvePluginConfig({ gateway, port: server.address().port, models: rawModels }, {});
    if (gateway === 'hub') resolved.models.hubProxyBaseURL = `${origin}${HUB_ROUTER_PATH}/`;
    const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
    assert.equal(result.state, 'updated', result.reason);
    return { resolved, result, provider: editor.entry('llm-pi-ai').options.config.providers.workbuddy };
  };
  for (let cycle = 0; cycle < 2; cycle++) {
    const hub = await sync('hub');
    assert.equal(hub.provider.apiKeyEnv, GATEWAY_KEY_REFS.hub);
    assert.equal(credentials.values[GATEWAY_KEY_REFS.hub], 'hub-secret');
    assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_CN, 'cn-saved');
    assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_GLOBAL, 'gl-saved');
    const wb = await sync('wb2api');
    assert.equal(await resolveModelApiKey(wb.resolved.models, {}, credentials), backend.wbKey);
    assert.equal(wb.provider.apiKeyEnv, GATEWAY_KEY_REFS.wb2api);
    assert.equal(wb.provider.baseURL, `${origin}/v1/`);
    const reply = await fetch(`${wb.provider.baseURL}chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${credentials.values[wb.provider.apiKeyEnv]}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'cn:shared', messages: [] }) });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { gateway: 'wb2api', model: 'cn:shared' });
    assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'hub-secret', '旧共享凭据不能被切换覆盖');
    assert.equal(credentials.values[GATEWAY_KEY_REFS.hub], 'hub-secret');
  }
  backend.wbKey = 'rotated-wb-secret'; savePanel();
  const resolved = resolvePluginConfig({ port: server.address().port, models: rawModels }, {});
  const rotated = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  assert.equal(rotated.credential.state, 'replaced');
  assert.equal(credentials.values[GATEWAY_KEY_REFS.wb2api], backend.wbKey);
  assert.equal(credentials.values[GATEWAY_KEY_REFS.hub], 'hub-secret');
});

test('自定义 wb2api 凭据引用不被 HUB 专用引用覆盖；外部实例仍可显式用旧共享引用', async () => {
  const credentials = createFakeCredentials({ stored: { CUSTOM_WB_KEY: 'custom-wb', WORKBUDDY_PROXY_KEY: 'external-key' } });
  const config = { models: { apiKeyRef: 'CUSTOM_WB_KEY', hubApiKeyRef: 'CUSTOM_HUB_KEY' } };
  const wb = resolvePluginConfig(config, {});
  assert.equal(wb.models.apiKeyRef, 'CUSTOM_WB_KEY');
  assert.equal(await resolveModelApiKey(wb.models, {}, credentials), 'custom-wb');
  const external = resolvePluginConfig({ models: { apiKeyRef: 'WORKBUDDY_PROXY_KEY', baseURL: 'http://127.0.0.1:1' } }, {});
  assert.equal(await resolveModelApiKey(external.models, {}, credentials), 'external-key');
});
