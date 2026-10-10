/**
 * 独立运行入口：不开 DSH 也能起一个同样的搜索接口（排障、给别的客户端用）。
 *
 *   node lib/cli.js                 前台监听，Ctrl+C 退出
 *   node lib/cli.js --print-config  只打印解析出的配置，不监听
 *
 * 独立运行时没有 DSH 凭据库，key 从环境变量读。环境变量沿用旧 tavily-anthropic-search 的命名，
 * 以前的 .env / 启动命令可以原样复用：
 *   TAVILY_API_KEY（必填）、LISTEN（host:port）或 LISTEN_HOST / LISTEN_PORT、TAVILY_BASE_URL、
 *   TAVILY_MAX_RESULTS、TAVILY_SEARCH_DEPTH、SEARCH_TIMEOUT_MS、MAX_QUERY_CHARS、SHIM_API_KEY
 */

import { pathToFileURL } from 'node:url';

import { resolvePluginConfig } from './config.js';
import { createShimServer } from './shim.js';

/** 把旧版环境变量翻成插件 config 的形状，复用同一套校验与默认值。 */
export function configFromEnv(env = process.env) {
  const listen = (env.LISTEN || '').trim();
  const cut = listen.lastIndexOf(':');
  const [listenHost, listenPort] = cut > 0 ? [listen.slice(0, cut), listen.slice(cut + 1)] : ['', ''];
  return {
    host: env.LISTEN_HOST || listenHost || undefined,
    port: env.LISTEN_PORT || listenPort || undefined,
    tavilyBaseUrl: env.TAVILY_BASE_URL,
    maxResults: env.TAVILY_MAX_RESULTS,
    searchDepth: env.TAVILY_SEARCH_DEPTH,
    timeoutMs: env.SEARCH_TIMEOUT_MS,
    maxQueryChars: env.MAX_QUERY_CHARS,
    shimApiKey: env.SHIM_API_KEY,
  };
}

async function main() {
  const resolved = resolvePluginConfig(configFromEnv(process.env));
  const ref = resolved.apiKeyRef;

  if (process.argv.includes('--print-config')) {
    console.log(
      JSON.stringify(
        {
          endpoint: resolved.endpoint,
          apiKeyRef: ref,
          apiKeyConfigured: Boolean(process.env[ref]?.trim()),
          ...resolved.shim,
          shimApiKey: resolved.shim.shimApiKey ? '(已设置)' : '',
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!process.env[ref]?.trim()) {
    console.error(`[dsh-tavily-search] 缺少 ${ref}，无法启动。`);
    process.exitCode = 1;
    return;
  }

  const server = createShimServer({
    ...resolved.shim,
    resolveApiKey: () => process.env[ref],
    missingKeyHint: `请设置环境变量 ${ref}。`,
  });
  server.listen(resolved.port, resolved.host, () => {
    console.log(`[dsh-tavily-search] listening on ${resolved.endpoint}`);
    console.log(`[dsh-tavily-search] Tavily endpoint: ${resolved.shim.tavilyBaseUrl}/search`);
  });
}

// 被测试 import 时不启动服务
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
