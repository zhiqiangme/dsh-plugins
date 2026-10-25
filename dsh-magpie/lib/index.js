import { PLUGIN_ID, resolveConfig } from './config.js';
import { ModelManager } from './runtime.js';
import { registerPanel } from './web.js';
import { registerHighestReasoning } from './reasoning.js';
import { registerAutoStart, registerExitClose } from './lifecycle.js';
import { registerAutoUpdate } from './auto-update.js';

export const name = PLUGIN_ID;
export const inject = [];

/** 清单由本插件持有，启动同步只读已保存清单，不定时拉取或覆盖上游目录。 */
export function apply(ctx, config) {
  let manager;
  try { manager = new ModelManager(ctx, config); }
  catch (error) { (ctx.logger ?? console).error(`[${name}] 配置无效：${error.message}`); return; }
  registerPanel(ctx, manager);
  registerHighestReasoning(ctx);
  registerExitClose(ctx, manager);
  registerAutoStart(ctx, manager);
  registerAutoUpdate(ctx, manager);
  const sync = () => manager.enqueue(() => manager.sync()).catch((error) => (ctx.logger ?? console).warn(`[${name}] ${error.message}`));
  // 保存表单只热更新解析结果，不注销路由或打断同步请求。
  const off = ctx.on?.('internal/update', (raw, _noSave, _next) => {
    manager.config = resolveConfig(raw);
    // 原始配置编辑器的保存同样生效；排到当前保存之后，避免凭据尚未写完就抢先同步。
    sync();
  });
  if (typeof ctx.inject === 'function') ctx.inject(['configEditor', 'credentials'], sync);
  else sync();
  ctx.effect(() => async () => { manager.disposed = true; if (typeof off === 'function') off(); await manager.backend.dispose(); await manager.pending; }, `${name}: lifecycle`);
}
