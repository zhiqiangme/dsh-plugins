const UNKNOWN = '宿主对话运行状态暂不可用，自动模型同步已延后';
export const MODEL_SYNC_BUSY = '有对话正在运行，自动模型同步已延后，空闲后重试';

/**
 * agents.list() 包含所有工作区及子代理；工具执行、等待审批也属于 running。
 * provider 重载会影响整轮执行，不能只检查当前页面或正在发送 HTTP 的请求。
 * 服务尚未加载或读取失败时也不冒险改配置，用户仍可显式保存模型选择。
 */
export function modelSyncBlockReason(agents) {
  try {
    if (typeof agents?.list !== 'function') return UNKNOWN;
    const live = agents.list();
    if (!Array.isArray(live)) return UNKNOWN;
    for (const agent of live) {
      if (agent?.status === 'running') return MODEL_SYNC_BUSY;
      if (agent?.status !== 'idle') return UNKNOWN;
    }
    return undefined;
  } catch {
    return UNKNOWN;
  }
}

export class ModelSyncBusyError extends Error {}

/** 在 configEditor 持锁后的 change 回调内再检查，覆盖拉目录和排队期间开始的对话。 */
export function assertModelSyncIdle(syncBlocker) {
  const reason = syncBlocker?.();
  if (reason) throw new ModelSyncBusyError(reason);
}

export function modelSyncBlocked(syncBlocker) {
  const reason = syncBlocker?.();
  return reason ? { state: 'busy', reason } : undefined;
}
