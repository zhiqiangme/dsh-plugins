/**
 * Tavily → DSH 网页搜索适配服务：把 Tavily 检索包装成 DSH「网页搜索」能用的接口。
 *
 * 同一个端口回答两种协议，对应 DSH 两代搜索提供方：
 *   1. 旧版 Messages 搜索（@deepseek-ai/dsh-web-search-deepseek）：向 `{baseURL}/messages`
 *      发带原生 `web_search_20250305` 工具的 Messages 请求，只解析 `web_search_tool_result` 块；
 *   2. 新版 Search API（@deepseek-ai/dsh-web-deepseek-api，0.2.1-rc.2 起）：向
 *      `{baseURL}/search` POST `{query, count}`，期望 `{results:[{url,title,snippet,date}]}`。
 *      网页搜索页的「启用新版 Web 搜索 API」把 baseURL 指到这里（`/v1/tools`）即可。
 * 新版 Fetch API（`/fetch`）本插件明确拒绝：抓取仍由 DSH 的本地 HTTP 抓取提供方负责，
 * 不把网页抓取改成 Tavily Extract、不额外消耗额度。
 *
 * 来源：移植自作者早先独立运行的 tavily-anthropic-search 适配服务（server.js），
 * 改成 ESM 并做了几处调整：
 *   - API Key 不再在启动时固定读取，而是每次请求调用 `resolveApiKey()` 现取——
 *     key 存在 DSH 凭据库里，用户在插件页改了 key，下一次搜索立即生效，不用重启；
 *   - 缺 key 不再拒绝启动，而是在请求时返回明确的错误信封（key 可以运行期补上）；
 *   - 支持多个 key：`resolveApiKey()` 可以返回数组，请求间轮流使用，某个 key 被拒
 *     （失效 / 限流 / 额度用尽）时当场换下一个重试。
 *
 * 背景：旧版提供方不调用模型以外的能力，只认 Messages 响应里的结构化块，绝不信任回复文本。
 * 本服务不调用任何模型：收到请求后直接查询 Tavily，再合成对应的响应。
 *
 * Messages 响应结构约束（来自 DSH 解析器的实测契约，改错字段会静默丢数据）：
 *   - 结果条目挂在 `web_search_tool_result.content[]` 下，条目 `type` 为 `web_search_result`；
 *   - 条目字段 `url`/`title`/`page_age`；`url` 必须非空字符串，否则被丢弃；
 *   - 摘要（snippet）不在结果条目里，而在 `text` 块的 `citations[].cited_text`，
 *     解析器按 `citations[].url` 与结果条目关联，同 URL 取第一条。
 *
 * Search API 响应结构约束（dsh-web-deepseek-api 的 mapSearchResponse）：每条结果必须同时有
 * 字符串 `url`/`title`/`snippet` 和 `date`（字符串或 null），少一个字段整条响应作废。
 *
 * 只依赖 node: 内置模块与全局 fetch（Node 18+ / Electron 均自带）。
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/** DSH 发出的固定查询前缀；去掉后才是真正的检索词。 */
export const QUERY_PREFIX = /^Perform a web search for the query:\s*/i;

/** `/health` 里的服务标识：端口被占用时据此判断占着端口的是不是同一种服务。 */
export const SERVICE_ID = 'tavily-anthropic-search';

/**
 * 新版 Search API 的路径集合。DSH 的 `web-deepseek-api` 把配置里的基础地址
 * （默认 https://api.deepseek.com/v1/tools，本插件接入时改成 http://127.0.0.1:8787/v1/tools）
 * 去掉末尾斜杠后追加 `/search`，所以正常只会打到 `/v1/tools/search`；
 * 另外两个前缀变体是为了便于手工调用与排障。
 */
export const SEARCH_API_PATHS = new Set(['/v1/tools/search', '/tools/search', '/search']);

/** 新版 Fetch API 路径。本插件只给搜索供数，收到抓取请求时明确拒绝。 */
export const FETCH_API_PATHS = new Set(['/v1/tools/fetch', '/tools/fetch', '/fetch']);

/** 新版 Fetch API 的拒绝说明：告诉用户把抓取提供方改回本地 HTTP，而不是误以为插件坏了。 */
export const FETCH_UNSUPPORTED_MESSAGE =
  '本插件只提供新版 Search API 的搜索；网页抓取请把「网页搜索」的抓取提供方改回本地 HTTP（http），或在插件页点「修复接入」。';

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
  userAgent: 'dsh-tavily-search',
  /** 缺 key 时错误信息里的补救提示；插件会换成"去插件页填写"的说法。 */
  missingKeyHint: '请设置 TAVILY_API_KEY。',
});

/**
 * 换下一个 key 重试的 Tavily 状态码：都是"这个 key 本身用不了"，换 key 有望成功。
 *   401 key 无效 · 403 key 被禁用 · 429 限流 · 432 key / 套餐额度用尽 · 433 按量付费额度用尽
 * 其它失败（5xx、网络、超时）与 key 无关，换 key 只会把同一个故障重复几遍，所以不重试。
 */
export const KEY_FAILOVER_STATUSES = new Set([401, 403, 429, 432, 433]);

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

/** 上游（Tavily）故障，区别于请求本身的问题；`status` 是 Tavily 的 HTTP 状态码（网络错误时没有）。 */
export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** 新版 Search API 的错误信封。DSH 的 web-deepseek-api 从 `error.message` 取详情。 */
function apiError(status, message) {
  return { status, body: { error: { message } } };
}

/**
 * 校验新版 Search API 请求（`{query, count, need_content, ori_question}`），
 * 返回 `{query, maxResults}` 或错误对象（带 status/body）。
 *
 * count 是 DSH 网页搜索页「每次搜索结果数」写下来的值；本插件的 maxResults 仍是上限：
 * 内置页面调大 count 不会让单次检索超出插件配置，调小则按页面来。
 */
export function parseSearchApiRequest(body, options) {
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (query.length === 0) {
    return apiError(400, '检索词为空：Search API 的请求体需要非空 query。');
  }
  if (query.length > options.maxQueryChars) {
    return apiError(400, `检索词过长（${query.length} > ${options.maxQueryChars} 字符），请缩短查询后重试。`);
  }
  const count = body?.count;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    return apiError(400, 'count 必须是 >= 1 的整数。');
  }
  return { query, maxResults: Math.min(count ?? options.maxResults, options.maxResults) };
}

/**
 * 合成新版 Search API 响应。DSH 的解析器（dsh-web-deepseek-api 的 mapSearchResponse）
 * 要求每条结果都带 `url` / `title` / `snippet` 字符串与 `date`（字符串或 null）；
 * 少一个字段整条响应会被判为无效，所以这里四个字段一律显式写出。
 */
export function buildSearchApiResponse({ results }) {
  return {
    results: results.map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.snippet,
      date: item.publishedDate ? item.publishedDate : null,
    })),
  };
}

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
    throw new UpstreamError(`Tavily 返回 HTTP ${response.status}：${text.slice(0, 300)}`, response.status);
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

/** `resolveApiKey()` 的结果统一成去空、去重的 key 列表（兼容只返回一个字符串的老用法）。 */
export function normalizeKeys(value) {
  const list = Array.isArray(value) ? value : [value];
  const keys = [];
  for (const item of list) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 按 key 列表依次尝试：从 `start` 开始轮，遇到 KEY_FAILOVER_STATUSES 换下一个，
 * 其它错误立即抛出。全部被拒时抛最后一个错误，并注明试过几个 key。
 */
export async function searchWithKeys(query, keys, start, options, signal) {
  let lastError;
  for (let offset = 0; offset < keys.length; offset += 1) {
    const apiKey = keys[(start + offset) % keys.length];
    try {
      return await tavilySearch(query, apiKey, options, signal);
    } catch (error) {
      if (!(error instanceof UpstreamError) || !KEY_FAILOVER_STATUSES.has(error.status) || signal?.aborted) throw error;
      lastError = error;
    }
  }
  if (keys.length > 1) {
    throw new UpstreamError(`${keys.length} 个 Tavily API Key 都被拒绝，最后一个：${lastError.message}`, lastError.status);
  }
  throw lastError;
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

/** 把 POST 路径归到三种协议之一；其它路径返回 undefined（由调用方回 404）。 */
function routeOf(method, pathname) {
  if (method !== 'POST') return undefined;
  if (pathname === '/v1/messages' || pathname === '/anthropic/v1/messages' || pathname === '/messages') return 'messages';
  if (SEARCH_API_PATHS.has(pathname)) return 'search';
  if (FETCH_API_PATHS.has(pathname)) return 'fetch';
  return undefined;
}

/** 同一个服务号下的两种错误信封：Messages 用 Anthropic 形状，新版 Search API 用 `{error:{message}}`。 */
function errorFor(route, status, type, message) {
  return route === 'messages' ? anthropicError(status, type, message) : { status, body: { error: { message } } };
}

/**
 * 创建 HTTP 服务（不 listen：由调用方决定端口，测试可 listen 到随机端口）。
 *
 * 同时提供两种协议：
 *   - POST {任意前缀}/messages   旧版 Messages 搜索（DSH 的 web-search-deepseek）；
 *   - POST {任意前缀}/search     新版 Search API（DSH 的 web-deepseek-api）；
 *   - POST {任意前缀}/fetch      新版 Fetch API：本插件只做搜索，明确拒绝。
 *
 * @param {Partial<typeof SHIM_DEFAULTS> & { resolveApiKey: () => Promise<string | string[] | undefined> | string | string[] | undefined }} input
 */
export function createShimServer(input) {
  const options = { ...SHIM_DEFAULTS, ...input };
  options.tavilyBaseUrl = String(options.tavilyBaseUrl).replace(/\/+$/, '');
  if (typeof options.resolveApiKey !== 'function') {
    throw new TypeError('createShimServer 需要 resolveApiKey()');
  }
  /** 轮询游标：每个请求从下一个 key 开始，多个 key 的额度均摊消耗，而不是先把第一个用光。 */
  let cursor = 0;

  /** 取 key、上超时、调 Tavily；两种协议共用，只由调用方决定 maxResults 与结果信封。 */
  const runSearch = async (res, { route, query, maxResults }) => {
    // 每次请求现取 key：凭据库里的 key 被轮换后，下一次搜索就用新值
    const keys = normalizeKeys(await options.resolveApiKey());
    if (keys.length === 0) {
      return { error: errorFor(route, 401, 'authentication_error', `未配置 Tavily API Key。${options.missingKeyHint}`) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    res.on('close', () => controller.abort());
    try {
      const start = cursor % keys.length;
      cursor = (cursor + 1) % Number.MAX_SAFE_INTEGER;
      const results = await searchWithKeys(query, keys, start, { ...options, maxResults }, controller.signal);
      return { results };
    } catch (error) {
      if (error instanceof UpstreamError) {
        return {
          error: errorFor(
            route,
            502,
            'api_error',
            `${error.message}\n\n本服务的 Tavily 端点为 ${options.tavilyBaseUrl}/search；请检查 Tavily API Key 与网络。`,
          ),
        };
      }
      return { error: errorFor(route, 500, 'api_error', `搜索适配服务内部错误：${error?.message ?? error}`) };
    } finally {
      clearTimeout(timer);
    }
  };

  return createServer(async (req, res) => {
    const pathname = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJson(res, 200, {
          status: 'ok',
          service: SERVICE_ID,
          provider: 'tavily',
          model_hint: 'tavily-search-shim',
          apis: ['messages', 'search'],
        });
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
      const route = routeOf(req.method, pathname);
      if (route === undefined) {
        sendError(res, anthropicError(404, 'not_found_error', `未知路径：${req.method} ${pathname}`));
        return;
      }
      // 搜索由 DSH 宿主（或 CLI）转发，浏览器只调用宿主的面板路由。
      // 即使不允许 CORS，网页仍能用 text/plain POST 提交 JSON 并消耗所有 key 的额度；
      // 因此在读体、取凭据前拒绝浏览器来源，包括沙箱页面的 Origin: null。
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] === 'cross-site') {
        sendError(res, errorFor(route, 403, 'permission_error', '搜索接口只接受宿主或 CLI 请求，浏览器请使用宿主的面板路由。'));
        return;
      }
      if (!isAuthorized(req, options)) {
        sendError(res, errorFor(route, 401, 'authentication_error', '鉴权失败：x-api-key / Bearer 与 shimApiKey 不一致。'));
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
        sendError(res, errorFor(route, 400, 'invalid_request_error', message));
        return;
      }

      if (route === 'fetch') {
        sendError(res, { status: 501, body: { error: { message: FETCH_UNSUPPORTED_MESSAGE } } });
        return;
      }

      if (route === 'messages') {
        const parsed = parseSearchRequest(body, options);
        if (parsed.body) {
          sendError(res, parsed);
          return;
        }
        const outcome = await runSearch(res, { route, query: parsed.query, maxResults: options.maxResults });
        if (outcome.error) {
          sendError(res, outcome.error);
          return;
        }
        sendJson(res, 200, buildMessage({ model: body?.model, query: parsed.query, results: outcome.results, options }));
        return;
      }

      // 新版 Search API：DSH 的 web-deepseek-api 在基础地址后追加 /search
      const parsed = parseSearchApiRequest(body, options);
      if (parsed.body) {
        sendError(res, parsed);
        return;
      }
      const outcome = await runSearch(res, { route, query: parsed.query, maxResults: parsed.maxResults });
      if (outcome.error) {
        sendError(res, outcome.error);
        return;
      }
      sendJson(res, 200, buildSearchApiResponse({ results: outcome.results }));
    } catch (error) {
      sendError(res, anthropicError(500, 'api_error', `搜索适配服务内部错误：${error?.message ?? error}`));
    }
  });
}
