import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handlerFor, rejection } from '../lib/web.js';
import { ModelManager } from '../lib/runtime.js';
import { fakeHost } from '../fixtures/host.mjs';

async function call(method = 'GET', body, headers = {}, manager) {
  const host = fakeHost();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, headers: { host: 'localhost:9876', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const result = {};
  const res = { writeHead: (status, h) => Object.assign(result, { status, headers: h }), end: (s) => { result.body = JSON.parse(s); } };
  await handlerFor(host.ctx, manager ?? new ModelManager(host.ctx, {}, { env: {} }))(req, res);
  return result;
}

test('路由读取模型清单，不带 Key，缓存关闭，未支持的方法返回 405', async () => {
  const result = await call();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.config.models, []);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal((await call('DELETE')).status, 405);
});

test('POST 拒绝非 JSON、无效对象、非法 JSON 和过大请求', async () => {
  assert.equal((await call('POST', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', '[]')).status, 400);
  assert.equal((await call('POST', '{bad')).status, 400);
  assert.equal((await call('POST', ' '.repeat(512 * 1024 + 1))).status, 413);
});

test('拒绝跨源与远程请求，优先沿用宿主会话校验', async () => {
  assert.equal((await call('POST', {}, { origin: 'http://attacker.example' })).status, 403);
  assert.equal((await call('GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(rejection({ socket: { remoteAddress: '192.168.1.5' } }), 403);
  assert.equal(rejection({}, { requestRejection: () => 401 }), 401);
  assert.equal(rejection({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost', origin: 'http://localhost' } }), undefined);
});

test('保存冲突经 HTTP 状态 409 返回', async () => {
  const result = await call('POST', { action: 'save', revision: 'stale', config: {} });
  assert.equal(result.status, 409);
});

test('真实 HTTP 假网关：检查身份、带标识拉目录，服务异常不更改清单', async (t) => {
  const calls = [];
  let bad = false;
  const server = createServer((req, res) => {
    calls.push({ path: req.url, key: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (bad) { res.writeHead(503); res.end('{"error":"upstream-secret"}'); return; }
    res.end(JSON.stringify(req.url === '/api/hello' ? { name: 'magpie', version: 'fixture' } : { data: [{ id: 'fixture/model', display_name: 'Fixture' }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const host = fakeHost({ models: [{ id: 'handwritten' }] });
  const manager = new ModelManager(host.ctx, {}, { env: {} });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const result = await manager.handle({ action: 'import', baseURL });
  assert.equal(result.models[0].id, 'fixture/model');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.key === 'Bearer magpie-dsh'));
  assert.deepEqual(host.own.options.config.models, [{ id: 'handwritten' }]);
  bad = true;
  await assert.rejects(manager.handle({ action: 'import', baseURL }), (error) => error.message.includes('503') && !error.message.includes('upstream-secret'));
  assert.equal(host.edits.length, 0);
});
