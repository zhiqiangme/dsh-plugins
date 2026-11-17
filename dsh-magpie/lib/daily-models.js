import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLocal } from './config.js';
import { routingDay } from './channel-order.js';

const CHECK_INTERVAL = 5 * 60_000;
class Paused extends Error { constructor(phase) { super(phase); this.phase = phase; } }

/** 只更新 Magpie 的目录，再保守合并插件清单；按渠道保存进度，失败重试不重复刷新已成功的渠道。 */
export class DailyModels {
  constructor(manager, { now = Date.now } = {}) {
    this.manager = manager; this.now = now;
    this.file = manager.backend.paths?.cache ? join(manager.backend.paths.cache, 'daily-models.json') : undefined;
    this.controller = new AbortController(); this.phase = 'pending';
  }
  status() {
    return { phase: this.phase, day: this.state?.day, completed: this.state?.done.length ?? 0,
      failed: this.failed ?? [], finishedAt: this.state?.finishedAt ?? null, reason: this.reason ?? null };
  }
  guard(config, idle = true) {
    const current = this.manager.current();
    if (this.controller.signal.aborted || this.manager.disposed || !current.enabled || !current.dailyModels) throw new Paused('disabled');
    if (!isLocal(current.baseURL)) throw new Paused('local-only');
    if (config && (current.baseURL !== config.baseURL || this.state.day !== routingDay(this.now()))) throw new Paused('pending');
    const busy = idle && this.manager.conversationBlock();
    if (busy) throw new Paused(busy);
  }
  stateFor(config) {
    const scope = createHash('sha256').update(config.baseURL).digest('hex'), day = routingDay(this.now());
    if (this.state?.scope === scope && this.state.day === day) return this.state;
    this.state = { version: 1, scope, day, done: [], finishedAt: null };
    try {
      if (this.file && statSync(this.file).size < 64 * 1024) {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        if (saved.version === 1 && saved.scope === scope && saved.day === day && Array.isArray(saved.done) && saved.done.length <= 512
          && saved.done.every((id) => typeof id === 'string' && id.length <= 512)) {
          this.state.done = [...new Set(saved.done)];
          if (Number.isFinite(saved.finishedAt)) this.state.finishedAt = saved.finishedAt;
        }
      }
    } catch { /* 首次运行、跨日、缓存损坏时重新开始；不触碰用户的账号或模型配置。 */ }
    return this.state;
  }
  save() {
    if (!this.file) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
  run() { return this.pending ??= this.refresh().finally(() => { this.pending = undefined; }); }
  async refresh() {
    try {
      this.guard(undefined, false);
      const config = this.manager.current(), state = this.stateFor(config);
      if (state.finishedAt) { this.phase = 'completed'; return this.status(); }
      this.guard(config);
      this.phase = 'refreshing'; this.reason = null; this.failed = [];
      const api = await this.manager.backend.web.modelAPI(this.controller.signal);
      this.guard(config);
      const value = await api('providers');
      if (!Array.isArray(value?.providers) || value.providers.length > 512
        || value.providers.some((p) => typeof p?.id !== 'string' || !p.id || p.id.length > 512)) throw new Error('Magpie 渠道目录格式无效');
      // off 是 Magpie 自己的开关；listOff 是用户明确关闭供应商列表获取，两者均不能被定时任务重新开启。
      const providers = value.providers.filter((p) => !p.off && !p.listOff);
      for (const provider of providers) {
        this.guard(config);
        if (state.done.includes(provider.id)) continue;
        try {
          const result = await api('provider/models', { id: provider.id });
          if (!Number.isSafeInteger(result?.count) || result.count < 0 || result.provider?.listError) throw new Error('刷新结果无效');
        } catch { this.controller.signal.throwIfAborted(); this.failed.push(provider.id); continue; }
        state.done.push(provider.id); this.save();
      }
      this.guard(config);
      this.phase = 'syncing';
      await this.manager.refreshCatalog(() => this.guard(config), this.controller.signal);
      this.guard(config);
      if (this.failed.length) { this.phase = 'retrying'; return this.status(); }
      state.finishedAt = this.now(); this.save(); this.phase = 'completed';
    } catch (error) {
      this.phase = error instanceof Paused ? error.phase : this.controller.signal.aborted ? 'disabled' : 'failed';
      // 上游正文、登录 Cookie 和密钥不进入状态或日志；只显示本模块与调用层提供的可读原因。
      this.reason = this.phase === 'failed' ? '每日模型刷新未完成，请检查 Magpie 网页访问和网关连接，稍后自动重试' : null;
    }
    return this.status();
  }
  async stop() { this.controller.abort(); await this.pending; }
}

export function registerDailyModels(ctx, manager, { now = Date.now, schedule = setTimeout, cancel = clearTimeout, firstDelay = 15_000 } = {}) {
  const worker = manager.modelRefresh = new DailyModels(manager, { now });
  ctx.effect(() => {
    let stopped = false, timer;
    const arm = (delay) => { timer = schedule(tick, delay); timer?.unref?.(); };
    const tick = async () => {
      if (stopped || manager.disposed) return;
      await worker.run();
      // 下一日边界为北京时间 04:00；电脑时区和定时器漂移均不改变业务日期。
      if (!stopped && !manager.disposed) arm(Math.max(1_000, Math.min(CHECK_INTERVAL, Date.parse(`${routingDay(now())}T20:00:00Z`) - now())));
    };
    arm(firstDelay);
    return async () => { stopped = true; cancel(timer); await worker.stop(); };
  }, 'dsh-magpie: daily provider model refresh');
  return worker;
}
