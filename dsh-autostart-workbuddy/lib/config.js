/**
 * 配置解析：把 profile 里的插件 config 与内置默认值合并成一个"绝对完整"的服务规格。
 *
 * 不依赖 schemastery：本插件的配置面很小，且少一个外部模块就少一份加载期风险
 * （profile 里的 @deepseek-ai/* 解析依赖 DSH 的模块表，而本插件刻意只依赖 node: 内置模块）。
 * 因此这里用显式白名单 + 类型校正，任何非法输入都退回默认值而不是让插件加载失败。
 */

import { join, resolve } from 'node:path';
import { DEFAULT_EFFORTS } from './models.js';
import { SERVICE_DEFAULTS, resolveDshHome } from './services.js';

/** models 段默认值：默认关闭（不擅自改用户的 profile），开启后默认同步后端全部模型。 */
const MODELS_DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'workbuddy',
  // 面板的模型列表是缓存 1h 的；冷缓存时要等上游，给它 60s（面板自己那侧上限是 120s）。
  timeoutMs: 60_000,
  keepBackups: 3,
});

/** 布尔字段的宽容解析：只有显式 false 才关闭（与 DSH 配置里 enabled 的 opt-out 语义一致）。 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 正数解析：非法值（含 0、NaN、字符串）一律退回默认。 */
function positiveNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringArray(value, fallback) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : fallback;
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/** 只保留字符串值的键值对：子进程 env 不接受非字符串。 */
function stringMap(value) {
  const out = {};
  for (const [key, item] of Object.entries(plainObject(value))) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

/**
 * 合并服务规格。
 *
 * 与旧的多服务版本不同，这里把配置面摊平到顶层（`port` / `exe` / …）而不是
 * `services.workbuddy.*` 再套一层——一个插件只托管一个服务，多一层嵌套只会让
 * profile 里的配置更难读。
 *
 * @param {object} config 插件行的 config（已确认是对象）
 * @param {{ logDir: string, readinessTimeoutMs: number, stopTimeoutMs: number }} common
 * @param {NodeJS.ProcessEnv} hostEnv 宿主环境
 */
function buildSpec(config, common, hostEnv) {
  return {
    key: SERVICE_DEFAULTS.key,
    enabled: bool(config.enabled, SERVICE_DEFAULTS.enabled),
    title: stringOr(config.title, SERVICE_DEFAULTS.title),
    host: stringOr(config.host, SERVICE_DEFAULTS.host),
    port: positiveNumber(config.port, SERVICE_DEFAULTS.port),
    cwd: resolve(stringOr(config.cwd, SERVICE_DEFAULTS.cwd)),
    exe: stringOr(config.exe, SERVICE_DEFAULTS.exe),
    args: stringArray(config.args, SERVICE_DEFAULTS.args),
    logName: stringOr(config.logName, SERVICE_DEFAULTS.logName),
    logDir: common.logDir,
    readinessTimeoutMs: common.readinessTimeoutMs,
    stopTimeoutMs: common.stopTimeoutMs,
    // 子进程环境：默认继承宿主环境，只叠加本插件的覆盖项，宿主 process.env 不被改写。
    env: { ...hostEnv, ...stringMap(config.env) },
  };
}

/**
 * 解析 models 段（模型列表同步）。
 *
 * `enabled` 默认 false：插件默认只负责拉起后端，改 profile 是显式选择。
 * 一旦开启，`only` 为空表示同步后端全部模型，非空则只保留列出的 id（按列出顺序展示）。
 *
 * @param {unknown} raw config.models
 * @param {object} spec 已解析的服务规格（用来推 /v1/models 与面板 config.json 的默认路径）
 */
function resolveModelsConfig(raw, spec) {
  const models = plainObject(raw);
  return {
    enabled: bool(models.enabled, MODELS_DEFAULTS.enabled),
    only: stringArray(models.only, []),
    exclude: stringArray(models.exclude, []),
    // `auto` = 按上游声明的档位生成；否则用给定档位（默认低/高/最大三档）。
    efforts: models.efforts === 'auto' ? 'auto' : stringArray(models.efforts, DEFAULT_EFFORTS),
    provider: stringOr(models.provider, MODELS_DEFAULTS.provider),
    // 空字符串 = 由 DSH_PROFILE_DIR / DSH_PROFILE 推导。
    profilePatch: stringOr(models.profilePatch, ''),
    panelConfig: stringOr(models.panelConfig, spec.cwd ? join(spec.cwd, 'config.json') : ''),
    // 空 = 依次尝试 WORKBUDDY_PROXY_KEY 与面板 config.json 的 api_key。
    apiKey: stringOr(models.apiKey, ''),
    baseURL: stringOr(models.baseURL, `http://${spec.host}:${spec.port}`),
    timeoutMs: positiveNumber(models.timeoutMs, MODELS_DEFAULTS.timeoutMs),
    keepBackups: positiveNumber(models.keepBackups, MODELS_DEFAULTS.keepBackups),
  };
}

/**
 * 解析完整插件配置。
 *
 * @param {unknown} raw profile 里该插件行的 config
 * @param {NodeJS.ProcessEnv} hostEnv
 * @returns {{ enabled: boolean, logDir: string, spec: object, models: object }}
 */
export function resolvePluginConfig(raw, hostEnv = process.env) {
  const config = plainObject(raw);

  const dshHome = resolveDshHome(hostEnv);
  // 日志落在 DSH home 下：与宿主同生命周期，卸载/清理时一眼能找到。
  // 目录名与 dsh-autostart-websearch 分开，两个插件的日志不混在一起。
  const logDir = resolve(stringOr(config.logDir, resolve(dshHome, 'autostart-workbuddy', 'logs')));

  const spec = buildSpec(
    config,
    {
      logDir,
      readinessTimeoutMs: positiveNumber(config.readinessTimeoutMs, 30_000),
      stopTimeoutMs: positiveNumber(config.stopTimeoutMs, 5_000),
    },
    hostEnv,
  );

  return { enabled: spec.enabled, logDir, spec, models: resolveModelsConfig(config.models, spec) };
}

/** 供 `node lib/cli.js` 之类的排障入口使用（不启动任何东西）。 */
export function describeConfig(resolved) {
  const spec = resolved.spec;
  return {
    key: spec.key,
    title: spec.title,
    endpoint: `${spec.host}:${spec.port}`,
    exe: spec.exe,
    cwd: spec.cwd,
    args: spec.args,
    logDir: spec.logDir,
  };
}
