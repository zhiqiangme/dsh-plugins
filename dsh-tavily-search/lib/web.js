/**
 * 插件页卡片的宿主半侧：三条 loopback 路由。
 *
 *   GET  /plugins/dsh-tavily-search/status   搜索接口状态（在不在监听、端点、凭据引用名）
 *   POST /plugins/dsh-tavily-search/test     端到端测试一次搜索：按 DSH 的请求形状打本插件的接口
 *   GET  /plugins/dsh-tavily-search/version  当前运行版本 vs npm latest（?force=1 绕过缓存，见 lib/update.js）
 *
 * API Key 不走这里：卡片直接用 DSH 的 `remote.credentials` 读写凭据库（与内置网页搜索页同一条路），
 * 值从不经过本插件的路由。
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
 * 只接受本机来源：没有 Origin 头（curl、同源导航）放行；有则必须是 loopback。
 * DSH 的页面本身就是从 127.0.0.1 加载的，任何外部页面都触发不了这些路由。
 */
export function loopbackOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
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
    apiKeyRef: resolved.apiKeyRef,
    server: runtime ? runtime.status() : { state: 'disabled', reason: '' },
    tavily: { maxResults: resolved.shim.maxResults, searchDepth: resolved.shim.searchDepth },
  };
}

/**
 * 端到端测试一次搜索。
 *
 * 刻意走 HTTP 打本插件的接口，而不是直接调 tavilySearch：这样验证的是 DSH 网页搜索
 * 真正会走的那条路（端口、请求形状、key 现取、Tavily 连通性），端口上是外部实例时也测得到。
 */
export async function runTestSearch({ resolved, query }) {
  const text = typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : DEFAULT_TEST_QUERY;
  const started = Date.now();
  const secret = resolved.shim.shimApiKey || 'dsh-tavily-search-test';
  let response;
  try {
    response = await fetch(`${resolved.endpoint}/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': secret, authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: 'tavily-search-shim',
        max_tokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${text}` }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      }),
    });
  } catch (error) {
    return { ok: false, query: text, reason: `连不上搜索接口 ${resolved.endpoint}：${error instanceof Error ? error.message : String(error)}` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, query: text, reason: `搜索接口返回了非 JSON 响应（HTTP ${response.status}）` };
  }
  if (!response.ok || body?.type === 'error') {
    return { ok: false, query: text, reason: body?.error?.message ?? `HTTP ${response.status}` };
  }

  const block = Array.isArray(body?.content) ? body.content.find((item) => item?.type === 'web_search_tool_result') : undefined;
  const results = Array.isArray(block?.content) ? block.content : [];
  return {
    ok: true,
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
 * @param {{ logger: object, resolved: object, runtime?: object, checkVersion?: (options: { force: boolean }) => Promise<object> }} options
 *   checkVersion 只给测试注入，缺省用 lib/update.js 的带缓存检查器
 */
export function registerPanelRoutes(ctx, { logger, resolved, runtime, checkVersion = createVersionChecker() }) {
  const mount = (scoped) => {
    const webServer = resolveWebServer(scoped ?? ctx) ?? resolveWebServer(ctx);
    if (!webServer) {
      logger.warn(`[${PLUGIN_ID}] 宿主没有可用的 webServer 服务，插件页卡片的状态路由未注册（搜索接口不受影响）`);
      return;
    }

    /** 来源校验与异常兜底：各路由共用。 */
    const guard = (handler) => async (req, res) => {
      if (!loopbackOrigin(req)) {
        json(res, 403, { ok: false, reason: 'origin-not-trusted' });
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
          json(res, 200, await runTestSearch({ resolved, query: body.value.query }));
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

      return () => {
        for (const dispose of [disposeStatus, disposeTest, disposeVersion]) {
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
