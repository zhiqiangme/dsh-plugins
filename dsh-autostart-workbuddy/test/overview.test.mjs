import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { createAccountOverview } from '../lib/overview.js';
import { createFakeCredentials } from '../fixtures/fake-config-editor.mjs';

async function setup(t, dual = false) {
  const state = { hits: [], status: 200, balance: null };
  const server = createServer((req, res) => {
    state.hits.push(req.url);
    const realm = req.headers.authorization === 'Bearer key-cn' ? 'cn' : 'intl';
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ realm, balance: state.balance, accounts_enabled: 2, accounts_with_credit_data: state.balance === null ? 0 : 2, updated_at: 1_790_000_000, token: 'must-not-leak' }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { hubDual: dual, baseURL: `http://127.0.0.1:${server.address().port}` } }, {});
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY_CN: 'key-cn', WORKBUDDY_PROXY_KEY_GLOBAL: 'key-gl' } });
  return { state, resolved, credentials, driver: { probe: async () => ({ ok: true, healthy: 1, total: 2 }) } };
}

test('HUB 概览保留未知余额并过滤身份字段，不请求聊天或上游刷新接口', async (t) => {
  const x = await setup(t);
  const report = await createAccountOverview(x)();
  assert.equal(report.ready, 1);
  assert.equal(report.balances[0].balance, null);
  assert.equal(report.balances[0].state, 'unknown');
  assert.equal(report.balances[0].accountsEnabled, 2);
  assert.deepEqual(x.state.hits, ['/v1/balance-summary']);
  assert.ok(!JSON.stringify(report).includes('must-not-leak'));
});

test('双区域按独立 Key 取积分，真实零余额与未知不同，30 秒缓存合并并发请求', async (t) => {
  const x = await setup(t, true);
  x.state.balance = 0;
  let now = 0;
  const read = createAccountOverview({ ...x, now: () => now });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a, b);
  assert.deepEqual(a.balances.map((row) => [row.realm, row.balance, row.state]), [['cn', 0, 'ready'], ['intl', 0, 'ready']]);
  assert.equal(x.state.hits.length, 2);
  await read(); assert.equal(x.state.hits.length, 2);
  now = 30_001;
  await read(); assert.equal(x.state.hits.length, 4);
});

test('旧版不支持与鉴权失败给出明确状态，不伪造零余额', async (t) => {
  const x = await setup(t);
  x.state.status = 404;
  assert.equal((await createAccountOverview(x)()).balances[0].state, 'unsupported');
  x.state.status = 401;
  const result = await createAccountOverview(x)();
  assert.equal(result.balances[0].state, 'unauthorized');
  assert.equal(result.balances[0].balance, null);
});
