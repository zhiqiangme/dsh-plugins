/**
 * 合并模型选出口要用的数据：各出口最早什么时候有积分作废、此刻哪些出口能接请求。
 *
 * 两边来源不同：
 *   - CN / GL 读 hub 的账号文件。积分快照里有每个包的到期时间，而 hub 的同类接口都要面板会话，
 *     用户改过面板密码后插件没有明文，读文件不用密码，也不发上游请求。
 *   - HW（CodeArts）的积分只在 hub 内存里，只能登录面板读 /codearts/overview。它只有套餐结束日期，
 *     没有每个包的到期时间，所以精度不如 CN / GL。
 *
 * 账号文件里有令牌：这里只取积分字段，其它内容不进返回值和日志。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HUB_DEFAULT_PANEL_PASSWORD, hubPanelPasswordIsDefault } from './hub.js';
import { CODEARTS_REALM, HUB_PANEL_PASSWORD_REF, modelsEndpoint } from './models.js';

/** 账号文件只在 hub 刷新积分时变（默认 12 小时一次），一分钟读一次足够。 */
const LOCAL_TTL_MS = 60_000;
/** /codearts/overview 每次可能请求华为云，hub 自己只缓存 60 秒，不能跟着对话频率打。 */
const CODEARTS_TTL_MS = 30 * 60_000;
/** 读失败后隔一阵再试：hub 重启中或临时不通时不必等满 30 分钟。 */
const CODEARTS_RETRY_MS = 5 * 60_000;
/** /health 是本机请求、hub 不记日志，但一轮对话会连发很多次，合并到 5 秒一次。 */
const HEALTH_TTL_MS = 5000;
/** 首次取 HW 数据时对话最多等这么久；超时先按未知排序，结果回来后下一轮生效。 */
const FIRST_READ_WAIT_MS = 3000;
/** 与 hub 的 EXPIRY_SENTINEL_DAYS 一致：到期超过两年的包按不过期算（体验版的截止时间在 8 年后）。 */
const EXPIRY_SENTINEL_MS = 730 * 86_400_000;
/** 面板接口的超时：hub 给 overview 每个账号 8 秒上限，再留一点余量。 */
const PANEL_TIMEOUT_MS = 12_000;

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * hub 写的是本地时间串（`2026-11-07 09:00:10`）；CodeArts 的 end_date 可能只有日期，
 * 只有日期时按当天结束算，否则最后一天会被算成已过期。
 */
export function parseStamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e11 ? value : value * 1000;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const stamp = hour === undefined
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59)
    : new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0));
  return Number.isNaN(stamp.getTime()) ? null : stamp.getTime();
}

/** 包的作废时刻；已过期、用完或实际不过期的包返回 null，这些不该影响选出口。 */
function packageExpiry(pkg, now) {
  const remain = Number(pkg?.remain);
  if (!(remain > 0) || pkg.no_expiry || pkg.package_code === 'enterprise') return null;
  const expireAt = parseStamp(pkg.expire_time || pkg.cycle_end_time);
  // no_expiry 是抓取时算的，这里再按时间判一次，覆盖没有这个字段的旧快照。
  return expireAt !== null && expireAt > now && expireAt - now <= EXPIRY_SENTINEL_MS ? expireAt : null;
}

/**
 * 读 hub 账号目录，按出口汇总最早到期的积分。
 *
 * @returns {{ cn: object, intl: object }} expireAt 为 null 表示这个出口没有会到期的积分
 */
export function readWorkBuddyExpiry(accountsDir, now = Date.now()) {
  const exits = {
    cn: { realm: 'cn', state: 'none', expireAt: null, remain: 0, expiring: 0, accounts: 0 },
    intl: { realm: 'intl', state: 'none', expireAt: null, remain: 0, expiring: 0, accounts: 0 },
  };
  let files;
  try { files = readdirSync(accountsDir).filter((name) => name.endsWith('.json')); }
  catch { return exits; }
  for (const name of files) {
    let account;
    try { account = JSON.parse(readFileSync(join(accountsDir, name), 'utf8')); }
    catch { continue; }
    const credits = plainObject(account?.credits);
    if (!Array.isArray(credits.packages) || account.enabled === false) continue;
    const exit = exits[account.realm === 'global' ? 'intl' : account.realm];
    if (!exit) continue;
    exit.accounts += 1;
    exit.remain += Number(credits.remain) > 0 ? Number(credits.remain) : 0;
    for (const pkg of credits.packages) {
      const expireAt = packageExpiry(pkg, now);
      if (expireAt === null) continue;
      if (exit.expireAt === null || expireAt < exit.expireAt) {
        exit.expireAt = expireAt;
        exit.expiring = Number(pkg.remain);
      }
      exit.state = 'ready';
    }
  }
  return exits;
}

/** 从 /codearts/overview 取 HW 的到期情况：只算还有积分、没被停用的账号。 */
export function readCodeArtsExpiry(overview, now = Date.now()) {
  const exit = { realm: CODEARTS_REALM, state: 'none', expireAt: null, remain: 0, expiring: 0, accounts: 0 };
  for (const account of Array.isArray(overview?.accounts) ? overview.accounts : []) {
    const credits = plainObject(account?.credits);
    const remain = Number(credits.remain);
    if (account?.disabled || !(remain > 0)) continue;
    exit.accounts += 1;
    exit.remain += remain;
    const expireAt = parseStamp(credits.end_date);
    if (expireAt === null || expireAt <= now) continue;
    if (exit.expireAt === null || expireAt < exit.expireAt) {
      exit.expireAt = expireAt;
      exit.expiring = Number(credits.expiring) > 0 ? Number(credits.expiring) : remain;
    }
    exit.state = 'ready';
  }
  return exit;
}

function hubOrigin(baseURL) {
  return modelsEndpoint(baseURL)?.replace(/\/v1\/models$/, '');
}

/**
 * 登录 hub 面板。
 *
 * @returns {Promise<{ state: 'ok', token: string } | { state: 'rejected' | 'limited' | 'unavailable' }>}
 */
export async function panelLogin({ baseURL, password, timeoutMs = PANEL_TIMEOUT_MS }) {
  try {
    const response = await fetch(`${hubOrigin(baseURL)}/panel/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) return { state: 'rejected' };
    if (response.status === 429) return { state: 'limited' };
    const token = response.ok ? (await response.json())?.token : undefined;
    return typeof token === 'string' && token ? { state: 'ok', token } : { state: 'unavailable' };
  } catch { return { state: 'unavailable' }; }
}

/**
 * 按配置现取出口数据；`resolved.models` 可能被就地替换，每次都重读。
 *
 * @param {object} options
 * @param {object} options.resolved
 * @param {() => object | undefined} options.credentials 现取宿主凭据服务
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => number} [options.now]
 */
export function createExitCredits({ resolved, credentials, env = process.env, now = Date.now }) {
  let local;
  let localAt = -Infinity;
  let health;
  let healthAt = -Infinity;
  let checking;
  let codearts;
  let codeartsRetryAt = -Infinity;
  let reading;
  let token;
  // hub 限流是同一地址一分钟 5 次失败，会把用户的浏览器登录一起锁住。
  // 被拒过的密码不再重试，等用户换了密码再说。
  let rejected;

  const accountsDir = () => (resolved.backend?.paths ?? resolved.paths)?.accounts;

  async function panelPassword() {
    const saved = await credentials()?.resolve?.(HUB_PANEL_PASSWORD_REF);
    const stored = env[HUB_PANEL_PASSWORD_REF] || (typeof saved === 'string' ? saved : saved?.value);
    if (stored) return stored;
    const paths = resolved.backend?.paths ?? resolved.paths;
    return paths?.accounts && hubPanelPasswordIsDefault(paths) === true ? HUB_DEFAULT_PANEL_PASSWORD : '';
  }

  /** 会话只活在 hub 内存里，hub 重启后旧 token 失效：401 时重新登录一次。 */
  async function panelJson(path, password) {
    const baseURL = resolved.models.baseURL;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!token) {
        const login = await panelLogin({ baseURL, password });
        if (login.state === 'rejected') rejected = password;
        if (login.state !== 'ok') return { state: login.state === 'rejected' ? 'auth-failed' : 'unavailable' };
        token = login.token;
      }
      const response = await fetch(`${hubOrigin(baseURL)}${path}`, { headers: { 'X-Panel-Token': token }, signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) });
      if (response.status === 401) { token = undefined; continue; }
      return response.ok ? { state: 'ok', value: await response.json() } : { state: 'unavailable' };
    }
    return { state: 'unavailable' };
  }

  async function readCodeArts() {
    try {
      const password = await panelPassword();
      if (!password) { token = undefined; return { realm: CODEARTS_REALM, state: 'no-password', expireAt: null }; }
      if (password === rejected) return { realm: CODEARTS_REALM, state: 'auth-failed', expireAt: null };
      const result = await panelJson('/codearts/overview', password);
      if (result.state !== 'ok') return { realm: CODEARTS_REALM, state: result.state, expireAt: null };
      return readCodeArtsExpiry(result.value, now());
    } catch { return { realm: CODEARTS_REALM, state: 'unavailable', expireAt: null }; }
  }

  /** 暂时读不到时沿用上次的到期时间：套餐结束日期不会因为 hub 重启就变。 */
  function refreshCodeArts() {
    reading ??= readCodeArts().then((next) => {
      const keep = next.state === 'unavailable' && codearts?.expireAt != null;
      codearts = keep ? codearts : next;
      codeartsRetryAt = now() + (next.state === 'ready' || next.state === 'none' ? CODEARTS_TTL_MS : CODEARTS_RETRY_MS);
      return codearts;
    }).finally(() => { reading = undefined; });
    return reading;
  }

  async function readHealth() {
    try {
      const response = await fetch(`${hubOrigin(resolved.models.baseURL)}/health`, { signal: AbortSignal.timeout(3000) });
      const payload = await response.json();
      // 旧版 hub 没有按出口的账号数，当作都能用。
      const counts = payload?.accounts_ready_by_realm ?? { cn: 1, intl: 1 };
      const ready = new Set(Object.entries(counts).filter(([, count]) => count > 0).map(([realm]) => realm));
      if (payload?.codearts?.configured && payload.codearts.healthy !== 0) ready.add(CODEARTS_REALM);
      health = { ready, codearts: payload?.codearts?.configured === true };
    } catch { health = undefined; }
    healthAt = now();
    return health;
  }

  /** 过期了也先用旧值，后台刷新：这一步在对话请求的路径上，不能让用户等华为云。 */
  async function codeArtsExit() {
    if (now() < codeartsRetryAt) return codearts;
    const pending = refreshCodeArts();
    if (codearts) return codearts;
    let timer;
    const waited = new Promise((done) => { timer = setTimeout(done, FIRST_READ_WAIT_MS); timer.unref?.(); });
    const first = await Promise.race([pending, waited]);
    clearTimeout(timer);
    return first ?? { realm: CODEARTS_REALM, state: 'unavailable', expireAt: null };
  }

  return {
    /** @returns {Promise<{ cn: object, intl: object, codearts?: object }>} 没启用 CodeArts 时没有 codearts */
    async snapshot() {
      if (now() - localAt >= LOCAL_TTL_MS) {
        local = readWorkBuddyExpiry(accountsDir(), now());
        localAt = now();
      }
      const ready = await this.readiness();
      return { ...local, ...(ready?.codearts === false ? {} : { codearts: await codeArtsExit() }) };
    },

    /**
     * 此刻能接请求的出口；探不到时返回 undefined，由调用方照常发请求，让 hub 报真实错误。
     *
     * @returns {Promise<{ ready: Set<string>, codearts: boolean } | undefined>}
     */
    async readiness() {
      if (now() - healthAt < HEALTH_TTL_MS) return health;
      checking ??= readHealth().finally(() => { checking = undefined; });
      return checking;
    },

    /** 用户换了面板密码：旧会话和失败记录都作废，下一轮重新读 HW。 */
    reset() {
      token = undefined;
      rejected = undefined;
      codearts = undefined;
      codeartsRetryAt = -Infinity;
    },
  };
}

/** 合并模型的固定兜底顺序：与 HUB_KEY_REFS 相同，也是合并名称的取值顺序。 */
const EXIT_ORDER = Object.freeze(['cn', 'intl', CODEARTS_REALM]);

/**
 * 给合并模型的成员排序，排在前面的先试；同一出口的免费和付费是两个成员。
 *
 * 规则：免费的不花积分，优先且按固定顺序；其余最早有积分作废的优先；到期相同或都未知时比倍率。
 * 能接图片的出口才收带图请求；没有一个出口能接时不过滤，让 hub 报真实错误。
 *
 * @param {{ realm: string, vision?: boolean, price?: number | null }[]} members
 * @param {Record<string, { expireAt?: number | null }>} credits
 * @param {{ ready?: Set<string>, image?: boolean }} [request]
 */
export function rankExits(members, credits = {}, { ready, image = false } = {}) {
  const usable = ready ? members.filter((member) => ready.has(member.realm)) : members;
  const pool = usable.length ? usable : members;
  const capable = image ? pool.filter((member) => member.vision) : pool;
  const free = (member) => member.price === 0;
  const expiry = (member) => credits[member.realm]?.expireAt ?? Infinity;
  const price = (member) => member.price ?? Infinity;
  // Infinity - Infinity 是 NaN，|| 会跳到下一条比较，正好就是"都未知时比下一项"。
  return [...(capable.length ? capable : pool)].sort((a, b) => (free(b) - free(a)) ||
    (free(a) ? 0 : (expiry(a) - expiry(b)) || (price(a) - price(b))) ||
    (EXIT_ORDER.indexOf(a.realm) - EXIT_ORDER.indexOf(b.realm)));
}
