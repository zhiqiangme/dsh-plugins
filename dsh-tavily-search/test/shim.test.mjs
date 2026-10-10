/**
 * 适配服务自测（移植自旧 tavily-anthropic-search/selftest.js）：不依赖真实 Tavily key，
 * 用本地 mock 校验请求解析、响应结构（DSH 解析器契约）与错误路径；
 * 另加两条本插件新增的行为：key 每次请求现取、缺 key 时返回明确错误。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createShimServer, extractQuery, parseSearchRequest, SHIM_DEFAULTS } from '../lib/shim.js';
import { dshBody, okTavily, post, startMockTavily } from './helpers.mjs';

async function startShim(mockPort, overrides = {}) {
  const server = createShimServer({
    tavilyBaseUrl: `http://127.0.0.1:${mockPort}`,
    maxResults: 8,
    resolveApiKey: async () => 'tvly-test',
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function setup(t, handler, overrides) {
  const scenario = { requests: [], handler };
  const mock = await startMockTavily(scenario);
  const shim = await startShim(mock.port, overrides);
  t.after(() => {
    shim.server.close();
    mock.server.close();
  });
  return { scenario, shim };
}

test('DSH 前缀查询被正确剥离，响应满足解析器契约', async (t) => {
  const { scenario, shim } = await setup(
    t,
    okTavily([
      { title: 'DeepSeek V4 发布', url: 'https://example.com/a', content: '摘要 A', published_date: '2026-09-01' },
      { title: 'DeepSeek 官网', url: 'https://example.com/b', content: '摘要 B' },
    ]),
  );

  const { status, json } = await post(shim.base, '/v1/messages', dshBody);
  assert.equal(status, 200);

  // 请求侧：Tavily 收到的就是剥离后的检索词
  assert.equal(scenario.requests[0].body.query, 'DeepSeek V4 发布时间');
  assert.equal(scenario.requests[0].auth, 'Bearer tvly-test');

  // 响应侧：DSH 解析器只认 content[] 里的 web_search_result 条目
  assert.equal(json.type, 'message');
  assert.equal(json.role, 'assistant');
  assert.equal(json.model, 'deepseek-v4-flash');
  assert.equal(json.stop_reason, 'end_turn');
  const [toolUse, toolResult, text] = json.content;
  assert.equal(toolUse.type, 'server_tool_use');
  assert.equal(toolUse.name, 'web_search');
  assert.deepEqual(toolUse.input, { query: 'DeepSeek V4 发布时间' });
  assert.equal(toolResult.type, 'web_search_tool_result');
  assert.equal(toolResult.tool_use_id, toolUse.id);
  assert.ok(Array.isArray(toolResult.content), '结果条目必须挂在 content[] 下');
  assert.deepEqual(
    toolResult.content.map((item) => item.url),
    ['https://example.com/a', 'https://example.com/b'],
  );
  assert.equal(toolResult.content[0].type, 'web_search_result');
  assert.equal(toolResult.content[0].title, 'DeepSeek V4 发布');
  assert.equal(toolResult.content[0].page_age, '2026-09-01');
  assert.equal(toolResult.content[1].page_age, undefined);

  // snippet 只能来自 text 块的 citations，按 url 关联
  assert.equal(text.type, 'text');
  assert.deepEqual(text.citations.map((c) => c.cited_text), ['摘要 A', '摘要 B']);
  assert.deepEqual(text.citations.map((c) => c.url), ['https://example.com/a', 'https://example.com/b']);

  assert.equal(json.usage.server_tool_use.web_search_requests, 1);
});

test('无 DSH 前缀的纯文本同样可提取检索词，重复 URL 去重', async (t) => {
  const { scenario, shim } = await setup(
    t,
    okTavily([
      { title: '同一页', url: 'https://example.com/dup', content: '第一次' },
      { title: '同一页', url: 'https://example.com/dup', content: '第二次' },
    ]),
  );

  const { status, json } = await post(shim.base, '/anthropic/v1/messages', {
    ...dshBody,
    messages: [{ role: 'user', content: 'rust async 运行时对比' }],
  });
  assert.equal(status, 200);
  assert.equal(scenario.requests[0].body.query, 'rust async 运行时对比');
  assert.equal(json.content[1].content.length, 1);
  assert.equal(json.content[2].citations[0].cited_text, '第一次');
});

test('缺少 web_search 工具、空查询、超长查询、非法 max_uses 均 400，且不查询 Tavily', async (t) => {
  const { scenario, shim } = await setup(t, okTavily([]));

  const noTool = await post(shim.base, '/v1/messages', { ...dshBody, tools: [] });
  assert.equal(noTool.status, 400);
  assert.equal(noTool.json.type, 'error');

  const empty = await post(shim.base, '/v1/messages', {
    ...dshBody,
    messages: [{ role: 'user', content: 'Perform a web search for the query:   ' }],
  });
  assert.equal(empty.status, 400);

  const long = await post(shim.base, '/v1/messages', {
    ...dshBody,
    messages: [{ role: 'user', content: 'x'.repeat(700) }],
  });
  assert.equal(long.status, 400);

  const badUses = await post(shim.base, '/v1/messages', {
    ...dshBody,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 0 }],
  });
  assert.equal(badUses.status, 400);

  assert.equal(scenario.requests.length, 0, '请求被拒绝时不应查询 Tavily');
});

test('Tavily 故障返回 Anthropic 错误信封 502，超时同样 502', async (t) => {
  const failed = await setup(t, (_req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  const failure = await post(failed.shim.base, '/v1/messages', dshBody);
  assert.equal(failure.status, 502);
  assert.equal(failure.json.type, 'error');
  assert.match(failure.json.error.message, /HTTP 500/);

  const slow = await setup(t, () => {}, { timeoutMs: 150 });
  const timedOut = await post(slow.shim.base, '/v1/messages', dshBody);
  assert.equal(timedOut.status, 502);
  assert.match(timedOut.json.error.message, /超时/);
});

test('shimApiKey 非空时校验调用方凭据', async (t) => {
  const { shim } = await setup(t, okTavily([]), { shimApiKey: 'secret' });

  const anonymous = await fetch(`${shim.base}/v1/messages`, { method: 'POST', body: JSON.stringify(dshBody) });
  assert.equal(anonymous.status, 401);

  const ok = await post(shim.base, '/v1/messages', dshBody, { 'x-api-key': 'secret', authorization: 'Bearer secret' });
  assert.equal(ok.status, 200);
});

test('API Key 每次请求现取：轮换后下一次搜索就用新值', async (t) => {
  let current = 'tvly-old';
  const { scenario, shim } = await setup(t, okTavily([]), { resolveApiKey: async () => current });

  await post(shim.base, '/v1/messages', dshBody);
  current = 'tvly-new';
  await post(shim.base, '/v1/messages', dshBody);

  assert.deepEqual(
    scenario.requests.map((request) => request.auth),
    ['Bearer tvly-old', 'Bearer tvly-new'],
  );
});

test('缺 key 时返回 401 与补救提示，不查询 Tavily', async (t) => {
  const { scenario, shim } = await setup(t, okTavily([]), {
    resolveApiKey: async () => undefined,
    missingKeyHint: '去插件页填写。',
  });

  const { status, json } = await post(shim.base, '/v1/messages', dshBody);
  assert.equal(status, 401);
  assert.equal(json.error.type, 'authentication_error');
  assert.match(json.error.message, /未配置 Tavily API Key。去插件页填写。/);
  assert.equal(scenario.requests.length, 0);
});

test('健康检查带服务标识（端口冲突时据此识别同类服务），纯函数口径', async (t) => {
  const { shim } = await setup(t, okTavily([]));

  const health = await fetch(`${shim.base}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'tavily-anthropic-search');

  assert.equal(extractQuery(dshBody), 'DeepSeek V4 发布时间');
  assert.ok(parseSearchRequest(dshBody, SHIM_DEFAULTS).query);
});

test('createShimServer 缺 resolveApiKey 时直接报错', () => {
  assert.throws(() => createShimServer({}), /resolveApiKey/);
});
