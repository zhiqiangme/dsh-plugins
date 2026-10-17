/**
 * 插件页卡片的宿主半侧：四条面板路由（经宿主浏览器会话鉴权）。
 *
 *   GET  /plugins/dsh-tavily-search/status   搜索接口状态（在不在监听、端点、凭据引用名）
 *   POST /plugins/dsh-tavily-search/test     端到端测试一次搜索：按 DSH 的请求形状打本插件的接口
 *   GET  /plugins/dsh-tavily-search/version  当前运行版本 vs npm latest（?force=1 绕过缓存，见 lib/update.js）
 *   GET  /plugins/dsh-tavily-search/keys     各 key 槽位：是否配置、能否修改、末 4 位（多 key 列表用）
 *
 * API Key 的写入不走这里：卡片直接用 DSH 的 `remote.credentials` 写凭据库（与内置网页搜索页同一条路）。
 * keys 路由只回末 4 位让用户分得清哪个是哪个，完整的值从不经过本插件的路由。
 *
 * 为什么挂在 ctx.webServer 而不是自己 listen：DSH 的 host webserver 已经占着客户端的同源地址，
 * 挂在它下面才拿得到同源 fetch；自己开端口既跨源，又要处理端口冲突与鉴权。
 * webServer 也是软取：拿不到只少一张卡片的数据，搜索接口照常工作。
 */

/** 插件名：与 package.json / cordis.patch.yml 里的 name 保持一致。 */
import { createVersionChecker } from './update.js';

const PLUGIN_ID = 'dsh-tavily-search';

/** 面板路由前缀：DSH 给每个插件留的命名空间，浏览器半侧用同一份常量。 */
export const PANEL_BASE = `/plugins/${PLUGIN_ID}`;
export const STATUS_PATH = `${PANEL_BASE}/status`;
export const TEST_PATH = `${PANEL_BASE}/test`;
export const VERSION_PATH = `${PANEL_BASE}/version`;
export const KEYS_PATH = `${PANEL_BASE}/keys`;

/** 请求体上限：测试请求只带一个检索词，4KB 足够，防止有人往 loopback 路由灌大包。 */
const MAX_BODY_BYTES = 4 * 1024;

/** 测试搜索的默认检索词与超时（比 Tavily 本身的超时略长，留出本地转发的余量）。 */
const DEFAULT_TEST_QUERY = 'DeepSeek';
const TEST_TIMEOUT_MS = 40_000;

/** 测试结果里最多回显几条标题：卡片只需要"确实搜到了东西"的证据。 */
const TEST_PREVIEW_TITLES = 3;

/** 统一的 JSON 应答。 */
export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 面板路由的准入检查：返回拒绝用的 HTTP 状态码，放行返回 undefined。
 *
 * 宿主 webServer 本身不鉴权，插件路由默认对任何连得上端口的请求开放。有 connection 服务时
 * 沿用宿主 /api 与 open-in-app 的同一道关：Host/Origin 校验（防 DNS 重绑定与跨站）加浏览器会话
 * Cookie（桌面端由 Electron 转发请求时附上）。没有 connection 的旧组合退回本地规则：对端必须是
 * 回环地址，带 Origin 时必须与 Host 同源——只放行"任意 loopback 来源"会让本机其他端口的网页也能调，
 * 例如反复调 test 路由消耗 Tavily 额度。
 */
export function requestRejection(req, connection) {
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req);
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 403;
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return 403;
  const origin = req.headers?.origin;
  if (origin === undefined) return undefined;
  try {
    return new URL(origin).host === req.headers?.host ? undefined : 403;
  } catch {
    return 403;
  }
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return plain === '::1' || plain.startsWith('127.');
}

/** POST 只收 JSON：text/plain 之类的"简单请求"跨源时不触发 CORS 预检，只能在服务端拒掉。 */
export function isJsonRequest(req) {
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/** 读 POST 的 JSON 体；空体视为 `{}`，其它形状问题返回 ok:false 而不是抛。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, reason: `请求体超过 ${MAX_BODY_BYTES} 字节` };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: '请求体不是对象' };
    return { ok: true, value };
  } catch {
    return { ok: false, reason: '请求体不是合法 JSON' };
  }
}

/** 状态应答：插件被配置成 enabled:false 时 runtime 为空，照样回一份能渲染的状态。 */
export function describeStatus({ resolved, runtime }) {
  return {
    ok: true,
    endpoint: resolved.endpoint,
    /** 新版 Search API 的基础地址（网页搜索页打开新版开关后，卡片把它写进 web-deepseek-api）。 */
    apiEndpoint: resolved.apiEndpoint,
    apiKeyRef: resolved.apiKeyRef,
    apiKeyRefs: resolved.apiKeyRefs,
    server: runtime ? runtime.status() : { state: 'disabled', reason: '' },
    tavily: { maxResults: resolved.shim.maxResults, searchDepth: resolved.shim.searchDepth },
  };
}

/** 按当前接的是哪套协议生成"测试搜索"要发的请求。 */
function testRequestFor({ resolved, mode, text, secret }) {
  if (mode === 'api') {
    return {
      url: `${resolved.apiEndpoint}/search`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      // DSH 的 web-deepseek-api 会带 count；测试按同一个形状发，才验证得到真正会走的那条路
      body: { query: text, count: resolved.shim.maxResults, need_content: false },
    };
  }
  return {
    url: `${resolved.endpoint}/messages`,
    headers: { 'content-type': 'application/json', 'x-api-key': secret, authorization: `Bearer ${secret}` },
    body: {
      model: 'tavily-search-shim',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${text}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    },
  };
}

/**
 * 端到端测试一次搜索。
 *
 * 刻意走 HTTP 打本插件的接口，而不是直接调 tavilySearch：这样验证的是 DSH 网页搜索
 * 真正会走的那条路（端口、请求形状、key 现取、Tavily 连通性），端口上是外部实例时也测得到。
 * mode 由卡片按当前接入的那套协议给出：messages = 旧版 Messages 搜索，api = 新版 Search API。
 */
export async function runTestSearch({ resolved, query, mode = 'messages' }) {
  const text = typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : DEFAULT_TEST_QUERY;
  const started = Date.now();
  const secret = resolved.shim.shimApiKey || 'dsh-tavily-search-test';
  const request = testRequestFor({ resolved, mode, text, secret });
  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    return {
      ok: false,
      mode,
      query: text,
      reason: `连不上搜索接口 ${request.url}：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, mode, query: text, reason: `搜索接口返回了非 JSON 响应（HTTP ${response.status}）` };
  }

  if (mode === 'api') {
    if (!response.ok || body?.error) {
      return { ok: false, mode, query: text, reason: body?.error?.message ?? `HTTP ${response.status}` };
    }
    const results = Array.isArray(body?.results) ? body.results : [];
    return {
      ok: true,
      mode,
      query: text,
      count: results.length,
      titles: results.slice(0, TEST_PREVIEW_TITLES).map((item) => item?.title || item?.url),
      elapsedMs: Date.now() - started,
    };
  }

  if (!response.ok || body?.type === 'error') {
    return { ok: false, mode, query: text, reason: body?.error?.message ?? `HTTP ${response.status}` };
  }

  const block = Array.isArray(body?.content) ? body.content.find((item) => item?.type === 'web_search_tool_result') : undefined;
  const results = Array.isArray(block?.content) ? block.content : [];
  return {
    ok: true,
    mode,
    query: text,
    count: results.length,
    titles: results.slice(0, TEST_PREVIEW_TITLES).map((item) => item.title || item.url),
    elapsedMs: Date.now() - started,
  };
}

/** 取宿主 webserver：读属性、ctx.get 两种方式都试，找有 register 的那个。 */
function resolveWebServer(ctx) {
  const candidates = [];
  try {
    candidates.push(ctx?.webServer);
  } catch {
    /* 服务未就绪时读属性可能抛，忽略 */
  }
  try {
    if (typeof ctx?.get === 'function') candidates.push(ctx.get('webServer'));
  } catch {
    /* 同上 */
  }
  return candidates.find((candidate) => typeof candidate?.register === 'function');
}

/** 宿主的 connection 服务（浏览器会话鉴权）；拿不到时 guard 退回本地规则。 */
function resolveConnection(ctx) {
  const candidates = [];
  try {
    candidates.push(ctx?.connection);
  } catch {
    /* 服务未就绪时读属性可能抛，忽略 */
  }
  try {
    if (typeof ctx?.get === 'function') candidates.push(ctx.get('connection'));
  } catch {
    /* 同上 */
  }
  return candidates.find((candidate) => typeof candidate?.requestRejection === 'function');
}

/** `?force=1` / `?force=true` 视为强制刷新；其它值（含缺省）走缓存。 */
function forceFrom(req) {
  try {
    const value = new URL(req.url ?? '', 'http://localhost').searchParams.get('force');
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/**
 * 注册面板路由；宿主没有 webServer 时只记一条 warn。
 *
 * @param {object} ctx
 * @param {{ logger: object, resolved: object, runtime?: object, inspectKeys?: () => Promise<object[]>, checkVersion?: (options: { force: boolean }) => Promise<object> }} options
 *   inspectKeys 见 lib/runtime.js 的 createKeyInspector；缺省时 keys 路由回空列表。
 *   checkVersion 只给测试注入，缺省用 lib/update.js 的带缓存检查器
 */
export function registerPanelRoutes(ctx, { logger, resolved, runtime, inspectKeys, checkVersion = createVersionChecker() }) {
  const mount = (scoped) => {
    const webServer = resolveWebServer(scoped ?? ctx) ?? resolveWebServer(ctx);
    if (!webServer) {
      logger.warn(`[${PLUGIN_ID}] 宿主没有可用的 webServer 服务，插件页卡片的状态路由未注册（搜索接口不受影响）`);
      return;
    }

    /** 准入校验与异常兜底：各路由共用。 */
    const guard = (handler) => async (req, res) => {
      // connection 每次现取：它与 webServer 谁先挂上不确定。
      const rejection = requestRejection(req, resolveConnection(ctx));
      if (rejection !== undefined) {
        json(res, rejection, { ok: false, reason: rejection === 401 ? 'unauthorized' : 'origin-not-trusted' });
        return;
      }
      if (req.method === 'POST' && !isJsonRequest(req)) {
        json(res, 415, { ok: false, reason: 'content-type 必须是 application/json' });
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        logger.warn(`[${PLUGIN_ID}] 面板请求处理失败：${error instanceof Error ? error.message : String(error)}`);
        json(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    };

    ctx.effect(() => {
      const disposeStatus = webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: guard(async (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { ok: false, reason: 'method not allowed' });
            return;
          }
          json(res, 200, describeStatus({ resolved, runtime }));
        }),
      });

      const disposeTest = webServer.register({
        kind: 'exact',
        path: TEST_PATH,
        handler: guard(async (req, res) => {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, reason: 'method not allowed' });
            return;
          }
          const body = await readJsonBody(req);
          if (!body.ok) {
            json(res, 400, { ok: false, reason: body.reason });
            return;
          }
          // 测试失败也是 200：失败原因是要展示给用户的结果，不是路由本身出错
          json(res, 200, await runTestSearch({ resolved, query: body.value.query, mode: body.value.mode }));
        }),
      });

      const disposeVersion = webServer.register({
        kind: 'exact',
        path: VERSION_PATH,
        handler: guard(async (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { ok: false, reason: 'method not allowed' });
            return;
          }
          // 检查失败（注册表都连不上）也是 200：同测试搜索，失败原因是给用户看的结果
          json(res, 200, await checkVersion({ force: forceFrom(req) }));
        }),
      });

      const disposeKeys = webServer.register({
        kind: 'exact',
        path: KEYS_PATH,
        handler: guard(async (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { ok: false, reason: 'method not allowed' });
            return;
          }
          json(res, 200, { ok: true, keys: inspectKeys ? await inspectKeys() : [] });
        }),
      });

      return () => {
        for (const dispose of [disposeStatus, disposeTest, disposeVersion, disposeKeys]) {
          try {
            dispose?.();
          } catch {
            /* 卸载阶段的释放失败不影响 DSH 退出 */
          }
        }
      };
    }, `${PLUGIN_ID}: panel routes`);
  };

  // 用 ctx.inject 等服务就绪：webServer 通常比插件树晚挂上，直接读属性会拿到 undefined 而静默丢掉路由
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], mount);
      return;
    } catch {
      /* 老版本没有这个签名时退回直接挂载 */
    }
  }
  mount(ctx);
}
