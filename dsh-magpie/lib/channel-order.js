import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETRY_QUOTAS_MS = 5 * 60_000;
export const channelId = (row) => row.id.includes('/') ? row.id.slice(0, row.id.indexOf('/')) : row.id;
// 北京时间 04:00 开始新一天：UTC+8 再减去 4 小时，完全不依赖宿主电脑的时区。
export function routingDay(at) { return new Date(at + 4 * 3600_000).toISOString().slice(0, 10); }

/** 只采用仍有余额的最近一批到期时间；周期重置、套餐期限和预计用完不等同于积分到期。 */
export function creditExpiries(payload, now) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) throw new Error('Magpie 额度目录格式无效');
  const expiries = new Map();
  for (const card of rows) {
    if (typeof card?.provider !== 'string') continue;
    for (const window of Array.isArray(card.windows) ? card.windows : []) {
      if (!(typeof window?.runsOut === 'number' && window.runsOut > 0)
        || (typeof window.remaining === 'number' && window.remaining <= 0)
        || typeof window.runsOutAt !== 'string') continue;
      const at = Date.parse(window.runsOutAt);
      if (!Number.isFinite(at) || at <= now || at >= Date.UTC(9999, 0, 1)) continue;
      expiries.set(card.provider, Math.min(expiries.get(card.provider) ?? Infinity, at));
    }
  }
  return expiries;
}

/** 全部渠道共用当天的队列；一般失败后移，余额不足当天停用，不改模型清单。 */
export class ChannelOrder {
  constructor({ now = Date.now, loadQuotas = async () => [], stateFile, onError = () => {} } = {}) {
    Object.assign(this, { now, loadQuotas, stateFile, onError });
  }
  stateFor(config) {
    const scope = createHash('sha256').update(config.baseURL).digest('hex'), day = routingDay(this.now());
    if (this.state?.scope !== scope || this.state.day !== day) {
      this.state = { scope, day, base: [], deferred: [], blocked: new Map(), generations: new Map(), expiries: new Map(), loaded: false, retryAt: 0 };
      this.restore(this.state);
    }
    const state = this.state;
    state.providers = [...new Set(config.models.map(channelId))];
    this.arrange(state);
    return state;
  }
  async prepare(config) {
    const state = this.stateFor(config);
    if (!state.loaded && this.now() >= state.retryAt) {
      state.loading ??= this.refresh(state, config).finally(() => { state.loading = undefined; });
      await state.loading;
    }
    return state;
  }
  async refresh(state, config) {
    try {
      const expiries = creditExpiries(await this.loadQuotas(config), this.now());
      if (this.state !== state) return;
      state.expiries = expiries;
      state.loaded = true;
      this.arrange(state);
      this.save(state);
    } catch {
      // 额度接口失败不阻断模型调用；保留当天已知顺序和失败后移记录，五分钟后有请求时重试。
      state.retryAt = this.now() + RETRY_QUOTAS_MS;
      this.onError('额度读取失败，暂按已有渠道顺序选路，稍后重试');
    }
  }
  arrange(state) {
    state.base = [...state.providers].sort((a, b) => (state.expiries.get(a) ?? Infinity) - (state.expiries.get(b) ?? Infinity));
    state.deferred = state.deferred.filter((provider) => state.providers.includes(provider));
    state.order = [...state.base.filter((provider) => !state.deferred.includes(provider)), ...state.deferred];
  }
  rank(state, rows) {
    const positions = new Map(state.order.map((provider, index) => [provider, index]));
    return rows.filter((row) => !state.blocked.has(channelId(row)))
      .sort((a, b) => (positions.get(channelId(a)) ?? Infinity) - (positions.get(channelId(b)) ?? Infinity));
  }
  generation(state, row) { return state.generations.get(channelId(row)) ?? 0; }
  exhausted(state, row, generation = this.generation(state, row)) {
    const id = channelId(row);
    // 手动恢复前已发出的旧请求不能再次停用刚恢复的渠道；恢复后的新请求仍可重新报告余额不足。
    if (this.state !== state || state.day !== routingDay(this.now()) || !state.providers.includes(id)
      || state.blocked.has(id) || generation !== this.generation(state, row)) return;
    state.blocked.set(id, { id, at: this.now(), token: randomUUID() });
    this.save(state);
  }
  snapshot(config) {
    const state = this.stateFor(config);
    return { day: state.day, blocked: [...state.blocked.values()].map((row) => ({ ...row })) };
  }
  recover(config, id, token) {
    const state = this.stateFor(config), blocked = state.blocked.get(id);
    if (typeof id !== 'string' || (!blocked && !state.providers.includes(id))) throw new Error('渠道不存在');
    if (blocked && token !== blocked.token) {
      const error = new Error('渠道状态已更新，请刷新后再恢复'); error.status = 409; throw error;
    }
    if (blocked) {
      state.blocked.delete(id);
      state.generations.set(id, (state.generations.get(id) ?? 0) + 1);
      state.deferred = state.deferred.filter((provider) => provider !== id);
      this.arrange(state);
      this.save(state);
    }
    return this.snapshot(config);
  }
  failed(state, row) {
    // 昨天或旧网关的在途请求晚到失败，不能覆盖今日/新网关的默认顺序。
    const provider = channelId(row);
    if (this.state !== state || state.day !== routingDay(this.now()) || !state.providers.includes(provider)) return;
    state.deferred = [...state.deferred.filter((id) => id !== provider), provider];
    this.arrange(state);
    this.save(state);
  }
  restore(state) {
    if (!this.stateFile) return;
    try {
      if (statSync(this.stateFile).size > 256 * 1024) return;
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (saved.version !== 2 || saved.scope !== state.scope || saved.day !== state.day) return;
      if (!Array.isArray(saved.deferred) || saved.deferred.length > 512 || saved.deferred.some((id) => typeof id !== 'string')) return;
      if (!Array.isArray(saved.blocked) || saved.blocked.length > 512 || saved.blocked.some((row) => typeof row?.id !== 'string'
        || !Number.isFinite(row.at) || typeof row.token !== 'string' || row.token.length > 128)) return;
      state.deferred = [...new Set(saved.deferred)];
      state.blocked = new Map(saved.blocked.map((row) => [row.id, { id: row.id, at: row.at, token: row.token }]));
      state.expiries = new Map(Object.entries(saved.expiries ?? {}).filter(([, at]) => Number.isFinite(at)));
      state.loaded = saved.loaded === true;
    } catch { /* 首次运行、跨日或文件损坏时，重新读取额度建立默认顺序。 */ }
  }
  save(state) {
    if (!this.stateFile || this.state !== state) return;
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 2, scope: state.scope, day: state.day, loaded: state.loaded,
        expiries: Object.fromEntries(state.expiries), deferred: state.deferred, blocked: [...state.blocked.values()] }), { mode: 0o600 });
      renameSync(temporary, this.stateFile);
    } catch { this.onError('渠道顺序保存失败，本次运行继续使用内存中的顺序'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* 临时文件清理不影响选路。 */ } }
  }
}
