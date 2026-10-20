/**
 * 后端网关分发：插件可以托管两种 OpenAI 兼容网关，二选一（插件配置 `gateway`）。
 *
 *   - `wb2api`（默认）：linguo2625469/workbuddy2api-panel，单文件 Go 程序，见 backend.js；
 *   - `hub`：ardeyouxipianyi/workbuddy2api-hub，自带 Python 运行时的目录，见 hub.js。
 *     作为 wb2api 停更时的备选。
 *
 * 两者监听同一个端口（默认 7863），同一时刻只跑一个；provider 的直连/双区域转发地址由模型同步维护。
 * 面板路由、启动检查与定时同步都只经这里拿"当前网关的那套操作"，不直接调 backend.js / hub.js。
 */

import {
  applyUpdate,
  checkForUpdate,
  commitUpdate,
  describeBackend,
  installBackend,
  prepareUpdate,
  probeHealthz,
  purgeBackendData,
  rollbackBackend,
  uninstallBackend,
} from './backend.js';
import {
  applyHubUpdate,
  checkHubUpdate,
  commitHubUpdate,
  describeHub,
  installHub,
  prepareHubUpdate,
  probeHubHealth,
  purgeHubData,
  rollbackHub,
  uninstallHub,
} from './hub.js';

export const GATEWAY_IDS = Object.freeze(['wb2api', 'hub']);
export const DEFAULT_GATEWAY = 'wb2api';

/** 非法值一律退回默认网关：配置写错不该让插件起不来。 */
export function normalizeGateway(value) {
  return value === 'hub' ? 'hub' : DEFAULT_GATEWAY;
}

const WB2API = Object.freeze({
  id: 'wb2api',
  title: 'WorkBuddy Panel',
  /** 管理面板相对路径。 */
  panelPath: '/panel',
  describe: (paths) => ({ gateway: 'wb2api', ...describeBackend(paths) }),
  check: checkForUpdate,
  install: installBackend,
  update: applyUpdate,
  /** 自动更新的两半：后台下载暂存 / 下次启动时换上（见 auto-update.js）。 */
  prepare: prepareUpdate,
  commit: commitUpdate,
  rollback: rollbackBackend,
  uninstall: uninstallBackend,
  purge: purgeBackendData,
  probe: probeHealthz,
});

const HUB = Object.freeze({
  id: 'hub',
  title: 'WorkBuddy2API Hub',
  panelPath: '/',
  describe: describeHub,
  check: checkHubUpdate,
  install: installHub,
  update: applyHubUpdate,
  prepare: prepareHubUpdate,
  commit: commitHubUpdate,
  rollback: rollbackHub,
  uninstall: uninstallHub,
  purge: purgeHubData,
  probe: probeHubHealth,
});

/** 当前网关的操作集；`gateway` 可以是 id，也可以是 resolvePluginConfig 的结果。 */
export function gatewayDriver(gateway) {
  const id = typeof gateway === 'string' ? gateway : gateway?.gateway;
  return normalizeGateway(id) === 'hub' ? HUB : WB2API;
}

/**
 * 后端目录的独占锁。面板的安装 / 更新 / 回滚 / 卸载 / 清除，以及自动更新的后台下载与启动时换装，
 * 都会动 current/、versions/ 或 cache/ 里的暂存文件；下载 + 换文件 + 重启后端不是幂等操作，
 * 两个并发进来会把目录搅乱，所以同一时刻只放一个。
 *
 * 放在模块级：插件因配置变更重启（dispose 再 apply）时模块不会重新加载，锁跨重启有效——
 * 上一轮还在跑的后台下载照样挡住新一轮的换装。
 */
let lockHolder;

/** 正在持锁的动作名（如 'update'、'auto-prepare'）；没人持锁时为 undefined。 */
export function backendLockHolder() {
  return lockHolder;
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
