import { isLocal } from './config.js';
import { targetPath } from './backend.js';

export const RELEASE_DELAY = 30 * 60_000;
export const CHECK_INTERVAL = 5 * 60_000;

/** agents.list() covers all workspaces and subagents, including tool/approval waits. */
export function conversationBlock(agents) {
  try {
    if (typeof agents?.list !== 'function') return 'waiting-status';
    const live = agents.list();
    if (!Array.isArray(live)) return 'waiting-status';
    if (live.some((agent) => agent?.status === 'running')) return 'waiting-idle';
    if (live.some((agent) => agent?.status !== 'idle')) return 'waiting-status';
  } catch { return 'waiting-status'; }
}

export function autoUpdateEnabled(manager, path) {
  const config = manager.current();
  return !manager.disposed && config.enabled && config.autoUpdate && isLocal(config.baseURL)
    && (!path || targetPath(config.magpiePath, manager.backend.paths) === path);
}

/** The backend owns the operation/installation lock, so manual and automatic work cannot overlap. */
export async function autoUpdateMagpie(manager, { now = Date.now } = {}) {
  const backend = manager.backend;
  if (!backend.supported || !autoUpdateEnabled(manager)) return;
  if (backend.pending) return;
  const config = manager.current();
  const path = targetPath(config.magpiePath, backend.paths);
  const local = await backend.local(path);
  // Automatic updates never perform a first installation or overwrite an unrecognized file.
  if (!local.installed || !local.version || backend.pending || !autoUpdateEnabled(manager, path)) return;
  backend.install(path, { lightweight: config.autoLightweight, automatic: true, minimumAgeMs: RELEASE_DELAY, now,
    guard: () => {
      if (!autoUpdateEnabled(manager, path)) return 'cancelled';
      return manager.conversationBlock();
    },
  });
  const work = backend.pending;
  await work.catch(() => {});
  return backend.operation;
}

export function registerAutoUpdate(ctx, manager, { run = autoUpdateMagpie, now = Date.now, schedule = setTimeout, cancel = clearTimeout, firstDelay = 10_000 } = {}) {
  ctx.effect(() => {
    let stopped = false, timer;
    const tick = async () => {
      if (stopped || manager.disposed) return;
      let delay = CHECK_INTERVAL;
      try {
        const result = await run(manager, { now });
        if (result?.phase === 'cooling-down') delay = Math.max(1_000, Math.min(delay, result.eligibleAt - now()));
        if (result?.phase === 'failed') (ctx.logger ?? console).warn(`[dsh-magpie] 自动升级失败，稍后重试：${result.reason}`);
      } catch (error) { (ctx.logger ?? console).warn(`[dsh-magpie] 自动检查失败，稍后重试：${error.message}`); }
      if (!stopped && !manager.disposed) arm(delay);
    };
    const arm = (delay) => { timer = schedule(tick, delay); timer?.unref?.(); };
    arm(firstDelay);
    return () => { stopped = true; cancel(timer); };
  }, 'dsh-magpie: automatic executable updates');
}
