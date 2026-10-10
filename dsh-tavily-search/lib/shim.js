/**
 * Tavily → Anthropic Messages 适配服务：把 Tavily 检索包装成 DSH「网页搜索」能用的接口。
 *
 * 来源：移植自 D:\Project\Test\tavily-anthropic-search\server.js（Test 仓库提交 242449c），
 * 改成 ESM 并做了两处调整：
 *   - API Key 不再在启动时固定读取，而是每次请求调用 `resolveApiKey()` 现取——
 *     key 存在 DSH 凭据库里，用户在插件页改了 key，下一次搜索立即生效，不用重启；
 *   - 缺 key 不再拒绝启动，而是在请求时返回明确的错误信封（key 可以运行期补上）。
 *
 * 背景：DSH 的搜索提供方（@deepseek-ai/dsh-web-search-deepseek）向
 * `{baseURL}/messages` 发一次带原生 `web_search_20250305` 服务端工具的 Messages 请求，
 * 然后只解析响应里的 `web_search_tool_result` 结构化块，绝不信任回复文本。
 * 本服务不调用任何模型：收到请求后直接查询 Tavily，再合成该结构化响应。
 *
 * 响应结构约束（来自 DSH 解析器的实测契约，改错字段会静默丢数据）：
 *   - 结果条目挂在 `web_search_tool_result.content[]` 下，条目 `type` 为 `web_search_result`；
 *   - 条目字段 `url`/`title`/`page_age`；`url` 必须非空字符串，否则被丢弃；
 *   - 摘要（snippet）不在结果条目里，而在 `text` 块的 `citations[].cited_text`，
 *     解析器按 `citations[].url` 与结果条目关联，同 URL 取第一条。
 *
 * 只依赖 node: 内置模块与全局 fetch（Node 18+ / Electron 均自带）。
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/** DSH 发出的固定查询前缀；去掉后才是真正的检索词。 */
export const QUERY_PREFIX = /^Perform a web search for the query:\s*/i;

/** `/health` 里的服务标识：端口被占用时据此判断占着端口的是不是同一种服务。 */
export const SERVICE_ID = 'tavily-anthropic-search';

export const SHIM_DEFAULTS = Object.freeze({
  tavilyBaseUrl: 'https://api.tavily.com',
  maxResults: 8,
  /** 空串表示不传 search_depth，交给 Tavily 用默认档位。 */
  searchDepth: '',
  timeoutMs: 30_000,
  /** 查询词长度上限：Tavily 对长查询不友好，超出直接拒绝比静默截断更可控。 */
  maxQueryChars: 600,
  maxBodyBytes: 1024 * 1024,
  /** 非空时校验调用方的 x-api-key / Bearer；为空则不校验（DSH 只要求非空值）。 */
  shimApiKey: '',
  userAgent: 'dsh-tavily-search/0.2',
  /** 缺 key 时错误信息里的补救提示；插件会换成"去插件页填写"的说法。 */
  missingKeyHint: '请设置 TAVILY_API_KEY。',
});

/** Anthropic 风格错误响应体。 */
function anthropicError(status, type, message) {
  return { status, body: { type: 'error', error: { type, message } } };
}

/** 从 Messages 请求里取最后一段用户文本。 */
function userText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    }
  }
  return '';
}

/** 提取检索词：优先剥掉 DSH 的固定前缀，其余情况整段文本即查询。 */
export function extractQuery(body) {
  const text = userText(body).trim();
  return text.replace(QUERY_PREFIX, '').trim().replace(/^["'「“]|["'」”]$/g, '').trim();
}

/** 校验请求，返回 `{ query }` 或错误对象（带 status/body）。 */
export function parseSearchRequest(body, options) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const searchTool = tools.find((tool) => tool?.type === 'web_search_20250305');
  if (!searchTool) {
    return anthropicError(
      400,
      'invalid_request_error',
      '本服务只接受携带 web_search_20250305 服务端工具的 Messages 请求（tools: [{type: "web_search_20250305", ...}]）。',
    );
  }
  if (searchTool.max_uses !== undefined && (!Number.isInteger(searchTool.max_uses) || searchTool.max_uses < 1)) {
    return anthropicError(400, 'invalid_request_error', 'web_search 工具的 max_uses 必须是 >= 1 的整数。');
  }
  const query = extractQuery(body);
  if (query.length === 0) {
    return anthropicError(400, 'invalid_request_error', '检索词为空：用户消息里找不到可搜索的文本。');
  }
  if (query.length > options.maxQueryChars) {
    return anthropicError(
      400,
      'invalid_request_error',
      `检索词过长（${query.length} > ${options.maxQueryChars} 字符），请缩短查询后重试。`,
    );
  }
  return { query };
}

/** 上游（Tavily）故障，区别于请求本身的问题。 */
export class UpstreamError extends Error {}

/** 请求体超过上限。 */
export class BodyTooLarge extends Error {}

/** 调 Tavily /search，返回按 URL 去重后的归一化结果列表。 */
export async function tavilySearch(query, apiKey, options, signal) {
  const endpoint = `${options.tavilyBaseUrl}/search`;
  const payload = {
    query,
    max_results: options.maxResults,
    include_answer: false,
    include_raw_content: false,
  };
  if (options.searchDepth) payload.search_depth = options.searchDepth;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': options.userAgent,
      },
      // api_key 放 body 兼容旧版 Tavily 文档，Bearer 头兼容新版
      body: JSON.stringify({ ...payload, api_key: apiKey }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new UpstreamError(`Tavily 请求超时（${options.timeoutMs} ms）`);
    throw new UpstreamError(`Tavily 请求失败：${error?.message ?? error}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError(`Tavily 返回 HTTP ${response.status}：${text.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UpstreamError('Tavily 返回了非 JSON 响应');
  }
  const raw = Array.isArray(data?.results) ? data.results : [];
  // 按 URL 去重（同 URL 取第一条），与 DSH 解析器的去重口径保持一致
  const seen = new Set();
  const items = [];
  for (const item of raw) {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    items.push({
      url,
      title: typeof item?.title === 'string' ? item.title : '',
      snippet: typeof item?.content === 'string' ? item.content.trim() : '',
      publishedDate: typeof item?.published_date === 'string' ? item.published_date.trim() : '',
    });
  }
  return items;
}

/** 合成 Anthropic Messages 响应体。 */
export function buildMessage({ model, query, results, options }) {
  const toolUseId = `srvtoolu_${randomUUID().replace(/-/g, '')}`;
  const webResults = results.map((item) => ({
    type: 'web_search_result',
    url: item.url,
    title: item.title,
    // 解析器不读取该字段；这里放一份不透明快照，便于调试与多轮回放
    encrypted_content: Buffer.from(JSON.stringify({ url: item.url, snippet: item.snippet })).toString('base64'),
    ...(item.publishedDate ? { page_age: item.publishedDate } : {}),
  }));

  const content = [
    { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: toolUseId, content: webResults },
  ];

  // 文本块本身不被 DSH 信任，但 citations[].cited_text 是它的 snippet 来源
  const citations = results
    .filter((item) => item.snippet.length > 0)
    .map((item) => ({
      type: 'web_search_result_location',
      cited_text: item.snippet,
      url: item.url,
      title: item.title,
      encrypted_index: Buffer.from(JSON.stringify({ url: item.url })).toString('base64'),
    }));
  const lines = results.map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}`);
  content.push({
    type: 'text',
    text: lines.length > 0 ? lines.join('\n') : 'No web search results were found for this query.',
    ...(citations.length > 0 ? { citations } : {}),
  });

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: model || 'tavily-search-shim',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      // 粗估值（约 4 字符 1 token）：本服务不调模型，这里只是让上游统计不出现 0
      input_tokens: Math.ceil(query.length / 4) + 300,
      output_tokens: Math.ceil(lines.join('\n').length / 4) + 20,
      server_tool_use: { web_search_requests: 1 },
    },
    _shim: { provider: 'tavily', search_results: results.length, config_max_results: options.maxResults },
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  // 响应已发出（例如客户端断开后触发的迟到错误）时不再写入，避免二次写头崩溃
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, err) {
  sendJson(res, err.status, err.body);
}

function isAuthorized(req, options) {
  if (!options.shimApiKey) return true;
  const key = req.headers['x-api-key'] ?? '';
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return key === options.shimApiKey || bearer === options.shimApiKey;
}

/**
 * 创建 HTTP 服务（不 listen：由调用方决定端口，测试可 listen 到随机端口）。
 *
 * @param {Partial<typeof SHIM_DEFAULTS> & { resolveApiKey: () => Promise<string | undefined> | string | undefined }} input
 */
export function createShimServer(input) {
  const options = { ...SHIM_DEFAULTS, ...input };
  options.tavilyBaseUrl = String(options.tavilyBaseUrl).replace(/\/+$/, '');
  if (typeof options.resolveApiKey !== 'function') {
    throw new TypeError('createShimServer 需要 resolveApiKey()');
  }

  return createServer(async (req, res) => {
    const pathname = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJson(res, 200, { status: 'ok', service: SERVICE_ID, provider: 'tavily', model_hint: 'tavily-search-shim' });
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/models') {
        sendJson(res, 200, {
          data: [{ type: 'model', id: 'tavily-search-shim', display_name: 'Tavily search shim (no LLM)' }],
          has_more: false,
          first_id: 'tavily-search-shim',
          last_id: 'tavily-search-shim',
        });
        return;
      }
      const isMessages =
        req.method === 'POST' &&
        (pathname === '/v1/messages' || pathname === '/anthropic/v1/messages' || pathname === '/messages');
      if (!isMessages) {
        sendError(res, anthropicError(404, 'not_found_error', `未知路径：${req.method} ${pathname}`));
        return;
      }
      if (!isAuthorized(req, options)) {
        sendError(res, anthropicError(401, 'authentication_error', '鉴权失败：x-api-key / Bearer 与 shimApiKey 不一致。'));
        return;
      }

      let body;
      try {
        body = JSON.parse(await readBody(req, options.maxBodyBytes));
      } catch (error) {
        const message =
          error instanceof BodyTooLarge
            ? `请求体超过 ${options.maxBodyBytes} 字节上限`
            : `请求体不是合法 JSON：${error?.message ?? error}`;
        sendError(res, anthropicError(400, 'invalid_request_error', message));
        return;
      }

      const parsed = parseSearchRequest(body, options);
      if (parsed.body) {
        sendError(res, parsed);
        return;
      }

      // 每次请求现取 key：凭据库里的 key 被轮换后，下一次搜索就用新值
      const apiKey = String((await options.resolveApiKey()) ?? '').trim();
      if (!apiKey) {
        sendError(res, anthropicError(401, 'authentication_error', `未配置 Tavily API Key。${options.missingKeyHint}`));
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      res.on('close', () => controller.abort());
      try {
        const results = await tavilySearch(parsed.query, apiKey, options, controller.signal);
        sendJson(res, 200, buildMessage({ model: body?.model, query: parsed.query, results, options }));
      } catch (error) {
        if (error instanceof UpstreamError) {
          sendError(
            res,
            anthropicError(
              502,
              'api_error',
              `${error.message}\n\n本服务的 Tavily 端点为 ${options.tavilyBaseUrl}/search；请检查 Tavily API Key 与网络。`,
            ),
          );
        } else {
          sendError(res, anthropicError(500, 'api_error', `搜索适配服务内部错误：${error?.message ?? error}`));
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      sendError(res, anthropicError(500, 'api_error', `搜索适配服务内部错误：${error?.message ?? error}`));
    }
  });
}
