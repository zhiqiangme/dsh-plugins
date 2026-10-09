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
 * 后端就绪后拉一次 `/v1/models`，把「后端真实提供的模型」写回 profile 的
 * `llm-pi-ai.providers.workbuddy.models`，名字统一成 `<CN|GL> <上游名> <倍率>`。
 * 细节与取舍见 lib/models.js 顶部注释；默认关闭，不会擅自改用户的 profile。
 *
 * 本插件刻意只依赖 node: 内置模块，理由见 lib/services.js 顶部注释。
 *
 * 与 dsh-autostart-websearch 是同级插件：两者都托管一个本地 HTTP 上游，
 * 但各自独立开关、独立日志。这里的进程托管原语是刻意各自持有一份而非抽公共包——
 * 两个包都走 file: 协议挂载，引入第三个包会带来传递依赖解析与加载顺序的不确定性，
 * 而这份原语不到 200 行，复制一份比引入一层依赖更稳。
 */

import { resolvePluginConfig } from './config.js';
import { syncModels } from './models.js';
import { ManagedService } from './services.js';
import { registerPanelRoutes } from './web.js';

/** 插件名（日志前缀）。 */
export const name = 'dsh-autostart-workbuddy';

/**
 * 不注入任何 Host Service：本插件的核心工作（spawn 外部进程 + 探测端口 + 改 profile）
 * 只用 node 内置模块，不依赖加载顺序，也不会因为某个 Service 缺席而整个插件不激活。
 *
 * Web 面板要用宿主 webserver，但那是"用得上就用"：在 apply 里软取（见 web.js 的
 * resolveWebServer），拿不到只少一个面板，不影响拉起后端与同步模型列表。
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

  logger.info(
    `[${name}] 准备托管 ${service.title} (${service.port})；日志目录 ${resolved.logDir}`,
  );

  // Web 面板路由（浏览器半侧 lib/client.js 的取数口）。与后端启动无关，先挂上：
  // 这样后端还没起来时打开面板也能看到"后端不可达"的具体原因。
  registerPanelRoutes(ctx, { logger, resolved, env: hostEnv });

  // 后台启动：不 await，避免拖慢插件树加载。
  const startup = start(service, logger);

  // 模型列表同步：等后端就绪后再拉 `/v1/models` 回写 profile（见 lib/models.js）。
  // 同样不 await：拉取可能耗时数十秒，不能拖住插件树加载。
  syncAfterStartup(startup, resolved, hostEnv, logger);

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
function syncAfterStartup(startup, resolved, hostEnv, logger) {
  if (!resolved.models.enabled) return;

  startup
    .then((result) => {
      if (result?.state === 'failed') {
        logger.warn(`[${name}] 后端未就绪，跳过模型列表同步`);
        return undefined;
      }
      return syncModels({ spec: resolved.spec, models: resolved.models, env: hostEnv });
    })
    .then((result) => {
      if (!result) return;
      if (result.state === 'updated') {
        logger.info(`[${name}] 模型列表已同步 ${result.entries.length} 个模型 → ${result.patchPath}（下次启动生效）`);
      } else if (result.state === 'unchanged') {
        logger.info(`[${name}] 模型列表已是最新（${result.entries.length} 个模型）`);
      } else if (result.state !== 'disabled' && result.state !== 'dry-run') {
        logger.warn(`[${name}] 模型列表未同步：${result.reason ?? result.state}`);
      }
    })
    .catch((error) => {
      logger.warn(`[${name}] 模型列表同步出错：${error instanceof Error ? error.message : String(error)}`);
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
