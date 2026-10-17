/**
 * dsh-tavily-search —— 用 Tavily 给 DSH 的「网页搜索」供数。
 *
 * DSH 有两代搜索提供方，本插件在同一个端口上把两套请求都翻译成 Tavily 检索
 * （细节见 lib/shim.js）：
 *   - 旧版 @deepseek-ai/dsh-web-search-deepseek 向 `{接口地址}/messages` 发 Anthropic
 *     Messages 请求；网页搜索的接口地址指向 `http://127.0.0.1:8787/v1` 即接入。
 *   - 新版 @deepseek-ai/dsh-web-deepseek-api 向 `{基础地址}/search` 发 Search API 请求；
 *     网页搜索页打开「启用新版 Web 搜索 API」后，把 Search API 基础地址指向
 *     `http://127.0.0.1:8787/v1/tools` 即接入（插件页卡片一键完成）。
 *   - 新版 Fetch API（`/fetch`）不模拟：网页抓取仍由 DSH 的本地 HTTP 抓取提供方负责。
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

  const runtime = new ShimRuntime({
    ...resolved,
    resolveApiKey: createKeyResolver(ctx, resolved.apiKeyRefs),
    // 这句会经由 DSH 的搜索错误原样交给模型/用户，所以写清楚去哪里补
    missingKeyHint: `请在 DSH「插件」页的 Tavily 联网搜索卡片里填写（凭据引用 ${resolved.apiKeyRef}）。`,
    logger,
    label: name,
  });

  // 卡片的状态 / 测试路由：与监听结果无关，先挂上，端口冲突时打开卡片也能看到原因
  registerPanelRoutes(ctx, { logger, resolved, runtime, inspectKeys });

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
