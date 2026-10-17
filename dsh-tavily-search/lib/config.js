/**
 * 配置解析：把 profile 里的插件 config 与内置默认值合并成一份"绝对完整"的规格。
 *
 * 不依赖 schemastery：本插件的配置面很小，且少一个外部模块就少一份加载期风险
 * （profile 里的 @deepseek-ai/* 解析依赖 DSH 的模块表，而本插件刻意只依赖 node: 内置模块）。
 * 因此这里用显式白名单 + 类型校正，任何非法输入都退回默认值而不是让插件加载失败。
 *
 * API Key 不在这里：配置只携带凭据**引用名**（apiKeyRef，默认 TAVILY_API_KEY），
 * 值存在 DSH 凭据库（~/.dsh/.credentials.yaml），由插件页卡片写入。
 * 支持多个 key：第 1 个就是 apiKeyRef 本身，其余按 `<apiKeyRef>_2` … `<apiKeyRef>_N` 编号
 * （见 apiKeyRefsFor）。
 */

import { existsSync, readFileSync } from 'node:fs';

import { SHIM_DEFAULTS } from './shim.js';

/** 凭据引用名的文法：与 @deepseek-ai/dsh-credentials 的 REF_PATTERN 一致（POSIX 环境变量名）。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Tavily 只认这两档；其它值（含空串）都按"不传，交给 Tavily 默认"处理。 */
const SEARCH_DEPTHS = new Set(['basic', 'advanced']);

/**
 * 最多几个 key。凭据库没有"列出所有引用"的接口，只能按固定编号逐个 describe，
 * 所以必须有上限；10 个对"多个免费额度轮流用"绰绰有余，一次 describe 也不重。
 */
export const MAX_API_KEYS = 10;

/**
 * 一组 key 的凭据引用名：第 1 个沿用 apiKeyRef 本身（兼容只有一个 key 的老配置），
 * 之后是 `<ref>_2` … `<ref>_N`。后缀只含数字与下划线，拼出来仍满足凭据库的引用文法。
 */
export function apiKeyRefsFor(ref, count = MAX_API_KEYS) {
  const refs = [ref];
  for (let index = 2; index <= count; index += 1) refs.push(`${ref}_${index}`);
  return refs;
}

export const PLUGIN_DEFAULTS = Object.freeze({
  enabled: true,
  host: '127.0.0.1',
  /** DSH 网页搜索的接口地址就指向这个端口（http://127.0.0.1:8787/v1），改了要同步改那边。 */
  port: 8787,
  apiKeyRef: 'TAVILY_API_KEY',
});

/** 布尔字段的宽容解析：只有显式 false 才关闭（与 DSH 配置里 enabled 的 opt-out 语义一致）。 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 正整数解析：非法值（含 0、NaN、小数以外的字符串）一律退回默认。 */
function positiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 端口额外限制在 1–65535：超范围的数字 listen 会直接抛。 */
function port(value, fallback) {
  const n = positiveInt(value, fallback);
  return n <= 65535 ? n : fallback;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * 读取 .env（KEY=VALUE，`#` 开头为注释）。只取第一个 `=` 之前作为键，键为空则跳过。
 * 仅用于"一次性导入旧 key"，结果绝不写回 process.env。
 */
export function parseEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 解析完整插件配置。
 *
 * @param {unknown} raw profile 里该插件行的 config
 */
export function resolvePluginConfig(raw) {
  const config = plainObject(raw);
  const host = stringOr(config.host, PLUGIN_DEFAULTS.host);
  const listenPort = port(config.port, PLUGIN_DEFAULTS.port);
  const ref = stringOr(config.apiKeyRef, PLUGIN_DEFAULTS.apiKeyRef);
  const depth = typeof config.searchDepth === 'string' ? config.searchDepth.trim() : '';
  const apiKeyRef = CREDENTIAL_REF_PATTERN.test(ref) ? ref : PLUGIN_DEFAULTS.apiKeyRef;

  return {
    enabled: bool(config.enabled, PLUGIN_DEFAULTS.enabled),
    host,
    port: listenPort,
    /** DSH 网页搜索的"接口地址"应当填的值；卡片据此判断是否已接入。 */
    endpoint: `http://${host}:${listenPort}/v1`,
    /**
     * 新版 Search API 的基础地址：DSH 的 web-deepseek-api 会在这个地址后追加 /search。
     * 网页搜索页打开「启用新版 Web 搜索 API」后，卡片把 Search API 基础地址改成它。
     */
    apiEndpoint: `http://${host}:${listenPort}/v1/tools`,
    apiKeyRef,
    /** 全部 key 槽位的引用名，按使用顺序排列；第 1 个就是 apiKeyRef。 */
    apiKeyRefs: apiKeyRefsFor(apiKeyRef),
    /**
     * 一次性导入：凭据库里还没有 key 时，从这个 .env 里取同名变量写进凭据库。
     * 默认不导入；迁移旧的 tavily-anthropic-search 时在 profile 里显式配置。
     */
    importEnvFile: stringOr(config.importEnvFile, ''),
    shim: {
      tavilyBaseUrl: stringOr(config.tavilyBaseUrl, SHIM_DEFAULTS.tavilyBaseUrl).replace(/\/+$/, ''),
      maxResults: positiveInt(config.maxResults, SHIM_DEFAULTS.maxResults),
      searchDepth: SEARCH_DEPTHS.has(depth) ? depth : '',
      timeoutMs: positiveInt(config.timeoutMs, SHIM_DEFAULTS.timeoutMs),
      maxQueryChars: positiveInt(config.maxQueryChars, SHIM_DEFAULTS.maxQueryChars),
      shimApiKey: typeof config.shimApiKey === 'string' ? config.shimApiKey : SHIM_DEFAULTS.shimApiKey,
    },
  };
}
