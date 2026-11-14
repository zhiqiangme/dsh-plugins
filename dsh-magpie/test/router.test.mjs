import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMagpieRouter, requestHasImage, requestedEffort } from '../lib/router.js';
import { ROUTER_PATH } from '../lib/router.js';
import { resolveConfig } from '../lib/config.js';

const ENDPOINTS = { 'openai-completions': 'chat/completions', 'openai-responses': 'responses', 'anthropic-messages': 'messages' };
const TWO_ROUTES = [
  { id: 'a/deepseek-flash', name: 'DeepSeek-Flash', input: ['text', 'image'], reasoningEfforts: ['low', 'high'] },
  { id: 'b/deepseek-flash', name: 'DeepSeek-Flash', reasoningEfforts: ['low'] },
];
const ask = (text = 'hello') => ({ model: 'auto:deepseek-v4.1-flash', messages: [{ role: 'user', content: text }] });

async function setup(t, options = {}) {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    calls.push({ path: req.url, body, headers: req.headers });
    if (options.upstream) return options.upstream(req, res, body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let config = resolveConfig({
    syncEnabled: true, autoRoute: true, api: options.api ?? 'openai-completions',
    baseURL: `http://127.0.0.1:${upstream.address().port}`, models: options.models ?? TWO_ROUTES,
  });
  const clock = { now: Date.now() };
  const credentials = { resolve: async () => ({ value: 'secret' }) };
  const router = createMagpieRouter({ current: () => config, credentials: () => credentials, env: {}, now: () => clock.now, maxBodyBytes: options.maxBodyBytes });
  const proxy = createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    router.stop(); upstream.closeAllConnections(); proxy.closeAllConnections();
    return Promise.all([new Promise((resolve) => upstream.close(resolve)), new Promise((resolve) => proxy.close(resolve))]);
  });
  const url = `http://127.0.0.1:${proxy.address().port}${ROUTER_PATH}`;
  const send = (body, extra = {}) => fetch(`${url}/${ENDPOINTS[config.api]}`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra,
  });
  return { calls, send, router, url, clock, setConfig: (next) => { config = resolveConfig(next); } };
}

test('按清单顺序选路，失败切换并固定同一对话，其它对话不受冷却影响', async (t) => {
  let failFirst = true;
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    if (failFirst && body.model === 'a/deepseek-flash') { failFirst = false; res.writeHead(503); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  assert.equal((await send(ask())).status, 200);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  assert.equal((await send(ask())).status, 200);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash', '同一对话固定到成功出口');
  assert.equal((await send(ask('another'))).status, 200);
  assert.equal(calls.at(-1).body.model, 'a/deepseek-flash', '其它对话仍从清单首选开始');
  assert.ok(calls.every((call) => call.path === '/v1/chat/completions'));
});

test('图片请求跳过不支持视觉的出口，Responses 与 Anthropic 图片结构同样识别', async (t) => {
  const models = [{ ...TWO_ROUTES[0], input: ['text'] }, { ...TWO_ROUTES[1], input: ['text', 'image'] }];
  const { calls, send } = await setup(t, { models });
  const body = ask(); body.messages[0].content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }];
  assert.equal((await send(body)).status, 200);
  assert.deepEqual(calls.map((call) => call.body.model), ['b/deepseek-flash']);
  assert.equal(requestHasImage({ input: [{ role: 'user', content: [{ type: 'input_image' }] }] }), true);
  assert.equal(requestHasImage({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), true);
  assert.equal(requestHasImage(ask()), false);
});

test('按请求的思考档位优先选声明支持的出口，都不支持时仍按清单顺序尝试', async (t) => {
  const models = [
    { id: 'a/glm-5.3', name: 'GLM-5.3', reasoningEfforts: ['low', 'high'] },
    { id: 'b/glm-5.3', name: 'GLM-5.3', reasoningEfforts: ['low', 'high', 'max'] },
  ];
  const { calls, send } = await setup(t, { models });
  const ask3 = (text) => ({ model: 'auto:glm-5.3', messages: [{ role: 'user', content: text }] });
  assert.equal((await send({ ...ask3('one'), reasoning_effort: 'Max' })).status, 200);
  assert.equal(calls.at(-1).body.model, 'b/glm-5.3', '只有 b 声明 max');
  assert.equal((await send({ ...ask3('two'), reasoning: { effort: 'high' } })).status, 200);
  assert.equal(calls.at(-1).body.model, 'a/glm-5.3', '都声明 high 时保持清单顺序');
  // off 是关闭思考，各出口都接受，不改变优先级。
  assert.equal((await send({ ...ask3('three'), reasoning_effort: 'off' })).status, 200);
  assert.equal(calls.at(-1).body.model, 'a/glm-5.3');
  assert.equal(requestedEffort({ reasoning_effort: ' Max ' }), 'max');
  assert.equal(requestedEffort({ reasoning: { effort: 'low' } }), 'low');
  assert.equal(requestedEffort({}), '');
});

test('无失败冷却时，同一首条用户消息跨思考档位仍固定成功出口', async (t) => {
  const models = [
    { id: 'a/glm-5.3', name: 'GLM-5.3', reasoningEfforts: ['low', 'high'] },
    { id: 'b/glm-5.3', name: 'GLM-5.3', reasoningEfforts: ['low', 'high', 'max'] },
  ];
  const { calls, send } = await setup(t, { models });
  const ask3 = (effort) => ({ model: 'auto:glm-5.3', messages: [{ role: 'user', content: 'same' }], reasoning_effort: effort });
  assert.equal((await send(ask3('Max'))).status, 200);
  assert.equal(calls.at(-1).body.model, 'b/glm-5.3', 'Max 首次选择唯一声明支持的 b');
  assert.equal((await send(ask3('Low'))).status, 200);
  assert.deepEqual(calls.map((call) => call.body.model), ['b/glm-5.3', 'b/glm-5.3'], 'Low 重排候选时仍优先固定到 b');
});

for (const api of Object.keys(ENDPOINTS)) test(`协议 ${api} 转发到真实端点并还原模型 ID`, async (t) => {
  const { calls, send } = await setup(t, { api, models: [TWO_ROUTES[0]] });
  const headers = api === 'anthropic-messages' ? { 'x-api-key': 'secret', 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2024-05-16' } : undefined;
  assert.equal((await send(ask(), headers ? { headers } : {})).status, 200);
  assert.equal(calls[0].path, `/v1/${ENDPOINTS[api]}`);
  assert.equal(calls[0].body.model, 'a/deepseek-flash');
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  if (api === 'anthropic-messages') {
    assert.equal(calls[0].headers['x-api-key'], 'secret');
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].headers['anthropic-beta'], 'tools-2024-05-16');
  }
});

test('SSE 首块即时返回；上游 400 不跨出口重放且保留错误正文', async (t) => {
  let finish;
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      finish = () => res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad request"}}');
  } });
  const response = await send({ ...ask(), stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /first/); assert.doesNotMatch(first, /DONE/);
  finish();
  let tail = '';
  for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.equal(tail, 'data: [DONE]\n\n');
  const bad = await send(ask('bad'));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { message: 'bad request' } });
  assert.equal(calls.filter((call) => !call.body.stream).length, 1, '400 不重放到第二出口');
});

test('本机鉴权、请求来源、未知模型、非法路径与请求体上限', async (t) => {
  const { calls, send, url } = await setup(t, { maxBodyBytes: 120 });
  assert.equal((await send(ask(), { headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' } })).status, 401);
  assert.equal((await send(ask(), { headers: { authorization: 'Bearer secret', 'content-type': 'application/json', origin: 'http://evil.test' } })).status, 403);
  assert.equal((await send({ ...ask(), model: 'auto:missing' })).status, 404);
  assert.equal((await send({ model: 'auto:deepseek-v4.1-flash', messages: ['x'.repeat(200)] })).status, 413);
  assert.equal((await fetch(`${url}/other`, { headers: { authorization: 'Bearer secret' } })).status, 404);
  assert.equal(calls.length, 0);
});

test('关闭自动路由或同步后不再接受调用', async (t) => {
  const { calls, send, setConfig } = await setup(t);
  setConfig({ syncEnabled: false, autoRoute: true, baseURL: 'http://127.0.0.1:3425', models: TWO_ROUTES });
  assert.equal((await send(ask())).status, 503);
  setConfig({ syncEnabled: true, autoRoute: false, baseURL: 'http://127.0.0.1:3425', models: TWO_ROUTES });
  assert.equal((await send(ask())).status, 503);
  assert.equal(calls.length, 0);
});
