import { ManagedService } from './services.js';
import { probeHealthz } from './backend.js';

/** TCP 就绪只说明有进程占端口；身份检查失败时不复用、不结束外部进程。 */
export class GatewayService extends ManagedService {
  async ensureRunning(signal) {
    const started = await super.ensureRunning(signal);
    if (started.state === 'failed') return started;
    const health = await probeHealthz({ host: this.spec.host, port: this.port });
    if (health.ok) return { ...started, health };
    await this.stop('后端身份检查失败');
    return { state: 'failed', reason: health.reason };
  }
}
