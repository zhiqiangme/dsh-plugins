/** 面板只读本地健康状态和 HUB 积分缓存，不触发上游刷新或对话。 */
import { gatewayDriver } from './gateway.js';
import { HUB_REALM_HEADER, hubRegionRoutes, resolveModelApiKey, modelsEndpoint } from './models.js';
import { healthTarget } from './resync.js';

const count = (value) => Number.isInteger(value) && value >= 0 ? value : null;
export function createAccountOverview({ resolved, credentials, env = process.env, driver = gatewayDriver(resolved), now = Date.now }) {
  let cached, config, expires = 0, running;
  async function balance(realm, key) {
    try {
      const url = modelsEndpoint(resolved.models.baseURL).replace(/models$/, 'balance-summary');
      const headers = key ? { authorization: `Bearer ${key}` } : {};
      // 未绑定区域的 Key 靠这个头取指定区域的积分；绑定了区域的 Key 由 hub 按绑定处理。
      if (realm !== 'current') headers[HUB_REALM_HEADER] = realm;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (!response.ok) return { realm, state: response.status === 404 ? 'unsupported' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable', balance: null };
      const payload = await response.json();
      if (realm !== 'current' && payload.realm !== realm && !(realm === 'intl' && payload.realm === 'global')) return { realm, state: 'wrong-region', balance: null };
      const value = typeof payload.balance === 'number' && Number.isFinite(payload.balance) && payload.balance >= 0 ? payload.balance : null;
      return { realm: payload.realm || realm, state: value === null ? 'unknown' : 'ready', balance: value,
        accountsEnabled: count(payload.accounts_enabled), accountsKnown: count(payload.accounts_with_credit_data),
        updatedAt: typeof payload.updated_at === 'number' && Number.isFinite(payload.updated_at) && payload.updated_at > 0 && payload.updated_at < 8.64e12 ? new Date(payload.updated_at * 1000).toISOString() : null };
    } catch { return { realm, state: 'unavailable', balance: null }; }
  }
  async function collect() {
    const service = typeof credentials === 'function' ? credentials() : credentials;
    const health = await driver.probe({ ...healthTarget(resolved.models.baseURL, resolved.spec), timeoutMs: 3000 });
    let balances = [];
    if (resolved.gateway === 'hub') {
      if (resolved.models.hubDual) {
        const routes = await hubRegionRoutes({ models: resolved.models, credentials: service, env });
        balances = await Promise.all(['cn', 'intl'].map((realm) => balance(realm, routes[realm].apiKey)));
      } else balances = [await balance('current', await resolveModelApiKey(resolved.models, env, service))];
    }
    return { at: new Date(now()).toISOString(), ok: health.ok, ready: count(health.healthy), total: count(health.total), realm: health.realm, balances };
  }
  return function overview() {
    if (cached && config === resolved.models && now() < expires) return Promise.resolve(cached);
    if (running) return running;
    const requestConfig = resolved.models;
    running = collect().catch(() => ({ ok: false, ready: null, total: null, balances: [] }))
      .then((value) => { cached = value; config = requestConfig; expires = now() + (value.ok ? 30_000 : 5000); return value; })
      .finally(() => { running = undefined; });
    return running;
  };
}
