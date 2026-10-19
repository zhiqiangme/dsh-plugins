/** 后端操作独立于 HTTP 请求；页面重开和连接中断仍可查询同一个任务。 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const operationActive = (value) => value?.state === 'running';

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
