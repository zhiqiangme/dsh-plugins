import { PLUGIN_ID, resolveConfig } from './config.js';
import { hostService, ModelManager } from './runtime.js';
import { registerPanel } from './web.js';
import { registerHighestReasoning } from './reasoning.js';
import { registerAutoStart, registerExitClose } from './lifecycle.js';
import { registerAutoUpdate } from './auto-update.js';
import { registerChannelSessions } from './channel-load.js';
import { registerDailyModels } from './daily-models.js';

export const name = PLUGIN_ID;
export const inject = [];

/** 清单由本插件持有；启动使用已保存清单，每日空闲时刷新上游并保守合并。 */
export function apply(ctx, config) {
  let manager;
  try { manager = new ModelManager(ctx, config); }
  catch (error) { (ctx.logger ?? console).error(`[${name}] 配置无效：${error.message}`); return; }
  registerPanel(ctx, manager);
  registerHighestReasoning(ctx);
  registerChannelSessions(ctx, manager);
  registerExitClose(ctx, manager);
  registerAutoStart(ctx, manager);
  registerAutoUpdate(ctx, manager);
  registerDailyModels(ctx, manager);
  const registerSearch = (scoped = ctx) => {
    const web = hostService(scoped, 'web');
    if (typeof web?.registerSearchProvider !== 'function' || typeof web.listProviders !== 'function') return;
    scoped.effect(() => {
      const unregister = web.registerSearchProvider(manager.searchProvider);
      manager.searchRegistered = true;
      return () => { manager.searchRegistered = false; unregister(); };
    }, `${name}: web search provider`);
  };
  if (typeof ctx.inject === 'function') ctx.inject(['web'], registerSearch);
  else registerSearch();
  const sync = () => manager.enqueue(() => manager.sync()).catch((error) => (ctx.logger ?? console).warn(`[${name}] ${error.message}`));
  // 保存表单只热更新解析结果，不注销路由或打断同步请求。
  const off = ctx.on?.('internal/update', (raw, _noSave, _next) => {
    manager.config = resolveConfig(raw);
    // 原始配置编辑器的保存同样生效；排到当前保存之后，避免凭据尚未写完就抢先同步。
    sync();
  });
  if (typeof ctx.inject === 'function') ctx.inject(['configEditor', 'credentials'], sync);
  else sync();
  ctx.effect(() => async () => {
    manager.disposed = true;
    manager.searchAbort.abort();
    manager.router.stop();
    if (typeof off === 'function') off();
    await manager.backend.dispose();
    await manager.pending;
  }, `${name}: lifecycle`);
}
