import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETRY_QUOTAS_MS = 5 * 60_000;
export const REFRESH_QUOTAS_MS = 60 * 60_000;
const providerId = (row) => row.id.split('/', 1)[0];
export const channelId = (row) => row.channel ?? providerId(row);
const accountSuffix = /#account-([a-f0-9]{16})$/;
const channelProvider = (id) => id.replace(accountSuffix, '');
// 北京时间 04:00 开始新一天：UTC+8 再减去 4 小时，完全不依赖宿主电脑的时区。
export function routingDay(at) { return new Date(at + 4 * 3600_000).toISOString().slice(0, 10); }

function quotaRoutes(payload, now) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) throw new Error('Magpie 额度目录格式无效');
  const accounts = new Map(), expiries = new Map();
  const noteExpiry = (id, at) => expiries.set(id, Math.min(expiries.get(id) ?? Infinity, at));
  for (const card of rows) {
    const provider = card?.provider;
    if (typeof provider !== 'string') continue;
    const user = typeof card.user === 'string' ? card.user.trim() : '';
    let id;
    // Quota 的订阅 user 是网关选号用的登录名。API Key 余额卡及远端转述的卡片不作为可钉选账号。
    if (card.kind === 'subscription' && !card.from && user && user.length <= 512 && user.isWellFormed()) {
      id = `${provider}#account-${createHash('sha256').update(user.toLowerCase()).digest('hex').slice(0, 16)}`;
      if (!accounts.has(provider)) accounts.set(provider, new Map());
      accounts.get(provider).set(id, encodeURIComponent(user));
    }
    for (const window of Array.isArray(card.windows) ? card.windows : []) {
      // 周期重置、套餐期限和预计用完不等同于积分到期。
      if (!(typeof window?.runsOut === 'number' && window.runsOut > 0)
        || (typeof window.remaining === 'number' && window.remaining <= 0)
        || typeof window.runsOutAt !== 'string') continue;
      const at = Date.parse(window.runsOutAt);
      if (!Number.isFinite(at) || at <= now || at >= Date.UTC(9999, 0, 1)) continue;
      noteExpiry(provider, at);
      if (id) noteExpiry(id, at);
    }
  }
  return { accounts, expiries };
}

/** 全部渠道共用当天的队列；一般失败后移，余额不足当天停用，不改模型清单。 */
export class ChannelOrder {
  constructor({ now = Date.now, loadQuotas = async () => [], stateFile, onError = () => {} } = {}) {
    Object.assign(this, { now, loadQuotas, stateFile, onError });
  }
  stateFor(config) {
    const scope = createHash('sha256').update(config.baseURL).digest('hex'), day = routingDay(this.now());
    if (this.state?.scope !== scope || this.state.day !== day) {
      this.state = { scope, day, deferred: [], blocked: new Map(), generations: new Map(), expiries: new Map(),
        accounts: new Map(), splitProviders: new Set(), needsAccounts: false,
        loaded: false, refreshedAt: 0, retryAt: 0, failureSerial: 0, failures: new Map() };
      this.restore(this.state);
    }
    const state = this.state;
    state.providers = [...new Set(config.models.map(providerId))];
    this.arrange(state);
    return state;
  }
  async prepare(config, key) {
    const state = this.stateFor(config);
    const fingerprint = createHash('sha256').update(key ?? '').digest('hex');
    if (state.quotaScope?.fingerprint !== fingerprint) {
      if (state.quotaScope) {
        state.accounts.clear();
        state.needsAccounts = true;
        state.retryAt = 0;
        state.loading = undefined;
        this.arrange(state);
      }
      state.quotaScope = { fingerprint };
    }
    const quotaScope = state.quotaScope;
    if ((!state.loaded || state.needsAccounts || this.now() - state.refreshedAt >= REFRESH_QUOTAS_MS) && this.now() >= state.retryAt) {
      state.loading ??= this.refresh(state, config, key, quotaScope).finally(() => {
        if (state.quotaScope === quotaScope) state.loading = undefined;
      });
      await state.loading;
    }
    return state;
  }
  async refresh(state, config, key, quotaScope) {
    const reset = state.loaded && this.now() - state.refreshedAt >= REFRESH_QUOTAS_MS;
    const before = state.failureSerial;
    const current = () => this.state === state && state.quotaScope === quotaScope;
    try {
      const { accounts, expiries } = quotaRoutes(await this.loadQuotas(config, key), this.now());
      if (!current()) return;
      state.accounts = accounts;
      for (const [provider, pool] of accounts) if (pool.size > 1) state.splitProviders.add(provider);
      state.expiries = expiries;
      if (reset || !state.loaded) state.refreshedAt = this.now();
      state.loaded = true;
      state.needsAccounts = false;
      state.retryAt = 0;
      // 每小时恢复到期优先级，但不能抹掉本次额度读取期间刚发生的失败，也不恢复余额不足停用。
      if (reset) state.deferred = state.deferred.filter((id) => (state.failures.get(id) ?? 0) > before);
      this.arrange(state);
      this.save(state);
    } catch {
      if (!current()) return;
      // 额度接口失败不阻断模型调用；保留当天已知顺序和失败后移记录，五分钟后有请求时重试。
      state.retryAt = this.now() + RETRY_QUOTAS_MS;
      this.onError('额度读取失败，暂按已有渠道顺序选路，稍后重试');
    }
  }
  pool(state, provider) {
    return state.splitProviders.has(provider) ? state.accounts.get(provider) : undefined;
  }
  expand(state, rows, key) {
    if (state.quotaScope.fingerprint !== createHash('sha256').update(key ?? '').digest('hex')) return rows;
    return rows.flatMap((row) => {
      const pool = this.pool(state, providerId(row));
      return pool?.size ? [...pool].map(([channel, account]) => ({ ...row, channel, account })) : [row];
    });
  }
  arrange(state) {
    const base = state.providers.flatMap((provider) => [...(this.pool(state, provider)?.keys() ?? [provider])])
      .sort((a, b) => (state.expiries.get(a) ?? Infinity) - (state.expiries.get(b) ?? Infinity));
    state.deferred = state.deferred.filter((id) => state.providers.includes(channelProvider(id)));
    const deferred = new Set();
    for (const id of state.deferred) {
      for (const channel of this.pool(state, id)?.keys() ?? [id]) {
        deferred.delete(channel);
        deferred.add(channel);
      }
    }
    state.order = [...base.filter((id) => !deferred.has(id)), ...deferred];
  }
  rank(state, rows, loads = new Map()) {
    const positions = new Map(state.order.map((provider, index) => [provider, index]));
    // 旧版的整渠道停用照常生效。账号目录缺失时不能靠无账号请求绕过已知的账号停用。
    const blockedProviders = new Set([...state.blocked.keys()].map(channelProvider));
    return rows.filter((row) => row.account
      ? !state.blocked.has(providerId(row)) && !state.blocked.has(channelId(row))
      : !blockedProviders.has(providerId(row)))
      .sort((a, b) => (loads.get(channelId(a)) ?? 0) - (loads.get(channelId(b)) ?? 0)
        || (positions.get(channelId(a)) ?? Infinity) - (positions.get(channelId(b)) ?? Infinity));
  }
  generation(state, row) { return state.generations.get(channelId(row)) ?? 0; }
  exhausted(state, row, generation = this.generation(state, row)) {
    const id = channelId(row);
    // 手动恢复前已发出的旧请求不能再次停用刚恢复的渠道；恢复后的新请求仍可重新报告余额不足。
    if (this.state !== state || state.day !== routingDay(this.now()) || !state.providers.includes(providerId(row))
      || state.blocked.has(id) || generation !== this.generation(state, row)) return;
    state.blocked.set(id, { id, at: this.now(), token: randomUUID() });
    this.save(state);
  }
  snapshot(config) {
    const state = this.stateFor(config);
    const blocked = [...state.blocked.values()].map((row) => {
      const suffix = accountSuffix.exec(row.id)?.[1];
      return suffix ? { ...row, provider: channelProvider(row.id), accountLabel: suffix.slice(0, 8) } : { ...row };
    });
    return { day: state.day, blocked };
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
    const id = channelId(row);
    if (this.state !== state || state.day !== routingDay(this.now()) || !state.providers.includes(providerId(row))) return;
    state.deferred = [...state.deferred.filter((other) => other !== id), id];
    state.failures.set(id, ++state.failureSerial);
    this.arrange(state);
    this.save(state);
  }
  restore(state) {
    if (!this.stateFile) return;
    try {
      if (statSync(this.stateFile).size > 256 * 1024) return;
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (![2, 3].includes(saved.version) || saved.scope !== state.scope || saved.day !== state.day) return;
      if (!Array.isArray(saved.deferred) || saved.deferred.length > 512 || saved.deferred.some((id) => typeof id !== 'string')) return;
      if (!Array.isArray(saved.blocked) || saved.blocked.length > 512 || saved.blocked.some((row) => typeof row?.id !== 'string'
        || !Number.isFinite(row.at) || typeof row.token !== 'string' || row.token.length > 128)) return;
      state.deferred = [...new Set(saved.deferred)];
      state.blocked = new Map(saved.blocked.map((row) => [row.id, { id: row.id, at: row.at, token: row.token }]));
      state.expiries = new Map(Object.entries(saved.expiries ?? {}).filter(([, at]) => Number.isFinite(at)));
      if (Array.isArray(saved.splitProviders)) state.splitProviders = new Set(saved.splitProviders.filter((id) => typeof id === 'string'));
      state.needsAccounts = saved.version === 2 || state.splitProviders.size > 0;
      state.loaded = saved.loaded === true;
      state.refreshedAt = Number.isFinite(saved.refreshedAt) ? saved.refreshedAt : 0;
    } catch { /* 首次运行、跨日或文件损坏时，重新读取额度建立默认顺序。 */ }
  }
  save(state) {
    if (!this.stateFile || this.state !== state) return;
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      // 只保存账号的哈希渠道 ID；重启后从网关重新读取可用的选号值。
      writeFileSync(temporary, JSON.stringify({ version: 3, scope: state.scope, day: state.day, loaded: state.loaded, refreshedAt: state.refreshedAt,
        expiries: Object.fromEntries(state.expiries), deferred: state.deferred, blocked: [...state.blocked.values()],
        splitProviders: [...state.splitProviders] }), { mode: 0o600 });
      renameSync(temporary, this.stateFile);
    } catch { this.onError('渠道顺序保存失败，本次运行继续使用内存中的顺序'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* 临时文件清理不影响选路。 */ } }
  }
}
