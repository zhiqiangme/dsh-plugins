import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

export const WEB_KEY_REF = 'DSH_MAGPIE_WEB_KEY';
export const WEB_ORIGIN = 'http://127.0.0.1:3430';
const exec = promisify(execFile);
const TAVILY_NOT_CONFIGURED = Symbol('Tavily not configured');
const TAVILY_KEY_REQUIRED = Symbol('Tavily requires an enabled key');
const WEB_SETTINGS = 'settings';
const SEARCH_KEYS = 'settings/search-keys';
const SEARCH_API = 'settings/search-api';
const SEARCH_QUOTA = 'settings/search-quota';
const TAVILY = { vendor: 'tavily' };
const TAVILY_MANAGEMENT = 'Tavily 密钥管理';

export const validSearchKeyRef = (ref) => typeof ref === 'string' && /^[0-9a-f]{16}$/.test(ref);

function tavilyKeyList(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Magpie 搜索设置格式无效');
  const apis = settings?.searchAPIs;
  // Magpie 省略未配置的搜索来源列表。校验列表后才能依据它移除最后一把密钥。
  if (apis == null) return [];
  if (!Array.isArray(apis)) throw new Error('Magpie 搜索设置格式无效');
  const source = apis.find((api) => api?.vendor === TAVILY.vendor);
  if (!source) return [];
  const keys = source.keyList;
  if (!Array.isArray(keys) || keys.some((key) => !validSearchKeyRef(key?.ref))) throw new Error('Magpie Tavily 密钥列表格式无效');
  return keys.map(({ ref, masked, off }) => ({
    ref, masked: typeof masked === 'string' && /^[!-~]{0,5}…[!-~]{0,4}$/.test(masked) ? masked : '…', off: off === true,
  }));
}

function tavilyQuota(quota) {
  if (quota?.known !== true) return null;
  if (quota.unlimited === true) return { unlimited: true };
  const { used, limit, of, paygoLeft } = quota;
  if (![used, limit].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return {
    remaining: Math.max(0, limit - used), limit, shared: of === 'plan',
    ...(Number.isSafeInteger(paygoLeft) && paygoLeft > 0 ? { paygoLeft } : {}),
  };
}

function checkedKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{16,}$/.test(key)) throw new Error('Magpie 网页密钥无效，请检查 MAGPIE_WEB_KEY 或插件凭据');
  return key;
}

/** URL 经环境变量传给固定脚本，不把密钥拼入命令，也不在失败信息中回显链接。 */
export async function openDefaultBrowser(url) {
  try {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:DSH_MAGPIE_OPEN_URL"], {
      windowsHide: true, timeout: 10_000, env: { ...process.env, DSH_MAGPIE_OPEN_URL: url },
    });
  } catch { throw new Error('未能打开默认浏览器，请检查 Windows 默认浏览器设置'); }
}

/** 网页密钥独立于网关 Key；只存凭据库和子进程环境，不进入插件配置、状态接口或日志。 */
export class MagpieWeb {
  constructor({ env = process.env, settings, credentials, fetchImpl = fetch, openBrowser = openDefaultBrowser, timeoutMs = 15_000, pollMs = 250 } = {}) {
    Object.assign(this, { env, settings, credentials, fetchImpl, openBrowser, timeoutMs, pollMs });
  }
  key() {
    // 同时自动启动、手动打开时共用一次读写，避免两份密钥互相覆盖。
    return this.pendingKey ??= this.loadKey().catch((error) => { this.pendingKey = undefined; throw error; });
  }
  async loadKey() {
    if (this.env.MAGPIE_WEB_KEY) return checkedKey(this.env.MAGPIE_WEB_KEY);
    const credentials = typeof this.credentials === 'function' ? this.credentials() : this.credentials;
    if (!credentials?.resolve) throw new Error('宿主凭据服务尚未就绪，无法启动 Magpie 网页');
    const saved = await credentials.resolve(WEB_KEY_REF);
    if (saved?.value) return checkedKey(saved.value);
    if (!credentials.set || (await credentials.describe?.(WEB_KEY_REF))?.writable === false) throw new Error('宿主凭据库不可写，无法保存 Magpie 网页密钥');
    const key = randomBytes(32).toString('hex');
    await credentials.set(WEB_KEY_REF, key);
    return key;
  }
  appPage() {
    try {
      const value = JSON.parse(readFileSync(join(dirname(this.settings), 'web-page.json'), 'utf8'));
      if (!['local', 'lan'].includes(value.mode)) return;
      const port = value.port || 3430;
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return;
      return { origin: `http://127.0.0.1:${port}`, key: checkedKey(value.key) };
    } catch { /* 既有桌面实例未开网页或配置不可读时，使用插件管理的网页。 */ }
  }
  async probe(page) {
    try {
      const response = await this.fetchImpl(`${page.origin}/?k=${encodeURIComponent(page.key)}`, {
        redirect: 'manual', signal: AbortSignal.timeout(1_000),
      });
      const port = new URL(page.origin).port;
      // 只有 Magpie 接受密钥并换发登录 Cookie 才算就绪，不能把端口上的其它服务当作管理页。
      const authenticated = response.status === 303 && response.headers.get('set-cookie')?.startsWith(`magpie_web_${port}=`);
      await response.body?.cancel();
      return authenticated ? 'ready' : 'occupied';
    } catch (error) {
      const codes = [error?.code, error?.cause?.code, ...(error?.cause?.errors ?? []).map((e) => e.code)];
      return codes.includes('ECONNREFUSED') ? 'offline' : 'unknown';
    }
  }
  modelAPI(signal) {
    return this.authenticatedAPI(['providers', 'provider/models'], '模型目录', signal);
  }
  async addTavilyKey(key, signal) {
    const request = await this.authenticatedAPI([SEARCH_KEYS, SEARCH_API], TAVILY_MANAGEMENT, signal);
    // 追加接口沿用已有来源地址、轮换和开关。只有网关明确表示尚未配置 Tavily 时才创建来源。
    const result = await request(SEARCH_KEYS, { ...TAVILY, add: key });
    if (result === TAVILY_NOT_CONFIGURED) {
      await request(SEARCH_API, { ...TAVILY, key, append: true });
      return true;
    }
    if (result?.added === 1 || result?.had === 1) return result.added === 1;
    throw new Error('Magpie Tavily 密钥管理接口格式无效');
  }
  async tavilyKeys(fresh, signal) {
    const request = await this.authenticatedAPI([WEB_SETTINGS, SEARCH_QUOTA], TAVILY_MANAGEMENT, signal);
    const keys = tavilyKeyList(await request(WEB_SETTINGS));
    if (keys.length === 0) return keys;
    const data = await request(SEARCH_QUOTA, { ...TAVILY, fresh }).catch(() => {
      signal?.throwIfAborted();
      // Tavily 的额度接口离线时，已保存的密钥仍可查看和移除。
      return {};
    });
    const quotas = new Map(Array.isArray(data?.keys) ? data.keys.map((quota) => [quota?.ref, quota]) : []);
    return keys.map((key) => ({ ...key, quota: tavilyQuota(quotas.get(key.ref)) }));
  }
  async removeTavilyKey(ref, signal) {
    const request = await this.authenticatedAPI([SEARCH_KEYS, WEB_SETTINGS, SEARCH_API], TAVILY_MANAGEMENT, signal);
    const result = await request(SEARCH_KEYS, { ...TAVILY, ref, remove: true });
    if (result === TAVILY_NOT_CONFIGURED) return;
    if (result === TAVILY_KEY_REQUIRED) {
      // Magpie 要求 Tavily 至少保留一把启用的密钥。仅当最新列表只剩目标密钥时，才能移除整个来源。
      const keys = tavilyKeyList(await request(WEB_SETTINGS));
      if (!keys.some((key) => key.ref === ref)) return;
      if (keys.length !== 1) throw new Error('Magpie 要求 Tavily 至少有一个启用的密钥。请在 Magpie 网页启用另一把密钥后重试');
      const settings = await request(SEARCH_API, { ...TAVILY, remove: true });
      if (!tavilyKeyList(settings).some((key) => key.ref === ref)) return;
    } else if (!tavilyKeyList(result?.settings).some((key) => key.ref === ref)) return;
    throw new Error('Magpie 未能移除 Tavily 密钥');
  }
  /** 沿用已有网页登录 Cookie；调用方只能访问预先列出的接口。 */
  async authenticatedAPI(paths, label, signal) {
    const pages = [], existing = this.appPage();
    if (existing) pages.push(existing);
    const credentials = typeof this.credentials === 'function' ? this.credentials() : this.credentials;
    const saved = this.env.MAGPIE_WEB_KEY || (await credentials?.resolve?.(WEB_KEY_REF))?.value;
    if (saved) pages.push({ origin: WEB_ORIGIN, key: checkedKey(saved) });
    for (const page of pages) {
      signal?.throwIfAborted();
      let cookie;
      try {
        const login = await this.fetchImpl(`${page.origin}/?k=${encodeURIComponent(page.key)}`, {
          redirect: 'manual', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3_000)]),
        });
        const value = login.headers.get('set-cookie');
        if (login.status === 303 && value?.startsWith(`magpie_web_${new URL(page.origin).port}=`)) cookie = value.split(';')[0];
        await login.body?.cancel();
      } catch { /* 旧桌面网页密钥失效时再试插件已保存的密钥，绝不回显带密钥的 URL。 */ }
      if (!cookie) continue;
      return async (path, body) => {
        if (!paths.includes(path)) throw new Error(`不支持的 Magpie ${label}接口`);
        signal?.throwIfAborted();
        let response;
        try {
          response = await this.fetchImpl(`${page.origin}/api/${path}`, {
            method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            headers: { cookie, origin: page.origin, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]),
          });
        } catch { signal?.throwIfAborted(); throw new Error(`Magpie ${label}接口连接失败或超时`); }
        if (!response.ok) {
          if (path === SEARCH_KEYS && response.status === 400) {
            const failure = await response.json().catch(() => undefined);
            if (failure?.error === 'no tavily search API is set up') return TAVILY_NOT_CONFIGURED;
            if (body?.remove === true && failure?.error === 'Tavily needs a key on: switch the API off, or remove it, instead') return TAVILY_KEY_REQUIRED;
          } else {
            await response.body?.cancel().catch(() => undefined);
          }
          throw new Error(`Magpie ${label}接口返回 HTTP ${response.status}`);
        }
        let value;
        try { value = await response.json(); } catch { throw new Error(`Magpie ${label}接口格式无效`); }
        if (value?.error) throw new Error(`Magpie ${label}操作失败`);
        return value;
      };
    }
    signal?.throwIfAborted();
    throw new Error('Magpie 网页管理未就绪，请开启网页访问或使用网页启动方式');
  }
  open(options) {
    return this.pendingOpen ??= this.openPage(options).finally(() => { this.pendingOpen = undefined; });
  }
  async openPage({ launch, isRunning, disposed = () => false }) {
    const existing = this.appPage();
    if (existing && await this.probe(existing) === 'ready') return this.show(existing, disposed);
    const page = { origin: WEB_ORIGIN, key: await this.key() };
    const state = await this.probe(page);
    if (state === 'ready') return this.show(page, disposed);
    if (state === 'occupied') throw new Error('3430 端口已有服务，但不接受插件的网页密钥；请退出该实例后重新启动 Magpie');
    if (state === 'unknown') throw new Error('无法确认 Magpie 网页状态，请稍后重试');
    // 切换设置不强制结束现有实例；已有进程可能尚在启动，也可能仍按旧方式运行。
    const running = await isRunning();
    if (!running) await launch();
    const deadline = Date.now() + this.timeoutMs;
    while (!disposed() && Date.now() < deadline) {
      if (await this.probe(page) === 'ready') return this.show(page, disposed);
      await sleep(this.pollMs);
    }
    throw new Error(running ? 'Magpie 已在运行，但网页管理尚未就绪；若刚切换启动方式，请退出 Magpie 后重新启动' : 'Magpie 网页启动超时，请稍后重试');
  }
  async show(page, disposed) {
    if (disposed?.()) throw new Error('插件已关闭');
    await this.openBrowser(`${page.origin}/?k=${encodeURIComponent(page.key)}`);
    return { opened: 'web' };
  }
}
