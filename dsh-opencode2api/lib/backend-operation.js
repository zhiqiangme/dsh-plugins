/** 后端操作独立于 HTTP 请求；页面重开和连接中断仍可查询同一个任务。 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const operationActive = (value) => value?.state === 'running';

/**
 * 后端目录的独占锁。面板的各项操作（安装 / 更新 / 回滚 / 卸载 / 彻底卸载 / 重试启动），以及自动更新的
 * 后台下载（auto-prepare）与启动时换装（auto-apply），都会动 current/、versions/、cache/ 里的暂存文件
 * 或停起后端；这些不是幂等操作，两个并发进来会把目录搅乱，所以同一时刻只放一个。
 *
 * 放在模块级而不是 createBackendOperations 里：面板操作实例每次 apply 新建一个，插件因配置变更重启
 * （dispose 再 apply）时模块不会重新加载——锁跨重启有效，新旧实例与自动更新共用同一把。
 */
let lockHolder;

/** 正在持锁的动作名（如 'update'、'auto-prepare'）；没人持锁时为 undefined。 */
export function backendLockHolder() {
  return lockHolder;
}

/** 锁被占着时给面板的说明：后台自动下载与手点的操作分开说，用户才知道该等什么。 */
export function busyReason(holder) {
  if (holder === 'auto-prepare') return '后台正在自动下载后端新版本，请稍候再试';
  if (holder === 'auto-apply') return '正在换装自动下载的后端新版本，请稍候再试';
  return '已有后端操作在进行中，请等待当前任务完成';
}

/**
 * 持锁执行 task；锁被占着时不等待，直接返回 { acquired: false, holder }。
 *
 * @template T
 * @param {string} holder 动作名，给"被谁占着"的提示用
 * @param {() => Promise<T>} task
 * @returns {Promise<{ acquired: true, value: T } | { acquired: false, holder: string }>}
 */
export async function withBackendLock(holder, task) {
  if (lockHolder) return { acquired: false, holder: lockHolder };
  lockHolder = holder;
  try {
    return { acquired: true, value: await task() };
  } finally {
    lockHolder = undefined;
  }
}

export function createBackendOperations({ paths, gateway, logger, run }) {
  const file = join(paths.root, 'operation.json');
  let operation, controller, task;
  try {
    operation = JSON.parse(readFileSync(file, 'utf8'));
    if (operationActive(operation)) {
      operation = { ...operation, state: 'failed', finishedAt: new Date().toISOString(),
        result: { ok: false, state: 'interrupted', reason: '上次操作被 DSH 退出中断，请重试；已下载的文件会复用。' } };
    }
  } catch { /* 尚未执行过操作。 */ }
  function save(create = true) {
    try {
      if (!create && !existsSync(paths.root)) return;
      mkdirSync(paths.root, { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify(operation, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (error) { logger?.warn?.(`[opencode2api] 保存操作状态失败：${error.message}`); }
  }
  if (operation?.result?.state === 'interrupted') save(false);
  return {
    get current() { return operation; },
    get busy() { return operationActive(operation); },
    start(action) {
      if (operationActive(operation)) return { ok: false, reason: '已有后端操作在进行中，请等待当前任务完成', operation };
      // 目录锁要在这里同步拿到：拿不到就立即答 409，不能先建任务再在后台失败。
      if (lockHolder) return { ok: false, reason: busyReason(lockHolder), holder: lockHolder, operation };
      lockHolder = action;
      controller = new AbortController();
      operation = { id: randomUUID(), gateway, action, state: 'running', startedAt: new Date().toISOString(),
        progress: { stage: 'prepare', detail: '正在准备后端操作' } };
      save();
      const initial = structuredClone(operation);
      let lastSaved = Date.now();
      const report = (progress) => {
        if (!operationActive(operation)) return;
        const changed = operation.progress?.stage !== progress.stage;
        operation = { ...operation, progress: { ...progress, updatedAt: new Date().toISOString() } };
        if (changed || Date.now() - lastSaved > 1000) { save(); lastSaved = Date.now(); }
      };
      task = Promise.resolve().then(() => run(action, { signal: controller.signal, onProgress: report }))
        .catch((error) => ({ ok: false, state: controller.signal.aborted ? 'interrupted' : 'failed', reason: error.message }))
        .then((result) => {
          operation = { ...operation, state: result.ok ? 'succeeded' : 'failed', finishedAt: new Date().toISOString(), result };
          // 彻底卸载已删掉整个根目录，不能为了记录成功又把目录建回来。
          save(!(action === 'purge' && result.ok));
          return operation;
        })
        .finally(() => {
          lockHolder = undefined;
        });
      return { ok: true, operation: initial };
    },
    async dispose() {
      controller?.abort(new Error('DSH 已关闭，后端操作中断'));
      await task;
    },
    async wait() { return task; },
  };
}
