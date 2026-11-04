import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHubEndpoint } from '../lib/hub-endpoint.js';
import { HUB_ROUTER_PATH } from '../lib/models.js';

async function freeOrigin() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return origin;
}

test('宿主换端口后恢复 provider 已保存的地址，卸载释放监听，重启继续复用', async (t) => {
  const origin = await freeOrigin();
  const savedBaseURL = `${origin}${HUB_ROUTER_PATH}/`;
  const calls = [];
  const router = { handle(req, res) { calls.push(req.url); res.end('ok'); } };
  const webServer = { getOrigin: () => 'http://127.0.0.1:1' };
  for (let restart = 0; restart < 2; restart++) {
    const endpoint = createHubEndpoint({ webServer, router, savedBaseURL });
    t.after(() => endpoint.stop());
    await endpoint.ready;
    assert.equal(endpoint.baseURL(), savedBaseURL);
    assert.equal(await (await fetch(`${savedBaseURL}chat/completions`)).text(), 'ok');
    await endpoint.stop();
    assert.equal(endpoint.baseURL(), undefined);
  }
  assert.equal(calls.length, 2);
});

test('已保存地址仍属于当前宿主时复用宿主，不重复绑定端口', async () => {
  const origin = await freeOrigin();
  const savedBaseURL = `${origin}${HUB_ROUTER_PATH}/`;
  const endpoint = createHubEndpoint({ webServer: { getOrigin: () => origin }, router: {}, savedBaseURL });
  await endpoint.ready;
  assert.equal(endpoint.baseURL(), savedBaseURL);
  await assert.rejects(fetch(savedBaseURL));
  await endpoint.stop();
});

test('不接管外部主机、通配地址、其它服务路径、凭据或查询参数', async () => {
  const origin = 'http://127.0.0.1:1';
  for (const savedBaseURL of [
    `http://example.com:1234${HUB_ROUTER_PATH}/`,
    `http://0.0.0.0:1234${HUB_ROUTER_PATH}/`,
    `https://127.0.0.1:1234${HUB_ROUTER_PATH}/`,
    'http://127.0.0.1:1234/v1/',
    `http://user:pass@127.0.0.1:1234${HUB_ROUTER_PATH}/`,
    `http://127.0.0.1:1234${HUB_ROUTER_PATH}/?token=x`,
  ]) {
    const endpoint = createHubEndpoint({ webServer: { getOrigin: () => origin }, router: {}, savedBaseURL });
    await endpoint.ready;
    assert.equal(endpoint.baseURL(), `${origin}${HUB_ROUTER_PATH}/`);
    await endpoint.stop();
  }
});

test('端口冲突明确报告，不接管其它服务，也不把未就绪地址交给模型同步', async (t) => {
  const server = createServer((_req, res) => res.end('other service'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const endpoint = createHubEndpoint({
    webServer: { getOrigin: () => 'http://127.0.0.1:1' }, router: {},
    savedBaseURL: `${origin}${HUB_ROUTER_PATH}/`, onError: error => errors.push(error.code),
  });
  t.after(() => endpoint.stop());
  await endpoint.ready;
  assert.deepEqual(errors, ['EADDRINUSE']);
  assert.equal(endpoint.baseURL(), undefined);
  assert.equal(await (await fetch(origin)).text(), 'other service');
});
