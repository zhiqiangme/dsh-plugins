/**
 * 后端自动更新（wb2api / hub 两种网关共用，经 gateway.js 分发）。
 *
 * 用户多半不会自己去点「更新」，上游修了的问题就一直留在本机。这里把更新拆成两步，都不打断正在用的后端：
 *   1. 运行中（后台定时）：查 release，新版本满足下面的条件时下载、校验、解到 cache/ 暂存
 *      （driver.prepare），把结果记进 cache/auto-update.json 的 pending。不停服务、不碰 current/。
 *   2. 下次 DSH 启动、拉起后端之前（applyPending）：有 pending 就换上（driver.commit）。
 *      此时后端还没在跑，Windows 不锁文件；换完照常健康检查，不通过就自动回滚。
 *
 * 为什么不在运行中直接换：换版本要停后端，正在流式输出的对话会被掐断。
 * 为什么不等启动时再下载：hub 的便携包 30MB+（自带 Python），启动要多等几十秒。
 *
 * 自动安装的条件（evaluateCandidate；任何一条不满足都只记日志、不装。面板上手动「更新」不受这些限制）：
 *   - 只装 GitHub 的 releases/latest（本来就排除预发布），且版本号比当前的新——不做降级；
 *   - 发布满 autoUpdateDelayHours（默认 24h）：上游常一天连发几版，给它留出撤回 / 补丁的时间；
 *   - 当前版本认得出、且没被手动换过（drifted）：用户自己换上的程序不替他覆盖；
 *   - 用户手动回滚过：刚退掉的那个版本不再自动装回去，更新的版本照常；
 *   - 自动安装失败过（校验不过，或换上后健康检查不过已回滚）的版本不再自动重试。
 *
 * 状态文件放在当前网关的 cache/ 下：卸载 / 彻底卸载清 cache/ 时一并清掉，不会留下指向已删文件的 pending。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gatewayDriver, withBackendLock } from './gateway.js';
import { compareVersions } from './update.js';

export const AUTO_UPDATE_FILE = 'auto-update.json';

/** 默认的发布冷却期（小时）。 */
export const DEFAULT_AUTO_UPDATE_DELAY_HOURS = 24;

/** 启动后等多久才做第一轮检查：让后端拉起与模型同步先跑完，别和它们抢网络。 */
const FIRST_CHECK_DELAY_MS = 60_000;

const HOUR_MS = 60 * 60 * 1000;

/** 下载阶段的这些失败说明包本身有问题，同一版本不再自动重试；网络错误（抛异常）不在此列，下一轮照常重试。 */
const PERMANENT_FAILURES = new Set(['verify-failed', 'extract-failed', 'binary-unknown', 'binary-mismatch']);

function emptyState() {
  return { pending: null, failed: null, last: null, lastCheck: null };
}

/** 读状态文件；不存在或坏了都当作空状态（最坏只是多下载一次）。 */
export function readAutoState(paths) {
  try {
    const parsed = JSON.parse(readFileSync(join(paths.cache, AUTO_UPDATE_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

/**
 * 写状态文件（先写临时文件再改名，进程中途被杀也不会留下半截 JSON）。
 * 网关数据根不在（没装过、刚被彻底卸载）就不写：后台检查晚于清除才返回时，不能凭空把目录建回来。
 */
function writeAutoState(paths, state) {
  if (!existsSync(paths.root)) return;
  try {
    mkdirSync(paths.cache, { recursive: true });
    const file = join(paths.cache, AUTO_UPDATE_FILE);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch {
    /* 写不进去不影响功能：下一轮按空状态重来 */
  }
}

/** 删掉暂存的新版本（wb2api 是单个 exe，hub 是整个目录）。 */
function removeStaged(staged) {
  if (!staged?.path) return;
  try {
    rmSync(staged.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 删不掉就留着：下次准备同一版本时会先清掉 */
  }
}

/**
 * 判断 release 能不能自动装（纯函数，便于测试）。
 *
 * @param {{ latest?: { tag?: string, publishedAt?: string }, local?: object, autoState?: object, delayHours?: number, now?: number }} input
 * @returns {{ eligible: true } | { eligible: false, reason: string, tag?: string, readyAt?: number }}
 */
export function evaluateCandidate({ latest, local, autoState, delayHours = DEFAULT_AUTO_UPDATE_DELAY_HOURS, now = Date.now() }) {
  const tag = latest?.tag;
  if (!tag) return { eligible: false, reason: 'no-release' };
  const skip = (reason, extra) => ({ eligible: false, reason, tag, ...extra });
  // 版本号比不出先后（没有安装记录、tag 不是 x.y.z）就不动：宁可不装，也不能把新的换成旧的。
  const order = compareVersions(tag, local?.tag);
  if (!local?.tag || Number.isNaN(order)) return skip('unknown-local');
  if (order <= 0) return skip('up-to-date');
  if (local.drifted) return skip('drifted');
  // 回滚后清单的 previous 记的就是被退掉的那个版本。
  if (local.source === 'rollback' && local.previous?.tag === tag) return skip('rolled-back');
  if (autoState?.failed?.tag === tag) return skip('failed-before');
  const published = Date.parse(latest.publishedAt ?? '');
  if (!Number.isFinite(published)) return skip('no-publish-time');
  const readyAt = published + Math.max(0, Number(delayHours) || 0) * HOUR_MS;
  if (now < readyAt) return skip('too-fresh', { readyAt });
  return { eligible: true };
}

/** 跳过原因 → 日志里的一句话。 */
function skipText(verdict, delayHours) {
  const tag = verdict.tag ?? '';
  switch (verdict.reason) {
    case 'up-to-date':
      return '后端已是最新';
    case 'unknown-local':
      return `认不出当前后端的版本号，不自动更新到 ${tag}（可在插件页手动更新）`;
    case 'drifted':
      return `当前后端程序被手动换过，不自动更新到 ${tag}`;
    case 'rolled-back':
      return `你从 ${tag} 回滚过，自动更新跳过这个版本，等下一个新版本`;
    case 'failed-before':
      return `${tag} 之前自动安装失败过，不再自动重试（可在插件页手动更新）`;
    case 'no-publish-time':
      return `${tag} 没有发布时间，不自动更新`;
    case 'too-fresh':
      return `${tag} 发布未满 ${delayHours} 小时，${new Date(verdict.readyAt).toLocaleString()} 之后再自动下载`;
    default:
      return `不自动更新：${verdict.reason}`;
  }
}

/**
 * 面板用的状态快照（不联网）。
 *
 * @param {object} resolved 插件解析结果
 */
export function autoUpdateStatus(resolved) {
  const backend = resolved?.backend ?? {};
  const state = backend.paths ? readAutoState(backend.paths) : emptyState();
  return {
    enabled: backend.autoUpdate === true,
    // 关了版本管理、或 exe 是用户自己配的：插件不管它的版本，开关无效。
    available: backend.enabled !== false && resolved?.managedExe !== false,
    delayHours: backend.autoUpdateDelayHours ?? DEFAULT_AUTO_UPDATE_DELAY_HOURS,
    pending: state.pending ? { tag: state.pending.tag, preparedAt: state.pending.preparedAt ?? null } : null,
    failed: state.failed,
    last: state.last,
    lastCheck: state.lastCheck,
  };
}

/**
 * @param {object} options
 * @param {object} options.resolved  插件解析结果；backend.autoUpdate 可能被 internal/update 就地改，每次现读
 * @param {{ info: Function, warn: Function, error: Function }} options.logger
 * @param {object} options.service   ManagedService（启动时换装要停 / 起它）
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.name]    日志前缀
 * @param {object} [options.driver]  测试替身：默认按网关取
 * @param {() => number} [options.now]
 * @param {number} [options.firstDelayMs]
 */
export function createAutoUpdater(options) {
  const {
    resolved,
    logger,
    service,
    env = process.env,
    name = 'dsh-autostart-workbuddy',
    driver = gatewayDriver(options.resolved),
    now = Date.now,
    firstDelayMs = FIRST_CHECK_DELAY_MS,
  } = options;
  const paths = resolved.backend?.paths ?? resolved.paths;
  const controller = new AbortController();
  let timer;
  let running;
  let stopped = false;
  // 同一句话只记一次：冷却期内每轮都会得到同样的结论，不能每 6 小时刷一条。
  let lastNote;

  const note = (level, text) => {
    if (text === lastNote) return;
    lastNote = text;
    logger[level](`[${name}] ${text}`);
  };

  const delayHours = () => resolved.backend?.autoUpdateDelayHours ?? DEFAULT_AUTO_UPDATE_DELAY_HOURS;

  /** 不该自动更新的原因；undefined = 可以。 */
  function inactiveReason() {
    const backend = resolved.backend;
    if (!backend?.enabled) return 'backend-disabled';
    if (!backend.autoUpdate) return 'disabled';
    if (resolved.managedExe === false) return 'custom-exe';
    if (!driver.describe(paths).exeExists) return 'not-installed';
    return undefined;
  }

  /** 暂存的版本已不比当前新（用户手动更新过）或已不在了：清掉，免得下次启动拿它去换。 */
  function dropStalePending(state, local) {
    const pending = state.pending;
    if (!pending) return state;
    const order = compareVersions(pending.tag, local?.tag);
    if (Number.isNaN(order) || order > 0) {
      if (existsSync(pending.staged?.path ?? '')) return state;
    }
    removeStaged(pending.staged);
    const next = { ...state, pending: null };
    writeAutoState(paths, next);
    return next;
  }

  async function runOnce() {
    if (stopped) return { state: 'inactive', reason: 'stopped' };
    const inactive = inactiveReason();
    if (inactive) return { state: 'inactive', reason: inactive };

    const check = await driver.check({ paths, env, apiBase: resolved.backend.apiBase || undefined, ttlMs: resolved.backend.checkTtlMs, signal: controller.signal });
    controller.signal.throwIfAborted();
    let state = dropStalePending(readAutoState(paths), check.local);
    const verdict = evaluateCandidate({ latest: check.latest, local: check.local, autoState: state, delayHours: delayHours(), now: now() });
    const checkedAt = new Date(now()).toISOString();
    if (!verdict.eligible) {
      writeAutoState(paths, { ...state, lastCheck: { at: checkedAt, state: 'skipped', reason: verdict.reason, tag: verdict.tag ?? null, readyAt: verdict.readyAt ? new Date(verdict.readyAt).toISOString() : null } });
      note('info', skipText(verdict, delayHours()));
      return { state: 'skipped', reason: verdict.reason, latest: check.latest };
    }
    if (state.pending?.tag === check.latest.tag) return { state: 'pending', latest: check.latest };

    const locked = await withBackendLock('auto-prepare', () =>
      driver.prepare({ paths, env, apiBase: resolved.backend.apiBase || undefined, logger, target: check.latest, signal: controller.signal }),
    );
    if (!locked.acquired) return { state: 'busy', holder: locked.holder };
    const prepared = locked.value;
    if (controller.signal.aborted) {
      // 暂存恰好在关闭前完成时，只清理本轮产物，不发布旧实例的 pending。
      if (prepared.state === 'prepared') removeStaged(prepared.staged);
      return { state: 'cancelled' };
    }
    if (prepared.state === 'cancelled') return { state: 'cancelled' };
    // 下载期间用户可能手动更新过：重新读一次，别把别人写下的结果盖掉。
    state = readAutoState(paths);
    if (prepared.state === 'up-to-date') return { state: 'skipped', reason: 'up-to-date', latest: check.latest };
    if (!prepared.ok) {
      const failed = { tag: check.latest.tag, state: prepared.state, reason: prepared.reason ?? '', at: checkedAt };
      writeAutoState(paths, { ...state, failed: PERMANENT_FAILURES.has(prepared.state) ? failed : state.failed, lastCheck: { at: checkedAt, state: 'failed', reason: prepared.state, tag: check.latest.tag } });
      note('warn', `自动下载后端 ${check.latest.tag} 失败：${prepared.reason ?? prepared.state}`);
      return { state: 'failed', reason: prepared.state, latest: check.latest };
    }

    // 换掉更早暂存的旧版本（例如冷却期内又出了新版）：路径不同才删，同名的刚被新内容覆盖。
    if (state.pending && state.pending.staged?.path !== prepared.staged.path) removeStaged(state.pending.staged);
    const pending = {
      tag: prepared.latest.tag,
      commit: prepared.latest.commit ?? '',
      publishedAt: prepared.latest.publishedAt ?? '',
      staged: prepared.staged,
      preparedAt: checkedAt,
    };
    writeAutoState(paths, { ...state, pending, lastCheck: { at: checkedAt, state: 'prepared', reason: null, tag: pending.tag } });
    note('info', `后端新版本 ${pending.tag} 已下载并校验，下次启动 DSH 时自动安装`);
    return { state: 'prepared', latest: prepared.latest };
  }

  /** 单轮检查；上一轮（可能在下载）还没结束就复用它。 */
  function tick() {
    if (running) return running;
    running = runOnce()
      .catch((error) => {
        if (controller.signal.aborted) return { state: 'cancelled' };
        // 多半是网络（GitHub 不通、下载超时）：不记成版本失败，下一轮照常重试。
        const reason = error instanceof Error ? error.message : String(error);
        writeAutoState(paths, { ...readAutoState(paths), lastCheck: { at: new Date(now()).toISOString(), state: 'error', reason, tag: null } });
        note('warn', `自动检查后端更新失败：${reason}`);
        return { state: 'error', reason };
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  function schedule(delay) {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick().then(() => schedule(resolved.backend?.checkTtlMs));
    }, delay);
    // 不让这个定时器拖住进程退出。
    timer.unref?.();
  }

  /**
   * 启动时换上上次暂存的新版本。必须在拉起后端之前调用（index.js），之后照常 ensureRunning：
   * 换成功时新版本已经在跑，ensureRunning 会认出 already-running。
   *
   * @returns {Promise<object | undefined>} 没有 pending 时为 undefined
   */
  async function applyPending() {
    let state = readAutoState(paths);
    const pending = state.pending;
    if (!pending) return undefined;

    const inactive = inactiveReason();
    if (inactive) {
      // 自动更新被关掉、改用自配 exe：暂存的包不再有用。
      removeStaged(pending.staged);
      writeAutoState(paths, { ...state, pending: null });
      return { state: 'discarded', reason: inactive };
    }

    const local = driver.describe(paths).version;
    const verdict = evaluateCandidate({ latest: pending, local, autoState: state, delayHours: delayHours(), now: now() });
    if (!verdict.eligible) {
      // 冷却期被调长了：包留着，等够了时间再装；其它原因（已是最新、回滚过、失败过）说明它不该再装。
      if (verdict.reason === 'too-fresh') return { state: 'skipped', reason: verdict.reason };
      removeStaged(pending.staged);
      writeAutoState(paths, { ...state, pending: null });
      logger.info(`[${name}] 放弃暂存的后端 ${pending.tag}：${skipText(verdict, delayHours())}`);
      return { state: 'discarded', reason: verdict.reason };
    }

    logger.info(`[${name}] 自动更新后端：${local?.tag ?? '未知'} → ${pending.tag}`);
    const locked = await withBackendLock('auto-apply', () =>
      driver.commit({
        paths,
        service,
        logger,
        keepVersions: resolved.backend.keepVersions,
        latest: { tag: pending.tag, commit: pending.commit, publishedAt: pending.publishedAt },
        staged: pending.staged,
        keepStaged: true,
        source: 'auto-update',
      })
        // 文件占用、权限等异常也要进入失败记录，否则 pending 会在每次启动时重复换装。
        .catch((error) => ({ ok: false, state: 'swap-failed', reason: error instanceof Error ? error.message : String(error) })),
    );
    if (!locked.acquired) return { state: 'busy', holder: locked.holder };
    const result = locked.value;
    const at = new Date(now()).toISOString();
    state = readAutoState(paths);
    if (result.ok) {
      writeAutoState(paths, { ...state, pending: null, last: { from: local?.tag ?? null, to: pending.tag, at } });
      logger.info(`[${name}] 后端已自动更新到 ${pending.tag}；有问题可在插件页「回滚」到 ${local?.tag ?? '上一版本'}`);
    } else if (result.state === 'not-owned') {
      // 端口上是别人起的后端：这次换不了，包留着下次启动再试。
      logger.warn(`[${name}] 暂存的后端 ${pending.tag} 这次没法换上：${result.reason}`);
    } else {
      removeStaged(pending.staged);
      // 换上去之后才出的问题（起不来 / 健康检查不过）记成失败，不再自动重试；
      // 暂存文件丢了或被改过只是这份包不能用了，下一轮重新下载即可。
      const installFailed = result.state === 'health-failed' || result.state === 'swap-failed';
      const failed = installFailed ? { tag: pending.tag, state: result.state, reason: result.reason ?? '', at } : state.failed;
      writeAutoState(paths, { ...state, pending: null, failed });
      if (installFailed) {
        logger.error(`[${name}] 自动更新后端到 ${pending.tag} 失败（${result.reason ?? result.state}），${result.rolledBack ? '已退回原版本；' : ''}这个版本不再自动重试`);
      } else {
        logger.warn(`[${name}] 暂存的后端 ${pending.tag} 不能用了（${result.reason ?? result.state}），之后会重新下载`);
      }
    }
    return result;
  }

  return {
    tick,
    applyPending,
    /** 启动流程落地后调用：等 firstDelayMs 做第一轮，之后按 checkTtlMs 的间隔。 */
    start() {
      schedule(firstDelayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller.abort(new Error('插件已关闭，后台下载中断'));
      // disposer 等到目录锁释放及状态收尾后再让新网关实例启动。
      return running;
    },
  };
}
