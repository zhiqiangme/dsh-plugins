/**
 * 后端网关分发：插件可以托管两种 OpenAI 兼容网关，二选一（插件配置 `gateway`）。
 *
 *   - `wb2api`（默认）：linguo2625469/workbuddy2api-panel，单文件 Go 程序，见 backend.js；
 *   - `hub`：ardeyouxipianyi/workbuddy2api-hub，自带 Python 运行时的目录，见 hub.js。
 *     作为 wb2api 停更时的备选。
 *
 * 两者监听同一个端口（默认 7863），DSH 里 workbuddy provider 的 baseURL 不用改；同一时刻只跑一个。
 * 面板路由、启动检查与定时同步都只经这里拿"当前网关的那套操作"，不直接调 backend.js / hub.js。
 */

import {
  applyUpdate,
  checkForUpdate,
  describeBackend,
  installBackend,
  probeHealthz,
  purgeBackendData,
  rollbackBackend,
  uninstallBackend,
} from './backend.js';
import {
  applyHubUpdate,
  checkHubUpdate,
  describeHub,
  installHub,
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
