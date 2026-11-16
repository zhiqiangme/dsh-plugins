import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETRY_QUOTAS_MS = 5 * 60_000;
export const channelId = (row) => row.id.includes('/') ? row.id.slice(0, row.id.indexOf('/')) : row.id;
// 以运行 DSH 的电脑本地日期为界；跨日后的首次调用必须先刷新，不能沿用昨天的失败顺序。
export function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

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

/** 全部渠道共用当天的队列；失败只后移渠道，不改模型清单，也不靠会话固定或分钟冷却恢复优先级。 */
export class ChannelOrder {
  constructor({ now = Date.now, loadQuotas = async () => [], stateFile, onError = () => {} } = {}) {
    Object.assign(this, { now, loadQuotas, stateFile, onError });
  }
  async prepare(config) {
    const scope = createHash('sha256').update(config.baseURL).digest('hex'), day = localDay(this.now());
    if (this.state?.scope !== scope || this.state.day !== day) {
      this.state = { scope, day, base: [], deferred: [], expiries: new Map(), loaded: false, retryAt: 0 };
      this.restore(this.state);
    }
    const state = this.state;
    state.providers = [...new Set(config.models.map(channelId))];
    this.arrange(state);
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
    return [...rows].sort((a, b) => (positions.get(channelId(a)) ?? Infinity) - (positions.get(channelId(b)) ?? Infinity));
  }
  failed(state, row) {
    // 昨天或旧网关的在途请求晚到失败，不能覆盖今日/新网关的默认顺序。
    const provider = channelId(row);
    if (this.state !== state || state.day !== localDay(this.now()) || !state.providers.includes(provider)) return;
    state.deferred = [...state.deferred.filter((id) => id !== provider), provider];
    this.arrange(state);
    this.save(state);
  }
  restore(state) {
    if (!this.stateFile) return;
    try {
      if (statSync(this.stateFile).size > 256 * 1024) return;
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (saved.version !== 1 || saved.scope !== state.scope || saved.day !== state.day) return;
      if (!Array.isArray(saved.deferred) || saved.deferred.length > 512 || saved.deferred.some((id) => typeof id !== 'string')) return;
      state.deferred = [...new Set(saved.deferred)];
      state.expiries = new Map(Object.entries(saved.expiries ?? {}).filter(([, at]) => Number.isFinite(at)));
      state.loaded = saved.loaded === true;
    } catch { /* 首次运行、跨日或文件损坏时，重新读取额度建立默认顺序。 */ }
  }
  save(state) {
    if (!this.stateFile || this.state !== state) return;
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, scope: state.scope, day: state.day, loaded: state.loaded,
        expiries: Object.fromEntries(state.expiries), deferred: state.deferred }), { mode: 0o600 });
      renameSync(temporary, this.stateFile);
    } catch { this.onError('渠道顺序保存失败，本次运行继续使用内存中的顺序'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* 临时文件清理不影响选路。 */ } }
  }
}
