import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHubRouter, parseHubModel } from '../lib/hub-router.js';
import { HUB_ROUTER_PATH } from '../lib/models.js';
import { resolvePluginConfig } from '../lib/config.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

async function setup(t, upstream, options = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({ body, headers: req.headers });
    upstream(req, res, body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, hubDual: true, baseURL: `http://127.0.0.1:${server.address().port}` } }, {});
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'shared-secret', WORKBUDDY_PROXY_KEY_CN: 'cn-secret', WORKBUDDY_PROXY_KEY_GLOBAL: 'gl-secret' } });
  const editor = createFakeConfigEditor(profileRows());
  const router = createHubRouter({ resolved, credentials: () => credentials, editor: () => editor, env: {}, ...options });
  const proxy = createServer((req, res) => router.handle(req, res));
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  t.after(() => {
    router.stop(); server.closeAllConnections(); proxy.closeAllConnections();
    return Promise.all([new Promise((done) => server.close(done)), new Promise((done) => proxy.close(done))]);
  });
  const url = `http://127.0.0.1:${proxy.address().port}${HUB_ROUTER_PATH}`;
  const send = (body, extra = {}) => fetch(`${url}/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer shared-secret', 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra,
  });
  return { resolved, credentials, router, send, calls, url };
}

test('区域模型只接受 cn:/global: 前缀，裸 id 和空模型不能静默跟随出口', () => {
  assert.deepEqual(parseHubModel('cn:deepseek-v4.1'), { realm: 'cn', model: 'deepseek-v4.1' });
  assert.deepEqual(parseHubModel('global:vendor:model'), { realm: 'intl', model: 'vendor:model' });
  for (const id of ['', 'cn:', 'intl:m', 'm', null]) assert.equal(parseHubModel(id), undefined);
});

test('同组模型按区域 Key 路由，保留图像、工具与推理参数，Key 修改后立即生效', async (t) => {
  const { send, calls, credentials } = await setup(t, (_req, res) => res.end('{}'));
  const body = { model: 'cn:model', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }], tools: [{ type: 'function' }], reasoning_effort: 'high', temperature: 0.5 };
  assert.equal((await send(body)).status, 200);
  await credentials.set('WORKBUDDY_PROXY_KEY_CN', 'new-cn-secret');
  await send(body);
  await send({ ...body, model: 'global:model' });
  assert.deepEqual(calls.map((call) => [call.headers['x-realm'], call.headers.authorization]), [
    ['cn', 'Bearer cn-secret'], ['cn', 'Bearer new-cn-secret'], ['intl', 'Bearer gl-secret'],
  ]);
  assert.deepEqual(calls[0].body, { ...body, model: 'model' });
});

test('SSE 原样流式返回，首块不等待完成；保留上游错误状态和响应体', async (t) => {
  let finish;
  const { send } = await setup(t, (_req, res, body) => {
    if (body.model === 'limited') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limited"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    finish = () => res.end('data: [DONE]\n\n');
  });
  const response = await send({ model: 'global:model', stream: true, messages: [] });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /first/); assert.doesNotMatch(first, /DONE/);
  finish();
  let tail = '';
  for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.equal(tail, 'data: [DONE]\n\n');
  const limited = await send({ model: 'cn:limited' });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: { message: 'rate limited' } });
});

for (const stop of ['client', 'plugin']) test(`停止 ${stop} 会取消正在转发的 HUB 流`, async (t) => {
  let upstreamClosed;
  const closed = new Promise((done) => { upstreamClosed = done; });
  const { send, router } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n');
    res.once('close', upstreamClosed);
  });
  const controller = new AbortController();
  const response = await send({ model: 'cn:model', stream: true }, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  if (stop === 'client') controller.abort(); else router.stop();
  await assert.rejects(reader.read());
  let timer;
  try { await Promise.race([closed, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('上游没有取消')), 1500); })]); }
  finally { clearTimeout(timer); }
});

test('转发端点只接受本机凭据调用，拒绝跨站、错误 Key、未知模型与过大的请求', async (t) => {
  const { send, calls, url } = await setup(t, (_req, res) => res.end('{}'), { maxBodyBytes: 150 });
  const headers = { 'content-type': 'application/json', authorization: 'Bearer shared-secret' };
  assert.equal((await send({ model: 'cn:m' }, { headers: { ...headers, authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await send({ model: 'cn:m' }, { headers: { ...headers, origin: 'http://evil.test' } })).status, 403);
  assert.equal((await send({ model: 'bare' })).status, 400);
  assert.equal((await send({ model: 'cn:m', messages: ['x'.repeat(300)] })).status, 413);
  assert.equal((await fetch(`${url}/other`, { headers })).status, 404);
  assert.equal(calls.length, 0);
});
