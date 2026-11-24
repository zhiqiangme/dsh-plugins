import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWebProxy, injectProxyBootstrap, rewriteLocation, WEB_UI_PREFIX } from '../lib/web-proxy.js';
import { rejection } from '../lib/web.js';
import { ModelManager } from '../lib/runtime.js';
import { fakeHost } from '../fixtures/host.mjs';
import { backendFixture } from '../fixtures/backend.mjs';

const SECRET_KEY = 'fixture-magpie-web-secret-key-9876543210';

async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

test('injectProxyBootstrap 注入的引导脚本仅重写根路径 API/SSE/History，保留相对路径与外链', () => {
  const html = injectProxyBootstrap('<!doctype html><html><head><title>Magpie</title></head><body><script src="boot.js"></script></body></html>');
  const script = html.match(/<script data-dsh-magpie-proxy>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, '应注入引导脚本');
  assert.ok(html.indexOf('<script data-dsh-magpie-proxy>') < html.indexOf('<title>'), '脚本应位于 head 最前面');

  const fetched = [], opened = [], events = [], histories = [];
  const origin = 'http://127.0.0.1:9876';
  const sandbox = {
    location: { origin },
    fetch: (input) => { fetched.push(input); return Promise.resolve(); },
    XMLHttpRequest: { prototype: { open(_m, url) { opened.push(url); } } },
    EventSource: function FakeES(url) { events.push(url); },
    history: {
      pushState(_s, _t, url) { histories.push(['push', url]); },
      replaceState(_s, _t, url) { histories.push(['replace', url]); },
    },
  };
  sandbox.window = sandbox;
  new Function('window', 'location', 'XMLHttpRequest', 'history', script)(sandbox, sandbox.location, sandbox.XMLHttpRequest, sandbox.history);

  sandbox.fetch('/api/providers');
  sandbox.fetch('api/providers');
  sandbox.fetch(`${WEB_UI_PREFIX}/api/providers`);
  sandbox.fetch(`${origin}/api/settings`);
  sandbox.fetch('https://example.com/api');
  sandbox.XMLHttpRequest.prototype.open('GET', '/api/status');
  sandbox.XMLHttpRequest.prototype.open('GET', 'plugins/routing/data.json');
  new sandbox.EventSource('/api/events');
  new sandbox.EventSource('api/events');
  sandbox.history.replaceState(null, '', '/?view=routing');
  sandbox.history.pushState(null, '', '?view=usage');
  sandbox.history.pushState(null, '', '/routing');
  sandbox.history.pushState(null, '', `${WEB_UI_PREFIX}/?view=models`);

  assert.deepEqual(fetched, [
    `${WEB_UI_PREFIX}/api/providers`,
    'api/providers',
    `${WEB_UI_PREFIX}/api/providers`,
    `${origin}${WEB_UI_PREFIX}/api/settings`,
    'https://example.com/api',
  ]);
  assert.deepEqual(opened, [`${WEB_UI_PREFIX}/api/status`, 'plugins/routing/data.json']);
  assert.deepEqual(events, [`${WEB_UI_PREFIX}/api/events`, 'api/events']);
  assert.deepEqual(histories, [
    ['replace', `${WEB_UI_PREFIX}/?view=routing`],
    ['push', '?view=usage'],
    ['push', `${WEB_UI_PREFIX}/routing`],
    ['push', `${WEB_UI_PREFIX}/?view=models`],
  ]);
});

test('rewriteLocation 仅重写上游同源或根路径跳转，不改动外链或已带前缀地址', () => {
  assert.equal(rewriteLocation('http://127.0.0.1:3430/?view=routing', 'http://127.0.0.1:3430'), `${WEB_UI_PREFIX}/?view=routing`);
  assert.equal(rewriteLocation('/?view=models', 'http://127.0.0.1:3430'), `${WEB_UI_PREFIX}/?view=models`);
  assert.equal(rewriteLocation(`${WEB_UI_PREFIX}/?view=models`, 'http://127.0.0.1:3430'), `${WEB_UI_PREFIX}/?view=models`);
  assert.equal(rewriteLocation('https://usemagpie.ai/docs', 'http://127.0.0.1:3430'), 'https://usemagpie.ai/docs');
});

test('同源反代校验宿主会话、补全尾斜杠、代持登录 Cookie、剥离防嵌入头、自动 401 重登并透传 SSE', async (t) => {
  let cookieVersion = 1;
  let loginCount = 0;
  let sseAborted = false;
  const upstreamCalls = [];

  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const port = upstream.address().port;
    const expectedCookie = `magpie_web_${port}=token-v${cookieVersion}`;
    if (url.pathname === '/' && url.searchParams.get('k') === SECRET_KEY) {
      loginCount++;
      res.writeHead(303, { 'set-cookie': `${expectedCookie}; Path=/; HttpOnly; SameSite=Lax`, location: '/' });
      return res.end();
    }
    if (req.headers.cookie !== expectedCookie) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('unauthorized');
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    upstreamCalls.push({ method: req.method, path: url.pathname + url.search, origin: req.headers.origin, body: bodyText });

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'set-cookie': `magpie_web_${port}=leak-attempt; Path=/`,
      });
      return res.end('<!doctype html><html><head><title>Magpie</title></head><body><script src="boot.js"></script></body></html>');
    }
    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ echoed: JSON.parse(bodyText), cookieVersion }));
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/?view=routing' });
      return res.end();
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"ok":true}\n\n');
      res.on('close', () => { if (!res.writableEnded) sseAborted = true; });
      return;
    }
    res.writeHead(404).end('missing');
  });
  const upstreamPort = await listen(t, upstream);

  const f = backendFixture(t);
  mkdirSync(dirname(f.backend.paths.settings), { recursive: true });
  writeFileSync(join(dirname(f.backend.paths.settings), 'web-page.json'), JSON.stringify({ mode: 'local', port: upstreamPort, key: SECRET_KEY }));

  const host = fakeHost();
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend: f.backend });
  const handler = createWebProxy(host.ctx, manager, { reject: rejection });
  const proxyServer = createServer((req, res) => handler(req, res));
  const proxyPort = await listen(t, proxyServer);
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  // 跨站请求被拒绝。
  const denied = await fetch(`${proxyBase}${WEB_UI_PREFIX}/`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(denied.status, 403);

  // 缺尾斜杠时 302 补全并保留查询参数。
  const slashRedirect = await fetch(`${proxyBase}${WEB_UI_PREFIX}?view=routing`, { redirect: 'manual' });
  assert.equal(slashRedirect.status, 302);
  assert.equal(slashRedirect.headers.get('location'), `${WEB_UI_PREFIX}/?view=routing`);

  // HTML 正常加载、剥离防嵌入头和 Set-Cookie、注入前缀脚本、不泄露密钥。
  const page = await fetch(`${proxyBase}${WEB_UI_PREFIX}/?view=routing`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.equal(page.headers.get('content-security-policy'), null);
  assert.equal(page.headers.get('set-cookie'), null);
  const html = await page.text();
  assert.ok(html.includes('<script data-dsh-magpie-proxy>'));
  assert.equal(html.includes(SECRET_KEY), false);
  assert.equal(loginCount, 1);

  // 重定向头重写到前缀内。
  const redir = await fetch(`${proxyBase}${WEB_UI_PREFIX}/redirect`, { redirect: 'manual' });
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get('location'), `${WEB_UI_PREFIX}/?view=routing`);

  // 上游重启换 Cookie 后返回 401，代理自动重登并重放 POST 请求体。
  cookieVersion = 2;
  const posted = await fetch(`${proxyBase}${WEB_UI_PREFIX}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'magpie' }),
  });
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { echoed: { hello: 'magpie' }, cookieVersion: 2 });
  assert.equal(loginCount, 2);

  // SSE 流式透传并在客户端中止时断开上游。
  const sseAbort = new AbortController();
  const sse = await fetch(`${proxyBase}${WEB_UI_PREFIX}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: sseAbort.signal,
  });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  const reader = sse.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString('utf8'), 'data: {"ok":true}\n\n');
  sseAbort.abort();
  await reader.cancel().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sseAborted, true);

  // 切到远程网关时拒绝反代。
  host.own.options.config.baseURL = 'https://magpie.example.com';
  const remoteBlocked = await fetch(`${proxyBase}${WEB_UI_PREFIX}/`);
  assert.equal(remoteBlocked.status, 403);
  assert.equal(upstreamCalls.every((c) => c.origin === `http://127.0.0.1:${upstreamPort}`), true);
});
