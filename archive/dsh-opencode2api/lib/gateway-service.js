import { ManagedService, probeTcp } from './services.js';
import { gatewayDriver } from './gateway.js';
import { ensureTiaraConfig, tiaraPaths } from './tiara.js';

/** TCP 就绪只说明有进程占端口；身份检查失败时不复用、不结束外部进程。 */
export class GatewayService extends ManagedService {
  async ensureRunning(signal) {
    // 首次预热期间端口尚未监听；页面重试须等待同一次启动，不能再拉起一套进程。
    if (this.starting) return this.starting;
    const pending = this.startGateway(signal);
    this.starting = pending;
    try { return await pending; }
    finally { if (this.starting === pending) this.starting = undefined; }
  }

  async startGateway(signal) {
    if (this.disposed || signal?.aborted) return { state: 'failed', reason: '插件已关闭，取消启动后端' };
    if (this.spec.validationError) return { state: 'failed', reason: this.spec.validationError };
    if (this.spec.gateway === 'tiara' && !(await probeTcp(this.port, this.spec.host))) {
      // 先确保私有端口空闲；不接管用户自行运行的 OpenCode。
      const port = Number(this.spec.env.DSH_TIARA_SERVER_PORT);
      if (await probeTcp(port, '127.0.0.1')) return { state: 'failed', reason: `Tiara 内部端口 ${port} 已被占用，请修改 tiaraServerPort 或停止外部实例` };
      ensureTiaraConfig(tiaraPaths(this.spec.env));
    }
    const started = await super.ensureRunning(signal);
    if (started.state === 'failed') return started;
    const health = await gatewayDriver(this.spec).probe({ host: this.spec.host, port: this.port });
    if (health.ok) return { ...started, health };
    await this.stop('后端身份检查失败');
    return { state: 'failed', reason: health.reason };
  }
}
