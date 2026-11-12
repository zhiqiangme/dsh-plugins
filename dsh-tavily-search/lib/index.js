/**
 * dsh-tavily-search —— 用 Tavily 给 DSH 的「网页搜索」供数。
 *
 * 支持提供方下拉框的 DSH 直接通过 ctx.web 调用 Tavily。
 * 旧宿主和独立客户端仍可用兼容的 Messages / Search API HTTP 接口（见 lib/shim.js）。
 *
 * 行为约定：
 *   - 随插件加载监听，随插件卸载关闭；不再有外部进程；
 *   - 幂等：端口上已有同类适配服务（例如手动起的旧 server.js）时只记日志，不抢端口；
 *   - 失败不阻断 DSH 启动：监听不上只写日志，DSH 本身照常可用；
 *   - Tavily API Key 存在 DSH 凭据库（引用名默认 TAVILY_API_KEY，更多 key 依次是
 *     TAVILY_API_KEY_2…），每次请求现取，改 key 不用重启；多个 key 轮流使用、被拒时自动换下一个；
 *     缺 key 时请求返回明确的错误，而不是服务起不来。
 *
 * 本插件刻意只依赖 node: 内置模块；Host Service 一律软取（见 lib/runtime.js）。
 */

import { parseEnvFile, resolvePluginConfig } from './config.js';
import { createKeyInspector, createKeyResolver, importLegacyKey, ShimRuntime, whenService } from './runtime.js';
import { createTavilySearch, parseSearchApiRequest } from './shim.js';
import { registerPanelRoutes } from './web.js';

/** 插件名（日志前缀）。 */
export const name = 'dsh-tavily-search';

/**
 * 不声明任何 Host Service 依赖：credentials 在请求时软取，缺席时退回环境变量，
 * 不会因为某个 Service 未就绪而整个插件不激活。
 */
export const inject = [];

/**
 * Cordis 入口。监听在后台进行（EADDRINUSE 时最多重试约 2s），apply 只负责登记生命周期。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config profile 中该插件行的 config
 */
export function apply(ctx, config) {
  const logger = normalizeLogger(ctx);
  const resolved = resolvePluginConfig(config);

  const inspectKeys = createKeyInspector(ctx, resolved.apiKeyRefs);

  if (!resolved.enabled) {
    logger.info(`[${name}] 已禁用（enabled: false），不监听搜索接口`);
    // 卡片仍要能显示"已禁用"，而不是一直转圈读不到状态；key 照样能管理
    registerPanelRoutes(ctx, { logger, resolved, runtime: undefined, inspectKeys });
    return;
  }

  const resolveApiKey = createKeyResolver(ctx, resolved.apiKeyRefs);
  const missingKeyHint = `请在 DSH「插件」页的 Tavily 联网搜索卡片里填写（凭据引用 ${resolved.apiKeyRef}）。`;
  const search = createTavilySearch({ ...resolved.shim, resolveApiKey, missingKeyHint });
  let nativeProvider;
  whenService(ctx, 'web', (web, scoped) => {
    // 只有能枚举提供方的宿主才在内置页面显示第三方选项，旧宿主继续使用兼容接口。
    if (typeof web?.listProviders !== 'function' || typeof web.registerSearchProvider !== 'function') return;
    scoped.effect(() => {
      const provider = createSearchProvider(search, resolved.shim);
      const dispose = web.registerSearchProvider(provider);
      nativeProvider = provider;
      return () => {
        nativeProvider = undefined;
        dispose();
      };
    }, `${name}: web search provider`);
  });

  const runtime = new ShimRuntime({ ...resolved, resolveApiKey, missingKeyHint, search, logger, label: name });

  // 卡片的状态 / 测试路由：与监听结果无关，先挂上，端口冲突时打开卡片也能看到原因
  registerPanelRoutes(ctx, { logger, resolved, runtime, inspectKeys, getNativeProvider: () => nativeProvider });

  const startup = runtime.start();

  if (resolved.importEnvFile) importKeyOnce(ctx, resolved, logger);

  ctx.effect(
    () => async () => {
      // 先等监听流程落地，避免"正在监听"与"正在关闭"互相打架
      await startup.catch(() => undefined);
      try {
        await runtime.stop();
      } catch (error) {
        logger.warn(`[${name}] 关闭搜索接口时出错：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    `${name}: search endpoint`,
  );
}

function createSearchProvider(search, options) {
  return {
    id: name,
    title: 'Tavily',
    description: {
      zh: '使用 Tavily 联网搜索，额度由插件中配置的 Tavily API Key 提供。',
      en: 'Search the web with Tavily using the API keys configured in the plugin.',
    },
    available: () => true,
    async search({ query, maxResults }, signal) {
      const request = parseSearchApiRequest({ query, count: maxResults }, options);
      if (request.body) throw new Error(request.body.error.message);
      const results = await search(request, signal);
      const sources = results.slice(0, request.maxResults).map(({ url, title, snippet, publishedDate }) => ({
        url,
        ...(title ? { title } : {}),
        ...(snippet ? { snippet } : {}),
        ...(publishedDate ? { publishedAt: publishedDate } : {}),
      }));
      return { sources, truncated: sources.length < results.length };
    },
  };
}

/** 等凭据服务就绪后做一次旧 key 导入；任何失败只记日志。 */
function importKeyOnce(ctx, resolved, logger) {
  const file = resolved.importEnvFile;
  whenService(ctx, 'credentials', (credentials) => {
    const value = parseEnvFile(file)[resolved.apiKeyRef];
    importLegacyKey(credentials, { ref: resolved.apiKeyRef, value })
      .then((result) => {
        if (result === 'imported') {
          logger.info(
            `[${name}] 已把 ${file} 里的 ${resolved.apiKeyRef} 导入 DSH 凭据库；之后可以删掉该文件里的明文 key，并移除 importEnvFile 配置`,
          );
        } else if (result === 'read-only') {
          logger.info(`[${name}] ${resolved.apiKeyRef} 由启动环境变量提供（只读），跳过从 ${file} 导入`);
        } else if (result === 'unavailable') {
          logger.warn(`[${name}] 凭据服务不可用，无法从 ${file} 导入 ${resolved.apiKeyRef}`);
        }
        // configured / absent：已经有 key 或文件里没有，都无需提示
      })
      .catch((error) => {
        logger.warn(`[${name}] 导入 ${resolved.apiKeyRef} 失败：${error instanceof Error ? error.message : String(error)}`);
      });
  });
}

/**
 * 日志适配：宿主 Context 通常带 logger（dsh-pet 等既有插件同样优先用它），
 * 拿不到时退回 console，保证任何情况下都有输出而不是静默失败。
 */
function normalizeLogger(ctx) {
  const candidate = ctx?.logger;
  const fallback = console;
  const pick = (method) =>
    typeof candidate?.[method] === 'function' ? candidate[method].bind(candidate) : fallback[method].bind(fallback);
  return {
    info: pick('info'),
    warn: pick('warn'),
    error: pick('error'),
  };
}
