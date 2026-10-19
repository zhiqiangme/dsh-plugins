/** 只恢复本插件启动后意外退出的进程；手动停止、换装和外部进程不触发恢复。 */
import { withBackendLock } from './gateway.js';

export function createRecovery({ service, resolved, logger, onRecovered, now = Date.now }) {
  let timer, running;
  let stopped = false;
  let armed = false;
  const attempts = [];
  const controller = new AbortController();
  let status = { state: 'idle', attempts: 0 };
  const settings = () => resolved.recovery ?? { enabled: true, maxAttempts: 3, windowMs: 300_000, delayMs: 1000, maxDelayMs: 30_000 };
  function schedule() {
    const config = settings();
    if (stopped || !armed || timer || !config.enabled) return;
    while (attempts.length && attempts[0] <= now() - config.windowMs) attempts.shift();
    if (attempts.length >= config.maxAttempts) {
      status = { state: 'exhausted', attempts: attempts.length, reason: '后端连续退出，自动恢复已暂停，请检查诊断后重试启动' };
      logger.warn(`[workbuddy] ${status.reason}`);
      return;
    }
    const delay = Math.min(config.maxDelayMs, config.delayMs * 2 ** attempts.length);
    status = { state: 'waiting', attempts: attempts.length, retryAt: new Date(now() + delay).toISOString() };
    timer = setTimeout(() => {
      timer = undefined;
      running = recover().finally(() => { running = undefined; });
    }, delay);
    timer.unref?.();
  }
  async function recover() {
    if (stopped || !armed) return;
    try {
      const locked = await withBackendLock('recovery', async () => {
        attempts.push(now());
        status = { state: 'restarting', attempts: attempts.length };
        return service.ensureRunning(controller.signal);
      });
      if (stopped) return;
      if (!locked.acquired) { schedule(); return; }
      if (locked.value?.state === 'failed') { schedule(); return; }
      if (locked.value?.state === 'already-running' && !service.isAlive?.()) {
        status = { state: 'external', attempts: attempts.length, reason: '端口已被外部进程占用，自动恢复暂停，请检查诊断' };
        logger.warn(`[workbuddy] ${status.reason}`);
        return;
      }
      status = { state: 'recovered', attempts: attempts.length, at: new Date(now()).toISOString() };
      logger.info('[workbuddy] 后端已自动恢复');
      try { await onRecovered?.(); }
      catch (error) { logger.warn(`[workbuddy] 后端已恢复，但模型同步失败：${error.message}`); }
    } catch (error) {
      if (!stopped) {
        logger.warn(`[workbuddy] 恢复后端失败：${error.message}`);
        schedule();
      }
    }
  }
  return {
    arm() { if (!stopped) armed = true; },
    onExit() {
      if (!stopped && armed && service.startedByUs && !service.stopping && !running) schedule();
    },
    reset() { if (timer) clearTimeout(timer); timer = undefined; attempts.length = 0; status = { state: 'idle', attempts: 0 }; },
    suspend() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      // 恢复尝试启动失败时 ManagedService 也会回收进程，仍要继续有限次数重试。
      if (!running) armed = false;
    },
    get status() { return { enabled: settings().enabled, ...status }; },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller.abort();
      await running;
    },
  };
}
