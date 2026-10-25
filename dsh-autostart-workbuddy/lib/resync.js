/**
 * 运行中的模型列表重同步，由定时器与面板刷新共用。
 *
 * 启动时和卡片「保存并同步」各同步一次还不够：上游下架模型后，wb2api 的 `/v1/models` 不再列出它，
 * 但 DSH 不重启时 profile 里仍留着旧条目，用户选中它的请求都会失败。这里按低频间隔复用 syncModels，
 * 沿用它的保护：空列表不清空、白名单里已不存在的 id 直接滤掉、只在有变化时写；另外：
 *   - 后端健康探针（wb2api 的 `/healthz` / hub 的 `/health`）不通，或账号池暂无可用账号（此时目录不可信）时整轮跳过；
 *   - 已选且已有的模型缺席时保留清单；其余移除需两轮确认，HUB 的同批缓存或降级目录不累计确认。
 *   - 任一对话正在运行时延后整轮同步，空闲后的下一轮再拉取最新目录。
 *
 * 网关密钥：syncModels 每轮会调 ensureProxyCredential，它只读凭据库，值已在（且不是占位值）就不写，
 * 所以定时同步不会每轮重写 WORKBUDDY_PROXY_KEY；推迟写入的那一轮连读都不读。
 *
 * hub 一次只服务一个出口（国内 / 国际），用户在 hub 看板顶部切换。为了让 DSH 的模型列表跟着换：
 *   - 每 REALM_POLL_MS 探一次 hub 的 `/health`（它报当前出口，hub 也不给这条请求记日志），
 *     出口变了就立即同步一轮，不等下一个 resyncIntervalMs；
 *   - 出口切换后的那一轮跳过"移除要连续两轮确认"：模型变少是用户切出口的结果，不是上游抖动。
 * 白名单按出口分开记（cn: / global: 键，见 models.js 的 selectionKey），所以切过去用的是那个出口自己的勾选。
 * 双区域时两个出口合在同一分组中，按模型 id 路由，不需要随看板出口变化重写清单。
 */

import { gatewayDriver } from './gateway.js';
import { syncModels } from './models.js';
import { modelSyncBlocked } from './model-sync-guard.js';

/** 探 hub 当前出口的间隔：探的是本机 /health（不鉴权、hub 不记日志），几秒一次的开销可以忽略。 */
export const REALM_POLL_MS = 5_000;

/** 健康探针的地址：跟随 models.baseURL（可能指向外部实例），解析不了再退回托管端口。 */
export function healthTarget(baseURL, spec) {
  try {
    const url = new URL(baseURL);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    return { host: url.hostname, port };
  } catch {
    return { host: spec.host, port: spec.port };
  }
}

/**
 * @param {object} options
 * @param {object} options.resolved      插件解析结果；models 可能被 internal/update 就地替换，每轮现读
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {() => object | undefined} options.editor       现取宿主 configEditor
 * @param {() => object | undefined} options.credentials  现取宿主凭据服务
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Function} [options.probe] 测试替身：默认按网关取（wb2api 探 /healthz，hub 探 /health）
 * @param {Function} [options.sync]  测试替身：默认 syncModels
 * @param {string} [options.name]    日志前缀
 * @param {number} [options.realmPollMs] 测试用：探 hub 出口的间隔
 * @param {() => string | undefined} [options.syncBlocker] 宿主运行状态检查；返回原因时禁止自动同步
 */
export function createModelResync(options) {
  const {
    resolved, logger, editor, credentials, env = process.env, probe = gatewayDriver(options.resolved).probe, sync = syncModels,
    name = 'dsh-autostart-workbuddy', realmPollMs = REALM_POLL_MS, syncBlocker,
  } = options;
  const removalGuard = { missing: new Set() };
  // 只有 hub 一次只服务一个出口；wb2api 两个出口同时列出，不需要盯。
  const watchRealm = resolved.gateway === 'hub';
  let timer;
  let realmTimer;
  let running;
  let stopped = false;
  let lastSync;
  // DSH 里的模型列表最后一次是按哪个出口同步的；undefined = 还不知道（第一次探到时记下）。
  let syncedRealm;
  // 已为哪个出口立即同步过一次：那一轮没成（新出口暂无可用账号等）就交给定时同步重试，
  // 不能每 REALM_POLL_MS 都再打一次 /v1/models（hub 会给每次模型请求记一行日志）。
  let attemptedRealm;
  // 同一原因只记一次：后端长时间没起来时不能每轮刷一条 warn。
  let lastNote;

  const note = (level, text) => {
    if (text === lastNote) return;
    lastNote = text;
    logger[level](`[${name}] ${text}`);
  };

  /** 补密钥只在真的写了或失败时记；kept / 没有凭据服务（启动同步已提示过）不记。 */
  const logCredential = (credential) => {
    if (credential?.state === 'created' || credential?.state === 'replaced') {
      logger.info(`[${name}] 定时同步：已在凭据库写入 ${credential.ref}${credential.placeholder ? '（占位值，网关不鉴权）' : ''}`);
    } else if (credential?.state === 'failed') {
      note('warn', `定时同步未能补齐网关密钥 ${credential.ref ?? ''}：${credential.reason}`);
    }
  };

  async function runOnce() {
    const models = resolved.models;
    if (!models?.enabled) return { state: 'disabled' };
    const blocked = modelSyncBlocked(syncBlocker);
    if (blocked) {
      note('info', blocked.reason);
      return blocked;
    }

    const health = await probe(healthTarget(models.baseURL, resolved.spec));
    // 双区域的固定分组不看看板出口，不能用当前出口的账号状态挡住另一组目录。
    if (!health.ok || (!models.hubDual && !health.servable)) {
      const result = { state: 'not-ready', reason: health.ok ? '账号池暂无可用账号' : health.reason };
      note('info', `定时同步跳过：${result.reason}`);
      return result;
    }

    const realmSwitched = Boolean(watchRealm && !models.hubDual && syncedRealm && health.realm && health.realm !== syncedRealm);
    if (realmSwitched) {
      // 上个出口的缺席记录对新出口没有意义，清掉，免得之后切回来时被误当成"已确认过一轮"。
      removalGuard.missing = new Set();
      removalGuard.catalogAt = undefined;
      logger.info(`[${name}] hub 出口从 ${syncedRealm} 切到 ${health.realm}，按新出口同步模型列表`);
    }
    const result = await sync({
      spec: resolved.spec, models, editor: editor(), credentials: credentials(), env, syncBlocker,
      removalGuard: realmSwitched ? undefined : removalGuard,
      // 区域分组不随看板出口变化，切换那一轮也照常要两轮确认。
      regionGuard: removalGuard,
    });
    if (watchRealm && ['updated', 'unchanged', 'deferred'].includes(result.state)) {
      syncedRealm = result.realm ?? health.realm ?? syncedRealm;
    }
    if (result.state === 'updated') {
      lastNote = undefined;
      logger.info(`[${name}] 定时同步：模型列表已更新为 ${result.entries.length} 个模型 → ${result.documentPath}`);
    } else if (result.state === 'deferred' || result.state === 'busy') {
      note('info', `定时同步：${result.reason}`);
    } else if (result.state === 'unchanged') {
      lastNote = undefined;
    } else if (result.state !== 'disabled') {
      note('warn', `定时同步未完成：${result.reason ?? result.state}`);
    }
    logCredential(result.credential);
    return result;
  }

  /** 单轮同步；上一轮还没结束就跳过，避免两轮交错（确认状态也会乱）。 */
  function tick() {
    if (running) return running;
    running = runOnce()
      .then((result) => { lastSync = { at: new Date().toISOString(), state: result.state }; return result; })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        note('warn', `定时同步出错：${reason}`);
        return { state: 'failed', reason };
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  /**
   * 间隔每次现读：models.resyncIntervalMs 改了下一轮生效；0 表示关闭（配置改回非 0 时由 start() 重新排上）。
   * 已排着一个定时器就不再排，保证任何时候只有一条定时链。
   */
  function schedule() {
    const interval = resolved.models?.resyncIntervalMs;
    if (stopped || timer || !(interval > 0)) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick().then(schedule);
    }, interval);
    // 不让这个定时器拖住进程退出。
    timer.unref?.();
  }

  /**
   * 盯 hub 的出口：变了就立即同步一轮。与定时同步同一个开关：models 没开或 resyncIntervalMs 为 0
   * （用户关了后台同步）时只空转、不探测。tick 自带去重，与定时那一轮撞上时共用同一轮。
   */
  async function checkRealm() {
    const models = resolved.models;
    if (stopped || !models?.enabled || models.hubDual || !(models.resyncIntervalMs > 0)) return;
    if (modelSyncBlocked(syncBlocker)) return;
    const health = await probe(healthTarget(models.baseURL, resolved.spec)).catch(() => undefined);
    if (stopped || !health?.ok || typeof health.realm !== 'string') return;
    // 还不知道 DSH 是按哪个出口同步的（插件刚启动，启动同步不经过这里）：以现在为准。
    if (syncedRealm === undefined) {
      syncedRealm = health.realm;
      return;
    }
    if (health.realm === syncedRealm) {
      attemptedRealm = undefined;
      return;
    }
    if (health.realm === attemptedRealm) return;
    if (running) {
      // tick 会复用旧任务；等它落地后重新探出口，不能把旧出口的同步算成新出口已经尝试过。
      // 等待期间用户也可能再次切换，必须以最新探针为准；关闭插件后不再补任务。
      await running;
      if (!stopped) await checkRealm();
      return;
    }
    attemptedRealm = health.realm;
    const result = await tick();
    // 运行状态在探针/拉目录期间可能变化；延后不算已经尝试过新出口，空闲后仍需及时补同步。
    if (result.state === 'busy') attemptedRealm = undefined;
  }

  function scheduleRealm() {
    if (stopped || realmTimer || !watchRealm) return;
    realmTimer = setTimeout(() => {
      realmTimer = undefined;
      checkRealm().catch(() => undefined).then(scheduleRealm);
    }, realmPollMs);
    realmTimer.unref?.();
  }

  return {
    tick,
    get status() { return { realm: syncedRealm, dual: resolved.models.hubDual === true, ...lastSync }; },
    /** 面板同步进行中也要排上定时链；timer 到期时 tick 会复用正在进行的一轮。 */
    start() {
      schedule();
      scheduleRealm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (realmTimer) clearTimeout(realmTimer);
      timer = undefined;
      realmTimer = undefined;
    },
    get removalGuard() {
      return removalGuard;
    },
  };
}
