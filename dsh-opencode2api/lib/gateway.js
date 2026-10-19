/** 两种后端共用同一端口和 provider；安装、探针和数据布局按网关分发。 */
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
  rollback: rollbackBackend,
  uninstall: uninstallBackend,
  purge: purgeBackendData,
  probe: probeHealthz,
});
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
