/**
 * 版本检查：本插件当前运行的版本 vs npm 上的 latest。
 *
 * 只负责“看”，不负责“装”：真正的更新交给 DSH 官方 pluginManager（浏览器半侧调用 Remote），
 * 旧宿主上交给 dshmarket。本插件不自己跑 pnpm——那要和插件管理器抢 profile 锁，还得重做回滚。
 *
 * 放在宿主半侧而不是浏览器直接 fetch 注册表：DSH 页面的 CSP / 跨源限制不归本插件管，
 * 宿主的 fetch 还走 DSH 的代理策略。
 */
import { readFileSync } from 'node:fs'

/** 模块加载时读一次，代表“正在运行的代码”，而不是磁盘上可能已被换掉的那份。 */
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const PACKAGE_NAME = PACKAGE.name
export const RUNNING_VERSION = PACKAGE.version

/**
 * 同时问官方源与国内镜像，取成功答复里最高的版本：国内网络常连不上 registry.npmjs.org；
 * 镜像同步有延迟，只问镜像可能把刚发布的版本说成“已是最新”。
 */
export const DEFAULT_REGISTRIES = Object.freeze(['https://registry.npmjs.org', 'https://registry.npmmirror.com'])

/** dist-tags 响应只有几十字节，5s 还没回就当注册表不可达。 */
const REGISTRY_TIMEOUT_MS = 5_000

/** 插件页每次打开都会问一次，结果缓存 10 分钟；“检查更新”按钮带 force 绕过。 */
const CACHE_TTL_MS = 10 * 60_000

/**
 * 比较两个 `x.y.z[-pre]` 版本号；本插件的版本是日期（26.10.30），恰好也是合法 semver。
 * 预发布低于同号正式版；预发布标识之间按字符串比即可（latest 标签只指正式版）。
 *
 * @returns {number} a<b 为负，a>b 为正，相等为 0；任一方不是版本号时返回 NaN
 */
export function compareVersions(a, b) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(value ?? '').trim())
    return match ? { nums: match.slice(1, 4).map(Number), pre: match[4] ?? '' } : undefined
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return Number.NaN
  for (let index = 0; index < 3; index++) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] - right.nums[index]
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

/** 作用域包名在注册表 URL 里要把 `/` 编码成 `%2f`（`@` 保留），npm 与 npmmirror 都认。 */
function encodePackageName(name) {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
}

/** 问一个注册表的 dist-tags.latest；失败返回 { ok: false, reason }，不抛。 */
async function fetchLatest(registry, name, { fetchImpl, timeoutMs }) {
  const url = `${registry.replace(/\/+$/, '')}/-/package/${encodePackageName(name)}/dist-tags`
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, registry, reason: `HTTP ${response.status}` }
    const body = await response.json()
    const latest = typeof body?.latest === 'string' ? body.latest : ''
    if (Number.isNaN(compareVersions(latest, latest))) return { ok: false, registry, reason: '答复里没有 latest 版本' }
    return { ok: true, registry, latest }
  } catch (error) {
    return { ok: false, registry, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 查 latest 并与正在运行的版本比较。
 *
 * @param {{ name?: string, current?: string, registries?: readonly string[], fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function checkLatestVersion(options = {}) {
  const name = options.name ?? PACKAGE_NAME
  const current = options.current ?? RUNNING_VERSION
  const registries = options.registries ?? DEFAULT_REGISTRIES
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS
  const answers = await Promise.all(registries.map(registry => fetchLatest(registry, name, { fetchImpl, timeoutMs })))
  const ok = answers.filter(answer => answer.ok)
  const checkedAt = new Date().toISOString()
  if (!ok.length) {
    return { ok: false, name, currentVersion: current, checkedAt, reason: answers.map(answer => `${answer.registry}：${answer.reason}`).join('；') }
  }
  const best = ok.reduce((left, right) => compareVersions(right.latest, left.latest) > 0 ? right : left)
  return {
    ok: true,
    name,
    currentVersion: current,
    latestVersion: best.latest,
    updateAvailable: compareVersions(best.latest, current) > 0,
    registry: best.registry,
    checkedAt,
  }
}

/**
 * 带缓存的检查器：同一时刻只有一次在途请求，成功结果缓存 ttlMs；失败不缓存，下次直接重试。
 *
 * @param {Parameters<typeof checkLatestVersion>[0] & { ttlMs?: number, now?: () => number }} [options]
 */
export function createVersionChecker(options = {}) {
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS
  const now = options.now ?? Date.now
  let cached
  let inflight
  return async ({ force = false } = {}) => {
    if (!force && cached && now() - cached.at < ttlMs) return cached.value
    if (inflight) return inflight
    inflight = checkLatestVersion(options)
      .then(value => {
        cached = value.ok ? { at: now(), value } : undefined
        return value
      })
      .finally(() => { inflight = undefined })
    return inflight
  }
}
