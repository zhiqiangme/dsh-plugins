import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMagpieRouter, requestHasImage, requestedEffort } from '../lib/router.js';
import { ROUTER_PATH } from '../lib/router.js';
import { resolveConfig } from '../lib/config.js';
import { PURPOSE_HEADER, SESSION_HEADER, sessionKey } from '../lib/channel-load.js';

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
  const router = createMagpieRouter({ current: () => config, credentials: () => credentials, env: {}, now: () => clock.now,
    maxBodyBytes: options.maxBodyBytes, firstOutputTimeoutMs: options.firstOutputTimeoutMs, loadQuotas: options.loadQuotas, runningSessions: options.runningSessions });
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

test('同时到达且消息相同的对话逐轮均衡分配，超过渠道总数也不会集中到一个渠道', async (t) => {
  const models = ['a', 'b', 'c'].map((provider) => ({ id: `${provider}/deepseek-flash`, name: 'DeepSeek-Flash' }));
  const held = [];
  let hold = true;
  const { calls, send } = await setup(t, { models, upstream: (_req, res, body) => {
    if (!hold) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ model: body.model })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"working"}}]}\n\n');
    held.push(res);
  } });
  const responses = await Promise.all(Array.from({ length: 8 }, () => send({ ...ask(), stream: true })));
  const counts = ['a', 'b', 'c'].map((provider) => calls.filter((call) => call.body.model.startsWith(`${provider}/`)).length);
  assert.deepEqual(counts, [3, 3, 2], '先各占一个、再各占两个；第八个请求之后仍均衡');
  hold = false;
  for (const res of held) res.end('data: [DONE]\n\n');
  await Promise.all(responses.map((response) => response.text()));
  assert.equal((await (await send(ask())).json()).model, 'a/deepseek-flash', '完成后释放占用');
});

for (const titleHasSession of [true, false]) test(`标题请求${titleHasSession ? '带原会话标识' : '缺少会话标识'}时，不占名额或覆盖主对话渠道，普通 low 请求仍计数`, async (t) => {
  const [main, one, two, three] = ['main', 'one', 'two', 'three'].map(sessionKey);
  const running = new Set([main, one, two, three]);
  const headers = (session, title = false) => ({ authorization: 'Bearer secret', 'content-type': 'application/json',
    ...(session ? { [SESSION_HEADER]: session } : {}), ...(title ? { [PURPOSE_HEADER]: 'session-title' } : {}) });
  let finishTitle;
  const { calls, send, router } = await setup(t, { runningSessions: () => running, upstream: (_req, res, body) => {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"title"}}]}\n\n');
      finishTitle = () => res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  const low = { ...ask(), reasoning_effort: 'low' };
  const selected = async (body, session) => (await (await send(body, { headers: headers(session) })).json()).model;
  assert.equal(await selected({ ...low, model: 'b/deepseek-flash' }, main), 'b/deepseek-flash');
  const title = await send({ ...low, stream: true }, { headers: headers(titleHasSession ? main : undefined, true) });
  assert.equal(calls.at(-1).body.model, 'a/deepseek-flash');
  assert.equal(await selected(low, one), 'a/deepseek-flash', '标题正在执行也不占用 A，主会话仍占 B');
  running.delete(one); router.releaseSession(one);
  finishTitle(); await title.text();
  assert.equal(await selected(low, two), 'a/deepseek-flash', '标题完成后不留下 A 占用，也不把主会话从 B 移到 A');
  assert.equal(await selected(low, main), 'b/deepseek-flash', '同一主会话排除自身占用，仍避开其它对话的 A');
  running.delete(main); router.releaseSession(main);
  assert.equal(await selected(low, three), 'b/deepseek-flash', '普通 low 对话 two 仍占用 A');
  assert.ok(calls.every((call) => call.headers[SESSION_HEADER] === undefined && call.headers[PURPOSE_HEADER] === undefined), '会话摘要及标题用途均不转发给 Magpie 上游');
});

for (const failure of ['400', '503', 'json', 'sse-before', 'sse-after', 'disconnect', 'timeout']) test(`标题 ${failure} 失败不后移主对话渠道，保留本次重试及已输出后不重放规则`, async (t) => {
  let titlePhase = true, finishLate;
  const { calls, send, router } = await setup(t, { firstOutputTimeoutMs: failure === 'timeout' ? 100 : undefined, upstream: (_req, res, body) => {
    if (titlePhase && body.model.startsWith('a/')) {
      if (failure === 'disconnect') return res.destroy();
      if (failure === 'timeout') return;
      if (failure === '400' || failure === '503') { res.writeHead(Number(failure)); return res.end('bad request'); }
      if (failure === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"error":{"status":503,"message":"title failed"}}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (failure === 'sse-after') {
        res.write('data: {"choices":[{"delta":{"content":"partial title"}}]}\n\n');
        finishLate = () => res.end('event: error\ndata: {"error":{"status":503,"message":"title failed"}}\n\n');
        return;
      }
      return res.end('event: error\ndata: {"error":{"status":503,"message":"title failed"}}\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  const title = await send({ ...ask(), reasoning_effort: 'low' }, { headers: {
    authorization: 'Bearer secret', 'content-type': 'application/json', [PURPOSE_HEADER]: 'session-title',
  } });
  finishLate?.();
  const output = await title.text();
  assert.equal(title.status, failure === '400' ? 400 : 200);
  assert.deepEqual(calls.map((call) => call.body.model), failure === '400' || failure === 'sse-after'
    ? ['a/deepseek-flash'] : ['a/deepseek-flash', 'b/deepseek-flash']);
  if (failure === 'sse-after') assert.match(output, /partial title/);
  assert.equal(router.channelStatus().blocked.length, 0);
  titlePhase = false;
  assert.equal((await (await send({ ...ask(), reasoning_effort: 'low' })).json()).model, 'a/deepseek-flash', '标题失败不污染下一次普通 low 对话的顺序');
});

test('标题请求仍遵守明确余额不足当天停用，并避开其它请求已停用的渠道', async (t) => {
  let insufficient = true;
  const { calls, send, router } = await setup(t, { upstream: (_req, res, body) => {
    if (insufficient && body.model.startsWith('a/')) { res.writeHead(400); return res.end('余额不足'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  const titleHeaders = { authorization: 'Bearer secret', 'content-type': 'application/json', [PURPOSE_HEADER]: 'session-title' };
  assert.equal((await (await send(ask(), { headers: titleHeaders })).json()).model, 'b/deepseek-flash');
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  const blocked = router.channelStatus().blocked[0];
  assert.equal(blocked.id, 'a', '明确余额不足并非标题特有错误，仍停用整个渠道');
  assert.equal((await (await send(ask())).json()).model, 'b/deepseek-flash');
  assert.equal((await (await send(ask(), { headers: titleHeaders })).json()).model, 'b/deepseek-flash');
  insufficient = false;
  router.recoverChannel(blocked.id, blocked.token);
  assert.equal((await (await send(ask())).json()).model, 'a/deepseek-flash');
});

for (const bStopped of [false, true]) test(`A 失败时，B 对话${bStopped ? '已停止则改用 B' : '仍在运行工具则改用 C'}`, async (t) => {
  const models = ['a', 'b', 'c'].map((provider) => ({ id: `${provider}/deepseek-flash`, name: 'DeepSeek-Flash' }));
  const a = sessionKey('conversation-a'), b = sessionKey('conversation-b');
  const running = new Set([a, b]);
  const headers = (session) => ({ authorization: 'Bearer secret', 'content-type': 'application/json', [SESSION_HEADER]: session });
  let started, fail;
  const ready = new Promise((resolve) => { started = resolve; });
  const { calls, send, router } = await setup(t, { models, runningSessions: () => running, upstream: (_req, res, body) => {
    if (body.model.startsWith('a/')) {
      fail = () => { res.writeHead(503); res.end('{}'); }; started(); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  // 内容完全相同；只靠宿主真实会话标识区分窗口。
  const pending = send(ask(), { headers: headers(a) });
  await ready;
  assert.equal((await (await send(ask(), { headers: headers(b) })).json()).model, 'b/deepseek-flash');
  if (bStopped) { running.delete(b); router.releaseSession(b); }
  fail();
  assert.equal((await (await pending).json()).model, `${bStopped ? 'b' : 'c'}/deepseek-flash`);
  assert.ok(calls.every((call) => call.headers[SESSION_HEADER] === undefined), '内部会话摘要不转发给 Magpie 上游');
});

test('每小时刷新到期顺序，同时继续避开其它正在运行的对话', async (t) => {
  const models = ['a', 'b', 'c'].map((provider) => ({ id: `${provider}/deepseek-flash`, name: 'DeepSeek-Flash' }));
  const sessions = ['one', 'two', 'three'].map(sessionKey), running = new Set(sessions);
  let reads = 0;
  const { send, clock } = await setup(t, { models, runningSessions: () => running, loadQuotas: async () => {
    const priority = ++reads === 1 ? ['a', 'b', 'c'] : ['c', 'a', 'b'];
    return priority.map((provider, index) => ({ provider, windows: [{ runsOut: 1, runsOutAt: new Date(clock.now + (index + 1) * 86400_000).toISOString() }] }));
  } });
  clock.now = Date.parse('2026-11-16T12:00:00+08:00');
  const askSession = async (id) => (await (await send(ask(), { headers: {
    authorization: 'Bearer secret', 'content-type': 'application/json', [SESSION_HEADER]: id,
  } })).json()).model;
  assert.equal(await askSession(sessions[0]), 'a/deepseek-flash');
  clock.now += 3600_000;
  assert.equal(await askSession(sessions[1]), 'c/deepseek-flash', '到期最早且空闲的 C 被提升');
  assert.equal(await askSession(sessions[2]), 'b/deepseek-flash', 'A、C 被其它对话占用，B 即使到期较晚也优先');
  assert.equal(reads, 2);
});

test('正式版失败仅在正式版渠道间切换，Preview 通过独立模型 ID 调用', async (t) => {
  const models = [
    { id: 'a/qwen4-max', name: 'Qwen4-Max' },
    { id: 'a/qwen4-max-preview', name: 'Qwen4-Max-Preview' },
    { id: 'b/qwen4-max', name: 'Qwen4-Max' },
    { id: 'b/qwen4-max-preview', name: 'Qwen4-Max-Preview' },
  ];
  const { calls, send } = await setup(t, { models, upstream: (_req, res, body) => {
    res.writeHead(body.model.startsWith('a/') ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model }));
  } });
  const normal = await send({ ...ask(), model: 'auto:qwen4-max' });
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).model, 'b/qwen4-max');
  assert.deepEqual(calls.map((call) => call.body.model), ['a/qwen4-max', 'b/qwen4-max']);
  const preview = await send({ ...ask(), model: 'auto:qwen4-max-preview' });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).model, 'b/qwen4-max-preview');
  assert.equal(calls.at(-1).body.model, 'b/qwen4-max-preview');
});

test('失败渠道全局后移，同一对话及其它对话均使用新的默认顺序', async (t) => {
  let failFirst = true;
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    if (failFirst && body.model === 'a/deepseek-flash') { failFirst = false; res.writeHead(503); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  assert.equal((await send(ask())).status, 200);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  assert.equal((await send(ask())).status, 200);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash', '失败的 a 已移到队尾');
  assert.equal((await send(ask('another'))).status, 200);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash', '新对话同样采用全局顺序');
  assert.ok(calls.every((call) => call.path === '/v1/chat/completions'));
});

test('按积分到期默认排序，499 等失败逐个后移渠道，跨对话与跨模型共用，次日重置', async (t) => {
  const providers = ['qoder-cn', 'trae-cn', 'workbuddy'];
  const models = providers.flatMap((provider) => [
    { id: `${provider}/deepseek-flash`, name: 'DeepSeek-Flash' },
    { id: `${provider}/glm-5.3`, name: 'GLM-5.3' },
  ]);
  let fail = true, reads = 0;
  const start = Date.now();
  const f = await setup(t, { models, loadQuotas: async () => {
    reads++;
    return { data: providers.map((provider, index) => ({ provider, windows: [{ runsOut: 2, runsOutAt: new Date(start + (index + 3) * 86400_000).toISOString() }] })) };
  }, upstream: (_req, res, body) => {
    const status = fail && !body.model.startsWith('workbuddy/') ? 499 : 200;
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  assert.equal((await f.send(ask())).status, 499);
  assert.equal(f.calls.at(-1).body.model, 'qoder-cn/deepseek-flash');
  assert.equal((await f.send(ask('another conversation'))).status, 499);
  assert.equal(f.calls.at(-1).body.model, 'trae-cn/deepseek-flash');
  assert.equal((await f.send({ model: 'auto:glm-5.3', messages: [{ role: 'user', content: 'other model' }] })).status, 200);
  assert.equal(f.calls.at(-1).body.model, 'workbuddy/glm-5.3');
  assert.equal(reads, 1);
  fail = false;
  f.clock.now += 24 * 3600_000;
  await f.send(ask());
  assert.equal(reads, 2);
  assert.equal(f.calls.at(-1).body.model, 'qoder-cn/deepseek-flash');
});

for (const status of [400, 401, 403, 499, 529]) test(`上游 HTTP ${status} 失败也会全局后移，不用用户取消来推断状态码`, async (t) => {
  let fail = true;
  const f = await setup(t, { upstream: (_req, res, body) => {
    res.writeHead(fail ? status : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model }));
  } });
  assert.equal((await f.send(ask())).status, status);
  assert.equal(f.calls.length, 1, '不可自动重放的状态仍保留本次原始错误');
  assert.equal(f.router.channelStatus().blocked.length, 0, '没有余额不足提示时只后移，不全天停用');
  fail = false;
  await f.send(ask('new conversation'));
  assert.equal(f.calls.at(-1).body.model, 'b/deepseek-flash');
});

test('HTTP 200 JSON 内的模型错误同样后移，正常 JSON 保持原始字节', async (t) => {
  const raw = '{ "choices": [{"message":{"content":"ok"}}] }\n';
  const f = await setup(t, { upstream: (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body.model.startsWith('a/') ? '{"error":{"status":400,"message":"bad request"}}' : raw);
  } });
  assert.equal((await (await f.send(ask())).json()).error.status, 400);
  assert.equal(f.calls.length, 1, '400 JSON 错误不在本次请求内重放');
  assert.equal(await (await f.send(ask('next conversation'))).text(), raw);
  assert.equal(f.calls.at(-1).body.model, 'b/deepseek-flash');
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

test('思考能力只筛选可用出口，不用旧会话固定覆盖全局渠道顺序', async (t) => {
  const models = [
    { id: 'a/glm-5.3', name: 'GLM-5.3', reasoningEfforts: ['low', 'high'] },
    { id: 'b/glm-5.3', name: 'GLM-5.3', reasoningEfforts: ['low', 'high', 'max'] },
  ];
  const { calls, send } = await setup(t, { models });
  const ask3 = (effort) => ({ model: 'auto:glm-5.3', messages: [{ role: 'user', content: 'same' }], reasoning_effort: effort });
  assert.equal((await send(ask3('Max'))).status, 200);
  assert.equal(calls.at(-1).body.model, 'b/glm-5.3', 'Max 首次选择唯一声明支持的 b');
  assert.equal((await send(ask3('Low'))).status, 200);
  assert.deepEqual(calls.map((call) => call.body.model), ['b/glm-5.3', 'a/glm-5.3'], 'Low 均支持时恢复全局首选 a，不沿用 b 的会话固定');
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

const sse = (res, value) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`);
};
const answer = { choices: [{ delta: { content: 'next supplier' } }] };

for (const [label, status, type, raw] of [
  ['400 中文余额提示', 400, 'application/json', '{"error":{"code":400,"message":"账户余额不足，请充值"}}'],
  ['400 明确错误代码', 400, 'application/json', '{"error":{"code":"insufficient_balance","message":"payment required"}}'],
  ['403 英文余额提示', 403, 'text/plain', 'Your account balance is too low.'],
  ['401 嵌套余额错误', 401, 'application/json', '{"error":{"error":{"message":"Insufficient credits"}}}'],
  ['200 JSON 余额错误', 200, 'application/json', '{"error":{"status":400,"message":"余额不足"}}'],
  ['200 SSE 余额错误', 200, 'text/event-stream', 'event: error\ndata: {"error":{"status":400,"message":"余额不足"}}\n\n'],
  ['200 SSE 纯文本余额错误', 200, 'text/event-stream', 'event: error\ndata: insufficient_balance\n\n'],
]) test(`${label} 在交付前自动换渠道，并停用余额不足的渠道`, async (t) => {
  const { calls, send, router } = await setup(t, { upstream: (_req, res, body) => {
    if (body.model.startsWith('b/')) return sse(res, answer);
    res.writeHead(status, { 'content-type': type }); res.end(raw);
  } });
  assert.match(await (await send(ask())).text(), /next supplier/);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  assert.match(await (await send(ask('next conversation'))).text(), /next supplier/);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash');
  assert.deepEqual(router.channelStatus().blocked.map((row) => row.id), ['a']);
});

test('所有渠道余额不足时只各尝试一次，保留最后一个渠道的 HTTP 状态和原始正文', async (t) => {
  const raw = '{ "error": { "code": "insufficient_balance", "message": "余额不足" } }\n';
  const { calls, send, router } = await setup(t, { upstream: (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(raw);
  } });
  const response = await send(ask());
  assert.equal(response.status, 400);
  assert.equal(await response.text(), raw);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  assert.equal(router.channelStatus().blocked.length, 2);
  assert.equal((await send(ask())).status, 503, '后续请求不再重复调用已停用的渠道');
  assert.equal(calls.length, 2);
});

test('余额不足跳过同渠道其它出口及其它模型，手动恢复后才重新选择', async (t) => {
  const models = [TWO_ROUTES[0], { id: 'a/alias', name: 'DeepSeek-Flash' }, TWO_ROUTES[1],
    { id: 'a/glm-5.3', name: 'GLM-5.3' }, { id: 'b/glm-5.3', name: 'GLM-5.3' }];
  let insufficient = true;
  const { calls, send, router } = await setup(t, { models, upstream: (_req, res, body) => {
    if (insufficient && body.model.startsWith('a/')) { res.writeHead(400); return res.end('余额不足'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  assert.equal((await send(ask())).status, 200);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  assert.equal((await (await send({ ...ask(), model: 'auto:glm-5.3' })).json()).model, 'b/glm-5.3');
  const blocked = router.channelStatus().blocked[0];
  insufficient = false;
  router.recoverChannel(blocked.id, blocked.token);
  assert.equal((await (await send(ask())).json()).model, 'a/deepseek-flash');
});

test('普通 402 可以重试但不等同明确余额不足，不停用渠道', async (t) => {
  const { send, router } = await setup(t, { upstream: (_req, res, body) => {
    res.writeHead(body.model.startsWith('a/') ? 402 : 200, { 'content-type': 'application/json' }); res.end('{}');
  } });
  assert.equal((await send(ask())).status, 200);
  assert.equal(router.channelStatus().blocked.length, 0);
});

test('恢复选择后，恢复前的并发余额不足结果不重新停用渠道', async (t) => {
  let started, release, callsToA = 0;
  const ready = new Promise((resolve) => { started = resolve; });
  const { send, router } = await setup(t, { upstream: (_req, res, body) => {
    if (body.model.startsWith('a/')) {
      callsToA++;
      const failure = () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"余额不足"}}'); };
      if (callsToA === 1) { release = failure; started(); return; }
      if (callsToA === 2) return failure();
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model }));
  } });
  const pending = send(ask('old in-flight call'));
  await ready;
  assert.equal((await send({ ...ask('second call'), model: 'a/deepseek-flash' })).status, 400);
  const blocked = router.channelStatus().blocked[0];
  router.recoverChannel(blocked.id, blocked.token);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(router.channelStatus().blocked.length, 0);
  assert.equal((await (await send(ask('new call after recovery'))).json()).model, 'a/deepseek-flash');
});

test('余额不足停用到北京时间 04:00，跨电脑日期和北京时间午夜均不提前恢复', async (t) => {
  let insufficient = true;
  const { calls, send, router, clock } = await setup(t, { models: [TWO_ROUTES[0]], upstream: (_req, res) => {
    res.writeHead(insufficient ? 400 : 200, { 'content-type': 'application/json' }); res.end(insufficient ? '{"error":{"message":"余额不足"}}' : '{}');
  } });
  clock.now = Date.parse('2026-11-16T23:59:59+08:00');
  assert.equal((await send(ask())).status, 400);
  insufficient = false;
  clock.now = Date.parse('2026-11-17T00:00:00+08:00');
  assert.equal((await send(ask())).status, 503);
  clock.now = Date.parse('2026-11-17T03:59:59+08:00');
  assert.equal((await send(ask())).status, 503);
  assert.equal(calls.length, 1);
  clock.now = Date.parse('2026-11-17T04:00:00+08:00');
  assert.equal(router.channelStatus().blocked.length, 0);
  assert.equal((await send(ask())).status, 200);
  assert.equal(calls.length, 2);
});

test('正常 JSON 和流式回答提及余额不足不触发切换', async (t) => {
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    const value = { choices: [{ message: { content: 'HTTP 400 不一定代表余额不足或 insufficient balance' } }] };
    if (body.stream) return sse(res, value);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  } });
  for (const stream of [false, true]) assert.match(await (await send({ ...ask(), stream })).text(), /余额不足/);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'a/deepseek-flash']);
});

test('已交付输出后出现余额不足不重放，下一次调用再换渠道', async (t) => {
  let fail;
  const { calls, send, router } = await setup(t, { upstream: (_req, res, body) => {
    if (body.model.startsWith('b/')) return sse(res, answer);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
    fail = () => res.end('event: error\ndata: {"error":{"status":400,"message":"余额不足"}}\n\n');
  } });
  const response = await send({ ...ask(), stream: true });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /started/);
  fail();
  let tail = '';
  for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.match(tail, /余额不足/);
  assert.equal(calls.length, 1);
  assert.deepEqual(router.channelStatus().blocked.map((row) => row.id), ['a']);
  assert.match(await (await send(ask())).text(), /next supplier/);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash');
});

test('收到 200、角色帧和持续心跳仍受首个有效输出期限约束，一次超时即换供应商', async (t) => {
  let canceled = false;
  const { calls, send, clock } = await setup(t, { firstOutputTimeoutMs: 300, upstream: (_req, res, body) => {
    if (body.model.startsWith('b/')) return sse(res, answer);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n');
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15);
    res.on('close', () => { canceled = true; clearInterval(heartbeat); });
  } });
  const response = await send({ ...ask(), stream: true });
  assert.match(await response.text(), /next supplier/);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  // 分钟级等待不会恢复失败渠道的优先级；它保持在队尾直到每日重新排序。
  clock.now += 31_000;
  assert.match(await (await send({ ...ask(), stream: true })).text(), /next supplier/);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash');
  assert.equal(canceled, true, '切换时取消仍在等待的上游请求');
});

test('失败后先尝试其它供应商，再考虑同供应商的另一个出口', async (t) => {
  const models = [TWO_ROUTES[0], { ...TWO_ROUTES[0], id: 'a/deepseek-flash-auto' }, TWO_ROUTES[1]];
  const { calls, send } = await setup(t, { models, upstream: (_req, res) => { res.writeHead(503); res.end('{}'); } });
  assert.equal((await send(ask())).status, 503);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash', 'a/deepseek-flash-auto']);
});

const STREAM_PROTOCOLS = [
  { api: 'openai-completions', error: 'data: {"error":{"code":"rate_limit_exceeded","message":"failed route"}}\n\n',
    output: 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n' },
  { api: 'openai-responses', error: 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error","message":"failed route"}}}\n\n',
    output: 'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n' },
  { api: 'anthropic-messages', error: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"failed route"}}\n\n',
    output: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"thinking"}}\n\n' },
];
for (const { api, error, output } of STREAM_PROTOCOLS) {
  test(`${api} 的 HTTP 200 流内错误在尚无输出时立即换供应商`, async (t) => {
    const { calls, send } = await setup(t, { api, upstream: (_req, res, body) => {
      if (body.model.startsWith('b/')) return sse(res, answer);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // error 后不主动结束，路由也应立即识别并取消，不能等待下游 300 秒超时。
      res.write(error);
    } });
    const response = await send({ ...ask(), stream: true });
    const raw = await response.text();
    assert.match(raw, /next supplier/); assert.doesNotMatch(raw, /failed route/);
    assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
  });

  test(`${api} 的推理输出会解除期限，开始生成后允许长时间继续输出`, async (t) => {
    const { calls, send } = await setup(t, { api, firstOutputTimeoutMs: 200, upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(output);
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 350);
      res.on('close', () => clearTimeout(timer));
    } });
    const response = await send({ ...ask(), stream: true });
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.equal(first, output, '推理帧即时交付');
    let tail = '';
    for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
    assert.equal(tail, 'data: [DONE]\n\n');
    assert.equal(calls.length, 1);
  });
}

for (const [type, status] of [['invalid_request_error', 400], ['authentication_error', 401], ['permission_error', 403]]) {
  test(`HTTP 200 流内 ${status} 错误保留原文，不跨供应商重放`, async (t) => {
    const raw = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: 'do not replay' } })}\n\n`;
    const { calls, send } = await setup(t, { upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(raw);
    } });
    const response = await send({ ...ask(), stream: true });
    assert.equal(await response.text(), raw);
    assert.equal(calls.length, 1);
  });
}

test('只有空帧后结束的流不算成功回答，应换下一个出口', async (t) => {
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    if (body.model.startsWith('b/')) return sse(res, answer);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(': heartbeat\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n');
  } });
  assert.match(await (await send({ ...ask(), stream: true })).text(), /next supplier/);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
});

test('已交付工具调用后遇到流内错误不重放，失败渠道后移供下一次调用使用', async (t) => {
  let fail;
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    if (body.model.startsWith('b/')) return sse(res, answer);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run","arguments":""}}]}}]}\n\n');
    fail = () => res.write('event: error\ndata: {"error":{"status":503,"message":"late failure"}}\n\n');
  } });
  const response = await send({ ...ask(), stream: true });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /tool_calls/);
  fail();
  let tail = '';
  for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.match(tail, /late failure/);
  assert.equal(calls.length, 1, '已交付工具不能在本次请求内部重放');
  assert.match(await (await send({ ...ask(), stream: true })).text(), /next supplier/);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'b/deepseek-flash']);
});

test('已开始输出的上游断连会后移渠道，下一次重试换出口', async (t) => {
  let disconnect;
  const { calls, send } = await setup(t, { upstream: (_req, res, body) => {
    if (body.model.startsWith('b/')) return sse(res, answer);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    disconnect = () => res.destroy();
  } });
  const response = await send({ ...ask(), stream: true });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /partial/);
  disconnect();
  await assert.rejects(async () => { while (!(await reader.read()).done) {} });
  assert.equal(calls.length, 1, '断连发生在输出后，不在原请求内重放');
  assert.match(await (await send({ ...ask(), stream: true })).text(), /next supplier/);
  assert.equal(calls.at(-1).body.model, 'b/deepseek-flash');
});

test('下游主动取消不当作供应商故障，也不改变全局渠道顺序', async (t) => {
  let started, canceled;
  const ready = new Promise((resolve) => { started = resolve; });
  const closed = new Promise((resolve) => { canceled = resolve; });
  let waiting = true;
  const { calls, send, router } = await setup(t, { upstream: (_req, res) => {
    if (!waiting) return sse(res, answer);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n');
    res.on('close', canceled); started();
  } });
  const controller = new AbortController();
  const pending = send({ ...ask(), stream: true }, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await closed;
  waiting = false;
  assert.match(await (await send({ ...ask(), stream: true })).text(), /next supplier/);
  assert.deepEqual(calls.map((call) => call.body.model), ['a/deepseek-flash', 'a/deepseek-flash']);
  assert.equal(router.channelStatus().blocked.length, 0);
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
