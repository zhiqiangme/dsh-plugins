/** 两种后端共用同一端口和 provider；安装、探针和数据布局按网关分发。 */
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
  applyTiaraUpdate,
  checkTiaraUpdate,
  describeTiara,
  installTiara,
  probeTiaraHealth,
  purgeTiaraData,
  rollbackTiara,
  uninstallTiara,
} from './tiara.js';

export const GATEWAY_IDS = Object.freeze(['jasonxu', 'tiara']);
export const DEFAULT_GATEWAY = 'jasonxu';
export function normalizeGateway(value) {
  return value === 'tiara' ? 'tiara' : DEFAULT_GATEWAY;
}
const JASON = Object.freeze({
  id: 'jasonxu',
  title: 'jasonxu114514/opencode2api',
  describe: describeBackend,
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
/**
 * Tiara 刻意不提供 prepare / commit，自动更新因此跳过它（见 auto-update.js）：上游没有正式 release，
 * 只有 main 分支的提交（版本号是 main-<commit>，比不出新旧）；tiara-compat.js 还要按上游源码的固定片段
 * 打兼容补丁，main 一变就可能对不上、启动失败。哪个提交能用要跟着插件一起验证，所以只留手动「更新」。
 */
const TIARA = Object.freeze({
  id: 'tiara',
  title: 'TiaraBasori/OpenCode2API',
  describe: describeTiara,
  check: checkTiaraUpdate,
  install: installTiara,
  update: applyTiaraUpdate,
  rollback: rollbackTiara,
  uninstall: uninstallTiara,
  purge: purgeTiaraData,
  probe: probeTiaraHealth,
});
export function gatewayDriver(value) {
  return normalizeGateway(typeof value === 'string' ? value : value?.gateway) === 'tiara' ? TIARA : JASON;
}
