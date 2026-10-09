/**
 * dsh-autostart-websearch —— DSH 启动时自动拉起 tavily-anthropic-search（联网搜索上游）。
 *
 * 背景：本机的 tavily-anthropic-search（Node 服务，127.0.0.1:8787）是 DSH 自己的上游依赖——
 * profile 的 cordis.patch.yml 里 web-search-deepseek 的 baseURL 指向
 * `http://127.0.0.1:8787/v1`。原先它要靠手动运行
 * tavily-anthropic-search/start.ps1（或 scripts/Start All.ps1）拉起，
 * 本插件把这一步并入 DSH 的启动过程。
 *
 * 行为约定（与手动运行脚本对齐）：
 *   - 直接用 node 跑 server.js，不再经过 pwsh 脚本，省掉一层进程与临时目录；
 *   - 静默启动，不弹控制台窗口；
 *   - 幂等：启动前先探测端口，已在监听就跳过，绝不拉起第二个实例；
 *   - 缺 TAVILY_API_KEY 时直接失败并说明原因，不去起一个必然不可用的服务；
 *   - 失败不阻断 DSH 启动：写日志并继续，DSH 本身仍可用；
 *   - DSH 退出时，只停止「本插件自己拉起」的进程，用户手动起的服务不受影响。
 *
 * 本插件刻意只依赖 node: 内置模块，理由见 lib/services.js 顶部注释。
 *
 * 与 dsh-autostart-workbuddy 是同级插件：两者都托管一个本地 HTTP 上游，
 * 但各自独立开关、独立日志。这里的进程托管原语是刻意各自持有一份而非抽公共包——
 * 两个包都走 file: 协议挂载，引入第三个包会带来传递依赖解析与加载顺序的不确定性，
 * 而这份原语不到 200 行，复制一份比引入一层依赖更稳。
 */

import { resolvePluginConfig } from './config.js';
import { ManagedService } from './services.js';

/** 插件名（日志前缀）。 */
export const name = 'dsh-autostart-websearch';

/**
 * 不注入任何 Host Service：本插件的工作（spawn 外部进程 + 探测端口）只用 node 内置模块，
 * 不依赖加载顺序，也不会因为某个 Service 缺席而整个插件不激活。
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
    logger.info(`[${name}] 已禁用（enabled: false），不启动 tavily-anthropic-search`);
    return;
  }

  const service = new ManagedService(resolved.spec, logger);

  logger.info(
    `[${name}] 准备托管 ${service.title} (${service.port})；日志目录 ${resolved.logDir}`,
  );

  // 后台启动：不 await，避免拖慢插件树加载。
  const startup = start(service, logger);

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
