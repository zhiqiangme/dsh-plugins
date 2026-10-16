/**
 * 运行中的模型列表定时重同步。
 *
 * 启动时和卡片「保存并同步」各同步一次还不够：后端每隔几分钟刷新上游目录，并隐藏已下架或
 * 协议不支持的模型（例如 OpenCode Zen 下架 step-5-preview-free）。DSH 不重启时 profile 里
 * 仍留着旧条目，用户选中它的每个请求都会被后端以 400 拒绝。这里按低频间隔复用 syncModels，
 * 沿用它的保护：空列表不清空、只在有变化时写；另外：
 *   - 后端 `/healthz` 不通或未就绪（上游目录还没加载好）时整轮跳过；
 *   - 移除模型要连续两轮确认（removalGuard），避免一次刷新抖动把模型删掉又加回来。
 */

import { probeHealthz } from './backend.js';
import { syncModels } from './models.js';

/** 探测 /healthz 的地址：跟随 models.baseURL（可能指向外部实例），解析不了再退回托管端口。 */
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
 * @param {Function} [options.probe] 测试替身：默认 probeHealthz
 * @param {Function} [options.sync]  测试替身：默认 syncModels
 * @param {string} [options.name]    日志前缀
 */
export function createModelResync(options) {
  const { resolved, logger, editor, credentials, env = process.env, probe = probeHealthz, sync = syncModels, name = 'dsh-opencode2api' } = options;
  const removalGuard = { missing: new Set() };
  let timer;
  let running;
  let stopped = false;
  // 同一原因只记一次：后端长时间没起来时不能每 10 分钟刷一条 warn。
  let lastNote;

  const note = (level, text) => {
    if (text === lastNote) return;
    lastNote = text;
    logger[level](`[${name}] ${text}`);
  };

  async function runOnce() {
    const models = resolved.models;
    if (!models?.enabled) return { state: 'disabled' };

    const health = await probe(healthTarget(models.baseURL, resolved.spec));
    if (!health.ok || !health.servable) {
      const result = { state: 'not-ready', reason: health.ok ? '后端上游目录未就绪' : health.reason };
      note('info', `定时同步跳过：${result.reason}`);
      return result;
    }

    const result = await sync({
      spec: resolved.spec, models, editor: editor(), credentials: credentials(), env, removalGuard,
    });
    if (result.state === 'updated') {
      lastNote = undefined;
      logger.info(`[${name}] 定时同步：模型列表已更新为 ${result.entries.length} 个模型 → ${result.documentPath}`);
    } else if (result.state === 'deferred') {
      note('info', `定时同步：${result.reason}`);
    } else if (result.state === 'unchanged') {
      lastNote = undefined;
    } else if (result.state !== 'disabled') {
      note('warn', `定时同步未完成：${result.reason ?? result.state}`);
    }
    return result;
  }

  /** 单轮同步；上一轮还没结束就跳过，避免两轮交错（确认状态也会乱）。 */
  function tick() {
    if (running) return running;
    running = runOnce()
      .catch((error) => {
        note('warn', `定时同步出错：${error instanceof Error ? error.message : String(error)}`);
        return { state: 'failed' };
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

  return {
    tick,
    /** 排上定时链；已在跑时什么也不做（正在进行的一轮结束后会自己续上）。 */
    start() {
      if (running) return;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    get removalGuard() {
      return removalGuard;
    },
  };
}
