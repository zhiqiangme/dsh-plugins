/**
 * 配置解析：把 profile 里的插件 config 与内置默认值合并成一个"绝对完整"的服务规格。
 *
 * 不依赖 schemastery：本插件的配置面很小，且少一个外部模块就少一份加载期风险
 * （profile 里的 @deepseek-ai/* 解析依赖 DSH 的模块表，而本插件刻意只依赖 node: 内置模块）。
 * 因此这里用显式白名单 + 类型校正，任何非法输入都退回默认值而不是让插件加载失败。
 */

import { join, resolve } from 'node:path';
import { DEFAULT_AUTO_UPDATE_DELAY_HOURS } from './auto-update.js';
import { backendPaths, DEFAULT_CHECK_TTL_MS, DEFAULT_KEEP_VERSIONS } from './backend.js';
import { DEFAULT_CN_CHAT_BASE } from './backend-config.js';
import { normalizeGateway } from './gateway.js';
import { DEFAULT_HUB_KEEP_VERSIONS, hubPaths, readHubApiKey } from './hub.js';
import { DEFAULT_EFFORTS, panelApiKey } from './models.js';
import { SERVICE_DEFAULTS, resolveDshHome } from './services.js';

/** models 段默认值：默认关闭（不擅自改用户的 profile），开启后默认同步后端全部模型。 */
const MODELS_DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'workbuddy',
  // 面板的模型列表是缓存 1h 的；冷缓存时要等上游，给它 60s（面板自己那侧上限是 120s）。
  timeoutMs: 60_000,
  // 本地目录已有缓存，每分钟检查恢复；只有清单变化时才写配置。
  resyncIntervalMs: 60_000,
});

/** 定时重同步的下限：再短只会反复打 /v1/models，面板的目录本身也没刷新那么快。 */
const MIN_RESYNC_INTERVAL_MS = 60_000;

/** 0 = 关闭定时重同步；其它非法值退回默认，过小的值抬到下限。 */
function resyncInterval(value) {
  if (value === 0 || value === '0') return 0;
  return Math.max(positiveNumber(value, MODELS_DEFAULTS.resyncIntervalMs), MIN_RESYNC_INTERVAL_MS);
}

/** 布尔字段的宽容解析：只有显式 false 才关闭（与 DSH 配置里 enabled 的 opt-out 语义一致）。 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 正数解析：非法值（含 0、NaN、字符串）一律退回默认。 */
function positiveNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 非负数解析：0 是合法值（例如不要发布冷却期），负数、空串与非法值退回默认。 */
function nonNegativeNumber(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
 * @param {{ logDir: string, paths: object, readinessTimeoutMs: number, stopTimeoutMs: number }} common
 * @param {NodeJS.ProcessEnv} hostEnv 宿主环境
 */
function buildSpec(config, common, hostEnv) {
  return {
    key: SERVICE_DEFAULTS.key,
    enabled: bool(config.enabled, SERVICE_DEFAULTS.enabled),
    title: stringOr(config.title, SERVICE_DEFAULTS.title),
    host: stringOr(config.host, SERVICE_DEFAULTS.host),
    port: positiveNumber(config.port, SERVICE_DEFAULTS.port),
    // 默认指向插件自管的后端目录（布局见 backend.js），profile 里可以覆盖。
    cwd: resolve(stringOr(config.cwd, common.paths.current)),
    exe: stringOr(config.exe, common.paths.exe),
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
 * hub 网关的服务规格：程序是自带运行时里的 python.exe 跑 wb_proxy.py。
 *
 * exe / cwd / args 不吃 profile 的覆盖：那三项是给 wb2api 写的（老配置里可能指着别处的
 * wb2api.exe），切到 hub 时套用只会起错程序。账号与用量目录放在 hub/data/ 下，
 * 换版本整目录替换程序时不受影响。
 *
 * 密钥走环境变量 API_KEY（hub 认它，见其 --api-key 默认值），不放命令行，免得出现在进程列表里。
 */
function buildHubSpec(config, common, hostEnv, apiKey, cnChatBase) {
  const paths = common.paths;
  const host = stringOr(config.host, SERVICE_DEFAULTS.host);
  const port = positiveNumber(config.port, SERVICE_DEFAULTS.port);
  const env = { ...hostEnv, ...stringMap(config.env) };
  // 宿主环境里的 Python 设置会让自带运行时去加载别处的标准库或 site-packages。
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP']) delete env[key];
  Object.assign(env, {
    // 子进程 stdout 是管道：不关缓冲，日志要等进程退出才写进文件。
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
  });
  if (apiKey) env.API_KEY = apiKey;
  // 国内版上游改址（与 wb2api 的 cn.chat_base 同一用途）。WB_CN_CHAT_UPSTREAM 是 fork 里给 hub 加的开关
  // （zhiqiangme/workbuddy2api-hub fix/cn-chat-upstream，待合入上游）；不认它的 hub 版本会忽略，行为不变。
  // cnChatBase 为空 = 用户关掉了这项：连宿主环境里的同名变量也不透传，免得插件说关了却仍生效。
  delete env.WB_CN_CHAT_UPSTREAM;
  if (cnChatBase) env.WB_CN_CHAT_UPSTREAM = cnChatBase;
  return {
    key: SERVICE_DEFAULTS.key,
    enabled: bool(config.enabled, SERVICE_DEFAULTS.enabled),
    title: stringOr(config.title, 'WorkBuddy2API Hub'),
    host,
    port,
    cwd: paths.current,
    exe: paths.exe,
    args: [
      paths.script,
      '--host', host,
      '--port', String(port),
      '--accounts-dir', paths.accounts,
      '--usage-dir', paths.usage,
    ],
    logName: 'hub',
    logDir: common.logDir,
    readinessTimeoutMs: common.readinessTimeoutMs,
    stopTimeoutMs: common.stopTimeoutMs,
    env,
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
    panelConfig: stringOr(models.panelConfig, spec.cwd ? join(spec.cwd, 'config.json') : ''),
    // 空 = 依次尝试 WORKBUDDY_PROXY_KEY 与面板 config.json 的 api_key。
    apiKey: stringOr(models.apiKey, ''),
    baseURL: stringOr(models.baseURL, `http://${spec.host}:${spec.port}`),
    timeoutMs: positiveNumber(models.timeoutMs, MODELS_DEFAULTS.timeoutMs),
    resyncIntervalMs: resyncInterval(models.resyncIntervalMs),
  };
}

/**
 * 解析 backend 段（后端版本管理）。
 *
 * 默认开启自动更新（autoUpdate）：后台下载发布满 autoUpdateDelayHours 的正式版，下次启动 DSH 时换上，
 * 规则见 lib/auto-update.js。关掉后退回"启动时检查一次、只提示"，安装由用户在面板里点。
 */
function resolveBackendConfig(raw, paths) {
  const backend = plainObject(raw);
  return {
    enabled: bool(backend.enabled, true),
    checkOnStart: bool(backend.checkOnStart, true),
    autoUpdate: bool(backend.autoUpdate, true),
    autoUpdateDelayHours: nonNegativeNumber(backend.autoUpdateDelayHours, DEFAULT_AUTO_UPDATE_DELAY_HOURS),
    checkTtlMs: positiveNumber(backend.checkTtlMs, DEFAULT_CHECK_TTL_MS),
    keepVersions: positiveNumber(backend.keepVersions, DEFAULT_KEEP_VERSIONS),
    /** 覆盖 GitHub API 基址（镜像 / 测试用）；空 = 官方 api.github.com。 */
    apiBase: stringOr(backend.apiBase, ''),
    paths,
  };
}

/**
 * 解析完整插件配置。
 *
 * @param {unknown} raw profile 里该插件行的 config
 * @param {NodeJS.ProcessEnv} hostEnv
 * @returns {{ enabled: boolean, logDir: string, paths: object, spec: object, models: object, backend: object }}
 */
export function resolvePluginConfig(raw, hostEnv = process.env) {
  const config = plainObject(raw);

  const dshHome = resolveDshHome(hostEnv);
  // 日志落在 DSH home 下：与宿主同生命周期，卸载/清理时一眼能找到。
  // 目录名带插件名，与 DSH home 下其它插件的数据目录不混在一起。
  const logDir = resolve(stringOr(config.logDir, resolve(dshHome, 'autostart-workbuddy', 'logs')));

  // 托管哪种网关（见 lib/gateway.js）；两种网关的程序与数据各有一套目录，切换不互相覆盖。
  const gateway = normalizeGateway(config.gateway);
  const wb2apiPaths = backendPaths(hostEnv);
  // 后端自管的目录布局（程序 / 数据 / 缓存分离）；默认 exe 与 cwd 都落在这里。
  const paths = gateway === 'hub' ? hubPaths(hostEnv) : wb2apiPaths;
  const common = {
    logDir,
    paths,
    readinessTimeoutMs: positiveNumber(config.readinessTimeoutMs, 30_000),
    stopTimeoutMs: positiveNumber(config.stopTimeoutMs, 5_000),
  };

  const rawModels = plainObject(config.models);
  // hub 的密钥沿用已有的（含 wb2api 的 api_key），DSH 凭据库里的 WORKBUDDY_PROXY_KEY 就不用改。
  const hubKey = gateway === 'hub'
    ? readHubApiKey({
        explicit: stringOr(rawModels.apiKey, ''),
        env: hostEnv,
        wb2apiKey: panelApiKey(wb2apiPaths.config),
        paths,
      })
    : '';
  // 缺省 = www.workbuddy.cn；显式给空串 = 插件不管这一项。wb2api 写进 config.json 的 cn.chat_base，
  // hub 经环境变量 WB_CN_CHAT_UPSTREAM 生效（见 buildHubSpec）。
  const cnChatBase = typeof config.cnChatBase === 'string' ? config.cnChatBase.trim() : DEFAULT_CN_CHAT_BASE;
  const spec = gateway === 'hub'
    ? buildHubSpec(config, common, hostEnv, hubKey, cnChatBase)
    : buildSpec(config, common, hostEnv);
  const models = resolveModelsConfig(config.models, spec);
  if (gateway === 'hub') {
    // hub 没有 wb2api 那份 config.json：密钥直接给定，不再回落去读面板配置。
    models.apiKey = hubKey;
    models.panelConfig = '';
  }
  const backend = resolveBackendConfig(config.backend, paths);
  backend.kind = gateway;
  if (gateway === 'hub' && plainObject(config.backend).keepVersions === undefined) {
    // hub 每个版本是 30MB+ 的整目录（含 Python 运行时），默认少留一个。
    backend.keepVersions = DEFAULT_HUB_KEEP_VERSIONS;
  }

  return {
    enabled: spec.enabled,
    gateway,
    logDir,
    paths,
    spec,
    models,
    backend,
    recovery: {
      enabled: bool(plainObject(config.recovery).enabled, true),
      maxAttempts: Math.max(1, Math.min(10, Math.floor(positiveNumber(plainObject(config.recovery).maxAttempts, 3)))),
      windowMs: positiveNumber(plainObject(config.recovery).windowMs, 300_000),
      delayMs: positiveNumber(plainObject(config.recovery).delayMs, 1000),
      maxDelayMs: positiveNumber(plainObject(config.recovery).maxDelayMs, 30_000),
    },
    /**
     * 国内版上游 base：wb2api 启动前写进 config.json 的 `cn.chat_base`（见 lib/backend-config.js）；
     * hub 经 spec.env 的 WB_CN_CHAT_UPSTREAM 生效。
     */
    cnChatBase,
    /**
     * exe 是否来自插件自管目录（profile 里没显式配 exe）。
     *
     * 用来区分两种"文件不存在"：自管路径没有 exe = 还没装（面板里点安装）；
     * 用户自己配的 exe 不存在 = 配置错了，仍要按老行为尝试启动，把错误暴露出来。
     */
    managedExe: gateway === 'hub' || !stringOr(config.exe, ''),
  };
}

/** 供 `node lib/cli.js` 之类的排障入口使用（不启动任何东西）。 */
export function describeConfig(resolved) {
  const spec = resolved.spec;
  return {
    gateway: resolved.gateway,
    key: spec.key,
    title: spec.title,
    endpoint: `${spec.host}:${spec.port}`,
    exe: spec.exe,
    cwd: spec.cwd,
    args: spec.args,
    logDir: spec.logDir,
  };
}
