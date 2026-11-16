import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { createHubRouter } from '../lib/hub-router.js';
import { createExitCredits, readWb2apiExpiry } from '../lib/exit-credits.js';
import { fetchGatewayRegions, hubRegionPlans, planHubEntries, HUB_ROUTER_PATH } from '../lib/models.js';
import { describeModels, setWb2apiMode } from '../lib/web.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

const NOW = Date.parse('2026-11-16T00:00:00Z');
const models = [
  { id: 'cn:m', name: 'Model', credits: 0.2 }, { id: 'global:m', name: 'Model', credits: 0 },
  { id: 'cn:paid', name: 'Paid', credits: 0.1 }, { id: 'global:paid', name: 'Paid', credits: 0.8 },
];
const account = (realm, hours, extra = {}) => ({ realm, credits: 100,
  credits_expiry_buckets: [{ expires_at: new Date(NOW + hours * 3600000).toISOString(), remain: 100 }], ...extra });

async function setup(t, { only = [], chat = (_req, res) => res.end('{}') } = {}) {
  const requests = [], calls = [];
  const catalog = [...models];
  const accounts = [account('cn', 144), account('global', 48)];
  const upstream = createServer(async (req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer wb-key');
    assert.equal(req.headers['x-realm'], undefined, 'wb2api 使用区域前缀，不能误发 Hub 的区域头');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: catalog }));
    if (req.url === '/panel/api/overview') return res.end(JSON.stringify({ accounts }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    chat(req, res, body);
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const resolved = resolvePluginConfig({ gateway: 'wb2api', models: { enabled: true, autoRoute: true, apiKey: 'wb-key', only, baseURL: `http://127.0.0.1:${upstream.address().port}` } }, {});
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'wb-key', WORKBUDDY_WB2API_KEY: 'wb-key', WORKBUDDY_PROXY_KEY_CN: 'hub-only-cn', WORKBUDDY_PROXY_KEY_GLOBAL: 'hub-only-gl' } });
  const editor = createFakeConfigEditor(profileRows({ models: { enabled: true, only } }));
  let now = NOW;
  const exits = createExitCredits({ resolved, credentials: () => credentials, env: {}, now: () => now });
  const router = createHubRouter({ resolved, credentials: () => credentials, editor: () => editor, exits, env: {}, now: () => now });
  const proxy = createServer((req, res) => router.handle(req, res));
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${proxy.address().port}${HUB_ROUTER_PATH}`;
  resolved.models.hubProxyBaseURL = `${url}/`;
  t.after(async () => {
    router.stop(); proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((done) => proxy.close(done)), new Promise((done) => upstream.close(done))]);
  });
  const send = (model) => fetch(`${url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer wb-key', 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'same conversation' }] }) });
  return { resolved, credentials, editor, exits, send, calls, catalog, accounts, requests, advance: (ms) => { now += ms; } };
}

test('wb2api 复用合并规划，但只让勾选的区域参与；缺席已选区域不扩大为全选', async (t) => {
  const state = await setup(t, { only: ['cn:m'] });
  const fetched = await fetchGatewayRegions({ models: state.resolved.models, credentials: state.credentials, env: {} });
  const plan = planHubEntries(hubRegionPlans(fetched.regions, state.resolved.models));
  assert.deepEqual(plan.entries.map((entry) => entry.id), ['auto:m']);
  assert.deepEqual(plan.routes.get('m').map((route) => [route.realm, route.model]), [['cn', 'm']]);
  const displayed = await describeModels({ ...state.resolved, editor: state.editor, credentials: state.credentials, env: {} });
  assert.deepEqual(displayed.models.filter((model) => model.selected).map((model) => model.id), ['cn:m']);
  assert.equal((await state.send('auto:m')).status, 200);
  assert.equal(state.calls.at(-1).model, 'cn:m');
});

test('wb2api 共用免费优先、72 小时临期优先、故障冷却和恢复，出站保留真实区域 id', async (t) => {
  let failFree = true;
  const state = await setup(t, { chat: (_req, res, body) => {
    res.writeHead(body.model === 'global:m' && failFree ? 429 : 200);
    res.end('{}');
  } });
  assert.equal((await state.send('auto:m')).status, 200);
  assert.deepEqual(state.calls.map((body) => body.model), ['global:m', 'cn:m']);
  await state.send('auto:m');
  assert.equal(state.calls.at(-1).model, 'cn:m', '同一对话暂时跳过刚失败的免费出口');
  await state.send('auto:paid');
  assert.equal(state.calls.at(-1).model, 'global:paid', '临期积分优先于更低倍率');
  failFree = false; state.advance(5 * 60000 + 1);
  await state.send('auto:m');
  assert.equal(state.calls.at(-1).model, 'global:m', '冷却后恢复免费优先，不被付费固定记录锁住');
});

test('wb2api 模式可保存、合并、恢复分区域模型，缺失目录和写入失败时保留现有配置', async (t) => {
  const state = await setup(t, { only: ['cn:m', 'global:m'] });
  const options = { resolved: state.resolved, editor: state.editor, credentials: state.credentials, env: {} };
  const enabled = await setWb2apiMode({ ...options, enabled: true });
  assert.equal(enabled.sync.state, 'updated');
  const provider = () => state.editor.entry('llm-pi-ai').options.config.providers.workbuddy;
  assert.deepEqual(provider().models.map((entry) => entry.id), ['auto:m']);
  assert.match(provider().baseURL, /\/hub\/v1\/$/);
  assert.equal(provider().apiKeyEnv, 'WORKBUDDY_WB2API_KEY');
  const disabled = await setWb2apiMode({ ...options, enabled: false });
  assert.ok(['updated', 'unchanged'].includes(disabled.sync.state));
  assert.deepEqual(provider().models.map((entry) => entry.id), ['cn:m', 'global:m']);
  assert.equal(provider().baseURL, `${state.resolved.models.baseURL}/v1/`);
  state.catalog.splice(1, 1);
  await setWb2apiMode({ ...options, enabled: true });
  assert.deepEqual(provider().models.map((entry) => entry.id), ['cn:m', 'global:m'], '已选区域目录缺席不清空模型');
  state.editor.edit = async () => { throw new Error('locked'); };
  const result = await setWb2apiMode({ ...options, enabled: false });
  assert.equal(result.ok, false);
  assert.equal(state.resolved.models.autoRoute, true, '保存失败不先改运行态');
});

test('wb2api 到期快照按 RFC3339 时区解析，排除禁用、暂停、过期和用尽积分，读取合并缓存', async (t) => {
  const state = await setup(t);
  const expiry = readWb2apiExpiry({ accounts: [
    account('cn', 48), account('cn', 1, { disabled: true }), account('cn', 2, { paused: true }),
    account('global', -1), account('global', 1, { credits: 0 }),
    { realm: 'global', credits: 50, credits_earliest_expiry: '2026-11-18T08:00:00+08:00', credits_earliest_remaining: 20 },
  ] }, NOW);
  assert.equal(expiry.cn.expireAt, NOW + 48 * 3600000);
  assert.equal(expiry.intl.expireAt, NOW + 48 * 3600000);
  assert.equal(expiry.intl.expiring, 20);
  const [credits, ready] = await Promise.all([state.exits.snapshot(), state.exits.readiness()]);
  assert.equal(credits.intl.expireAt, NOW + 48 * 3600000);
  assert.deepEqual([...ready.ready], ['cn', 'intl']);
  assert.equal(state.requests.filter((path) => path === '/panel/api/overview').length, 1);
});
