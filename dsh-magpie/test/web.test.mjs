import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handlerFor, rejection } from '../lib/web.js';
import { ModelManager } from '../lib/runtime.js';
import { fakeHost } from '../fixtures/host.mjs';
import { backendFixture, finish } from '../fixtures/backend.mjs';

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
  const initial = await manager.describe();
  const result = await call('POST', { action: 'sync-catalog', revision: initial.revision, config: { ...initial.config, baseURL } }, {}, manager);
  assert.equal(result.status, 200);
  assert.equal(result.body.config.models[0].id, 'fixture/model');
  assert.equal(result.body.saved, true);
  assert.equal(result.body.sync.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.key === 'Bearer magpie-dsh'));
  assert.equal(host.own.options.config.models[0].id, 'fixture/model');
  const before = structuredClone([host.own.options.config, host.llm.options.config]);
  const edits = host.edits.length;
  bad = true;
  const failed = await call('POST', { action: 'sync-catalog', revision: result.body.revision, config: result.body.config }, {}, manager);
  assert.equal(failed.status, 400);
  assert.match(failed.body.reason, /503/);
  assert.equal(failed.body.reason.includes('upstream-secret'), false);
  assert.deepEqual([host.own.options.config, host.llm.options.config], before);
  assert.equal(host.edits.length, edits);
});

test('程序管理沿用会话与 JSON 校验，检查不改模型，安装异步返回，状态可查询', async (t) => {
  const { backend } = backendFixture(t);
  const host = fakeHost({ models: [{ id: 'manual', name: 'keep' }] });
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend });
  const before = structuredClone(host.own.options.config);
  const denied = await call('POST', { action: 'backend-install' }, { origin: 'https://evil.example' }, manager);
  assert.equal(denied.status, 403);
  assert.equal(backend.operation, null);
  assert.equal((await call('POST', '{}', { 'content-type': 'text/plain' }, manager)).status, 415);
  assert.equal((await call('POST', { action: 'backend-check', magpiePath: 'relative.exe' }, {}, manager)).status, 400);
  const checked = await call('POST', { action: 'backend-check' }, {}, manager);
  assert.equal(checked.body.backend.latest.version, '0.1.2');
  assert.deepEqual(host.own.options.config, before);
  const accepted = await call('POST', { action: 'backend-install' }, {}, manager);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.backend.operation.running, true);
  await finish(backend);
  const status = await call('POST', { action: 'backend-status' }, {}, manager);
  assert.equal(status.body.backend.version, '0.1.2');
  assert.equal(status.body.backend.operation.phase, 'installed');
  assert.deepEqual(host.own.options.config, before);
  assert.deepEqual(host.edits, []);
});
