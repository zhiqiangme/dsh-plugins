import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRouterEndpoint } from '../lib/router-endpoint.js';
import { ROUTER_BASE_PATH } from '../lib/auto-route.js';
import { ROUTER_PATH } from '../lib/router.js';

async function freeOrigin() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return origin;
}

test('宿主换端口后恢复旧监听并转发，卸载释放后可再次复用', async (t) => {
  const origin = await freeOrigin(), calls = [];
  const savedBaseURL = `${origin}${ROUTER_PATH}/`;
  const router = { handle(req, res) { calls.push(req.url); res.end('ok'); } };
  for (let restart = 0; restart < 2; restart++) {
    const endpoint = createRouterEndpoint({ webServer: { getOrigin: () => 'http://127.0.0.1:1' }, router, savedBaseURL });
    t.after(() => endpoint.stop());
    await endpoint.ready;
    assert.equal(endpoint.baseURL(), origin);
    assert.equal(await (await fetch(savedBaseURL)).text(), 'ok');
    await endpoint.stop();
    assert.equal(endpoint.baseURL(), undefined);
  }
  assert.equal(calls.length, 2);
});

test('当前宿主地址直接复用，不重复监听；拒绝接管外部或其它服务地址', async () => {
  const origin = await freeOrigin();
  const current = createRouterEndpoint({ webServer: { getOrigin: () => origin }, router: {}, savedBaseURL: `${origin}${ROUTER_BASE_PATH}` });
  await current.ready;
  assert.equal(current.baseURL(), origin);
  await current.stop();
  for (const savedBaseURL of [
    `http://example.com:1234${ROUTER_PATH}/`, `http://0.0.0.0:1234${ROUTER_PATH}/`,
    `https://127.0.0.1:1234${ROUTER_PATH}/`, 'http://127.0.0.1:1234/v1/',
    `http://user:pass@127.0.0.1:1234${ROUTER_PATH}/`, `http://127.0.0.1:1234${ROUTER_PATH}/?token=x`,
  ]) {
    const endpoint = createRouterEndpoint({ webServer: { getOrigin: () => origin }, router: {}, savedBaseURL });
    await endpoint.ready;
    assert.equal(endpoint.baseURL(), origin);
    await endpoint.stop();
  }
});
