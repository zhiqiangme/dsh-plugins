/** 可选：对实际下载的 Tiara 源码执行协议回放，验证兼容层与上游 SDK 的组合。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { loadTiaraProxy } from '../lib/tiara-compat.js';

test('实际 Tiara 代理回放：流式文本、外部工具与上游拒绝保持正确协议', {
  skip: !process.env.TIARA_TEST_CURRENT && '需要 TIARA_TEST_CURRENT 指向已下载的 Tiara current 目录',
}, async t => {
  let scenario = 'text', sequence = 0;
  const subscribers = new Set(), sessions = new Map();
  const backend = createServer(async (req, res) => {
    const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    if (req.url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
      subscribers.add(res); req.on('close', () => subscribers.delete(res)); return;
    }
    if (req.url === '/global/health') return json({ healthy: true, version: '1.19.0' });
    if (req.url === '/config/providers') return json({ providers: [{ id: 'opencode', models: { fixture: { name: 'Fixture' } } }] });
    if (req.url === '/config') return json({ plugin: ['file:///test/opencode2api-tool-lock.js'] });
    if (req.url === '/session' && req.method === 'POST') return json({ id: `ses_${++sequence}` });
    const message = /^\/session\/([^/]+)\/message$/.exec(req.url);
    if (message) {
      const sessionID = message[1];
      if (req.method === 'GET') return json(sessions.get(sessionID) || []);
      const content = scenario === 'tool' ? '<function_calls>{"name":"external__echo","arguments":{"text":"OK"}}</function_calls>' : scenario === 'empty' ? '' : 'OK';
      const error = scenario.includes('error') ? { name: 'APIError', data: { message: 'Network rejected by upstream: permission denied', statusCode: 403 } } : null;
      const info = { id: `msg_${sequence}`, sessionID, role: 'assistant', finish: 'stop', time: { completed: Date.now() }, ...(error ? { error } : {}) };
      const part = { id: `part_${sequence}`, sessionID, type: 'text', text: content };
      sessions.set(sessionID, [{ info, parts: error ? [] : [part] }]);
      setTimeout(() => {
        const textEvents = [
          { type: 'message.part.updated', properties: { part } },
          { type: 'message.part.delta', properties: { sessionID, partID: part.id, field: 'text', delta: content } },
        ];
        const events = [...(error && scenario !== 'partial-error' ? [] : textEvents), { type: 'message.updated', properties: { info } }];
        for (const event of events) for (const sub of subscribers) sub.write(`data: ${JSON.stringify(event)}\n\n`);
      }, 40);
      return json({ info, parts: error ? [] : [part] });
    }
    return json({});
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const upstream = await loadTiaraProxy(process.env.TIARA_TEST_CURRENT);
  const reserved = createTcpServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const proxy = upstream.startProxy({ PORT: port, BIND_HOST: '127.0.0.1', API_KEY: 'fixture-key', OPENCODE_SERVER_PASSWORD: 'fixture',
    OPENCODE_SERVER_URL: `http://127.0.0.1:${backend.address().port}`, MANAGE_BACKEND: false, DISABLE_TOOLS: true,
    REQUEST_TIMEOUT_MS: 2000, EVENT_FIRST_DELTA_TIMEOUT_MS: 1000, EVENT_IDLE_TIMEOUT_MS: 1000 });
  if (!proxy.server.listening) await new Promise(resolve => proxy.server.once('listening', resolve));
  t.after(() => { proxy.server.closeAllConnections(); proxy.server.close(); });
  const request = (extra, key = 'fixture-key') => fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/fixture', messages: [{ role: 'user', content: 'Reply OK' }], stream: true, ...extra }),
    signal: AbortSignal.timeout(5000),
  });
  let response = await request();
  let text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /"content":"OK"/); assert.match(text, /\[DONE\]/);
  response = await request({}, 'wrong-local-key');
  assert.equal(response.status, 401, '本地密钥错误仍由本地鉴权正常拒绝');
  scenario = 'error'; response = await request();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-opencode-upstream-status'), '403');
  const body = await response.json(); assert.match(body.error.message, /Network rejected/);
  assert.equal(body.error.code, 'upstream_access_denied');
  assert.doesNotMatch(`${response.status} ${body.error.message}`, /\b(?:401|403)\b/);
  scenario = 'partial-error'; response = await request(); text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /"error":/); assert.match(text, /Network rejected/);
  assert.doesNotMatch(text, /"finish_reason":"stop"|\[DONE\]/);
  scenario = 'empty'; response = await request();
  assert.equal(response.status, 500); assert.match((await response.json()).error.message, /no answer content/);
  scenario = 'tool'; response = await request({ tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }] });
  text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /"tool_calls"/); assert.match(text, /"name":"echo"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
});
