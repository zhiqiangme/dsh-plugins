/**
 * dsh-autostart-workbuddy —— DSH 启动时自动拉起 WorkBuddy Panel（wb2api）。
 *
 * 背景：本机的 WorkBuddy Panel（wb2api，127.0.0.1:7863）是 DSH 自己的上游依赖——
 * profile 的 cordis.patch.yml 里 workbuddy provider 的 baseURL 指向
 * `http://127.0.0.1:7863/v1/`。原先它要靠手动运行 scripts/WorkBuddy Panel.ps1
 * （或 Start All.ps1）拉起，本插件把这一步并入 DSH 的启动过程。
 *
 * 行为约定（与手动运行脚本对齐）：
 *   - 只拉起底层程序本身（wb2api.exe），不再经过 pwsh 脚本，省掉一层进程与临时目录；
 *   - 静默启动，不打开 WorkBuddy 管理面板浏览器窗口；
 *   - 幂等：启动前先探测端口，已在监听就跳过，绝不拉起第二个实例；
 *   - 失败不阻断 DSH 启动：写日志并继续，DSH 本身仍可用；
 *   - DSH 退出时，只停止「本插件自己拉起」的进程，用户手动起的服务不受影响。
 *
 * 除了拉起后端，本插件还接管 WorkBuddy 的**模型列表**（config.models.enabled）：
 * 后端就绪后拉一次 `/v1/models`，经宿主 configEditor 把「后端真实提供的模型」写进
 * `llm-pi-ai.providers.workbuddy.models`，名字统一成 `<CN|GL> <上游名> <倍率>`。
 * 细节与取舍见 lib/models.js 顶部注释；默认关闭，不会擅自改用户的 profile。
 *
 * 本插件刻意只依赖 node: 内置模块，理由见 lib/services.js 顶部注释。
 *
 * 与 dsh-tavily-search 是同级插件：两者都给 DSH 提供一个本地 HTTP 上游，各自独立开关。
 * 那边的适配服务直接在 DSH 进程内监听，不托管外部进程，所以 lib/services.js 这套
 * 进程托管原语只有本插件在用（wb2api.exe 是独立程序，必须 spawn）。
 */

import { isDeepStrictEqual } from 'node:util';

import { checkForUpdate } from './backend.js';
import { resolvePluginConfig } from './config.js';
import { syncModels } from './models.js';
import { createModelResync } from './resync.js';
import { ManagedService, isFile } from './services.js';
import { configEditorOf, credentialsOf, registerPanelRoutes } from './web.js';

/** 插件名（日志前缀）。 */
export const name = 'dsh-autostart-workbuddy';

/**
 * 不注入任何 Host Service：本插件的核心工作（spawn 外部进程 + 探测端口）
 * 只用 node 内置模块，不依赖加载顺序，也不会因为某个 Service 缺席而整个插件不激活。
 *
 * Web 面板要用宿主 webServer、写配置要用宿主 configEditor，都是"用得上就用"：
 * 用时软取（见 web.js 的 hostService），拿不到只少面板或跳过模型同步，不影响拉起后端。
 */
export const inject = [];

/**
 * Cordis 入口。注意本函数必须尽快返回：启动就绪探测最多要等 30s，放在这里会拖住
 * 整个插件树的加载，所以拉起动作在后台进行，apply 只负责登记生命周期。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config profile 中该插件行的 config
 */
export function apply(ctx, config) {
  const hostEnv = process.env;
  const logger = normalizeLogger(ctx);
  const resolved = resolvePluginConfig(config, hostEnv);

  if (!resolved.enabled) {
    logger.info(`[${name}] 已禁用（enabled: false），不启动 WorkBuddy Panel`);
    return;
  }

  const service = new ManagedService(resolved.spec, logger);
  const installed = isFile(resolved.spec.exe);
  // 只有"用插件自管路径、但文件不存在"才当作未安装（提示去面板装）；
  // 用户在 profile 里显式配了 exe 却指错时，仍按老行为尝试启动，让错误暴露出来。
  const notInstalled = !installed && resolved.managedExe === true;

  logger.info(
    notInstalled
      ? `[${name}] 后端未安装（${resolved.spec.exe} 不存在），本次只挂面板；可在插件页点「安装」`
      : `[${name}] 准备托管 ${service.title} (${service.port})；日志目录 ${resolved.logDir}`,
  );

  // Web 面板路由（浏览器半侧 lib/client.js 的取数口）。与后端启动无关，先挂上：
  // 这样后端还没起来（或没装）时打开面板也能看到状态、并就地安装。
  registerPanelRoutes(ctx, { logger, resolved, env: hostEnv, service });

  // 运行中定时重同步模型列表（见 lib/resync.js）：上游下架模型后，DSH 不重启也能跟上。
  const resync = createModelResync({
    resolved, logger, env: hostEnv, name,
    editor: () => configEditorOf(ctx), credentials: () => credentialsOf(ctx),
  });

  // 白名单等 models.* 的改动就地生效，不重启插件（见 watchConfigUpdates）。
  watchConfigUpdates(ctx, resolved, hostEnv, logger, config, resync);

  // 启动时查一次后端更新（**只提示**，安装永远由用户在面板里点）。
  checkBackendUpdateOnStart(resolved, hostEnv, logger);

  // 没装后端就不启动：否则 spawn 必然失败、日志只会刷错误。
  // 生命周期照常登记——用户在面板里点「安装」把后端拉起来之后，DSH 退出仍会把它停掉。
  const startup = notInstalled ? Promise.resolve({ state: 'not-installed' }) : start(service, logger);

  // 模型列表同步：等后端就绪后再拉 `/v1/models`，经宿主 configEditor 写进 llm-pi-ai（见 lib/models.js）。
  // 同样不 await：拉取可能耗时数十秒，不能拖住插件树加载。
  if (!notInstalled) syncAfterStartup(ctx, startup, resolved, hostEnv, logger);

  // 启动流程落地后才开始计时，第一轮不会和启动同步撞在一起。没装后端时也排上：
  // 用户之后在面板里装好并拉起后端，定时同步会接手；后端不在时每轮只探测 /healthz 就跳过。
  startup.finally(() => resync.start()).catch(() => undefined);

  ctx.effect(() => {
    // exit 钩子只做同步发信号：进程退出阶段不允许异步等待，异步等待在下面的 disposer 里。
    const onExit = () => {
      service.stopSync();
    };
    process.once('exit', onExit);

    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      process.removeListener('exit', onExit);
      resync.stop();
      // 先等启动流程落地，避免「正在启动」与「正在停止」互相打架。
      await startup.catch(() => undefined);
      try {
        await service.stop('插件卸载');
      } catch (error) {
        logger.warn(
          `[${name}] 停止 ${service.title} 时出错：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
  }, `${name}: lifecycle`);
}

/**
 * 配置变更的就地刷新。
 *
 * cordis 对配置变更的默认处理是重启插件：先 dispose（把本插件托管的 wb2api 停掉）再重新 apply。
 * 面板每次保存白名单都会改本插件的配置，照默认走就是"点一次保存、后端断一下"。
 * 所以只有 models.* 变了时就地换掉 resolved.models、不调 next()（即否决这次重启）；
 * 端口、exe、env 等别的字段变了仍调 next()，按原样重启让新规格生效。
 * resolved 是 web 路由与同步共用的同一个对象，换掉 models 后下一个请求就用上新值。
 *
 * 比较的是"新旧两份原始配置在同一份当前环境下的解析结果"，而不是拿新配置去比 apply 时的 resolved：
 * resolved.spec.env 是 apply 那一刻 process.env 的快照，DSH 进程运行中只要有任何环境变量变动，
 * 两边就永远不等，每次保存白名单都会落到默认重启——托管的 wb2api 被停掉重拉，紧接着的
 * /v1/models 拉取就是 fetch failed，白名单写进去了、模型清单却没跟上（实际遇到过）。
 */
function watchConfigUpdates(ctx, resolved, hostEnv, logger, initialConfig, resync) {
  if (typeof ctx?.on !== 'function') return;
  let currentConfig = initialConfig;
  ctx.on('internal/update', (config, _noSave, next) => {
    const updated = resolvePluginConfig(config, hostEnv);
    const changed = changedFields(resolvePluginConfig(currentConfig, hostEnv), updated);
    if (changed.length > 0) {
      // 只记字段名不记值：spec.env 里可能有密钥。
      logger.info(`[${name}] 配置变更涉及 ${changed.join(', ')}，按默认流程重启插件`);
      return next();
    }
    currentConfig = config;
    resolved.models = updated.models;
    // 定时同步原先被关掉（resyncIntervalMs: 0）时，按新配置重新排上；已在计时则不动。
    resync?.start();
    logger.info(`[${name}] models 配置已更新（就地生效，不重启插件）`);
    return undefined;
  });
}

/** 两份解析结果里除 models 以外不相等的字段路径（展开到第二层，方便从日志看出是哪一项触发了重启）。 */
export function changedFields(previous, next) {
  const out = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key === 'models' || isDeepStrictEqual(previous[key], next[key])) continue;
    const a = previous[key];
    const b = next[key];
    const nested = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!nested(a) || !nested(b)) {
      out.push(key);
      continue;
    }
    for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!isDeepStrictEqual(a[sub], b[sub])) out.push(`${key}.${sub}`);
    }
  }
  return out;
}

/** 启动失败只记日志：一个上游起不来不应该让 DSH 启动失败。 */
async function start(service, logger) {
  let result;
  try {
    result = await service.ensureRunning();
  } catch (error) {
    result = { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.state === 'failed') {
    logger.error(`[${name}] ${service.title} 启动失败：${result.reason}`);
  }
  return result;
}

/**
 * 后端就绪后同步一次模型列表。
 *
 * 后端没起来就跳过：此时 `/v1/models` 不可信，保持 profile 里现有的清单更好。
 * 同步结果只记日志——模型列表没更新不该影响 DSH 启动（下一次启动会再试）。
 */
function syncAfterStartup(ctx, startup, resolved, hostEnv, logger) {
  if (!resolved.models.enabled) return;

  startup
    .then((result) => {
      if (result?.state === 'failed') {
        logger.warn(`[${name}] 后端未就绪，跳过模型列表同步`);
        return undefined;
      }
      // configEditor / credentials 现取：它们和本插件谁先加载不确定，等到后端就绪时通常早已挂好。
      return syncModels({
        spec: resolved.spec,
        models: resolved.models,
        editor: configEditorOf(ctx),
        credentials: credentialsOf(ctx),
        env: hostEnv,
      });
    })
    .then((result) => {
      if (!result) return;
      if (result.state === 'updated') {
        logger.info(`[${name}] 模型列表已同步 ${result.entries.length} 个模型 → ${result.documentPath}${result.created ? '（已补建 provider）' : ''}`);
      } else if (result.state === 'unchanged') {
        logger.info(`[${name}] 模型列表已是最新（${result.entries.length} 个模型）`);
      } else if (result.state !== 'disabled' && result.state !== 'dry-run') {
        logger.warn(`[${name}] 模型列表未同步：${result.reason ?? result.state}`);
      }
      logCredential(result.credential, logger);
    })
    .catch((error) => {
      logger.warn(`[${name}] 模型列表同步出错：${error instanceof Error ? error.message : String(error)}`);
    });
}

/** 补密钥的结果只在真的写了或失败时记一条；已有值（kept）不打扰。 */
function logCredential(credential, logger) {
  if (!credential) return;
  if (credential.state === 'created' || credential.state === 'replaced') {
    const what = credential.placeholder ? '占位值（网关不鉴权）' : '网关密钥';
    logger.info(`[${name}] 凭据库里没有 ${credential.ref}，已写入${what}`);
  } else if (credential.state === 'failed' || credential.state === 'skipped') {
    logger.warn(`[${name}] 未能补齐网关密钥 ${credential.ref ?? ''}：${credential.reason}`);
  }
}

/**
 * 启动时查一次后端更新，**只写日志提示**，不下载也不安装。
 *
 * 结果走 release 查询缓存（默认 6 小时），所以频繁重启 DSH 不会反复打 GitHub API。
 * 任何失败都只记一条 warn：查更新失败不该影响 DSH 启动。
 */
function checkBackendUpdateOnStart(resolved, hostEnv, logger) {
  const backend = resolved.backend;
  if (!backend?.enabled || !backend.checkOnStart) return;

  checkForUpdate({
    paths: backend.paths,
    env: hostEnv,
    apiBase: backend.apiBase || undefined,
    ttlMs: backend.checkTtlMs,
  })
    .then((check) => {
      const current = check.local.tag ?? check.local.revision?.slice(0, 7) ?? '未知';
      if (check.updateAvailable) {
        logger.info(
          `[${name}] 后端有新版本：${current} → ${check.latest.tag}（在插件页点"更新"安装，不会自动替换）`,
        );
      } else {
        logger.info(`[${name}] 后端已是最新（${check.latest.tag}）`);
      }
    })
    .catch((error) => {
      logger.warn(`[${name}] 检查后端更新失败：${error instanceof Error ? error.message : String(error)}`);
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
