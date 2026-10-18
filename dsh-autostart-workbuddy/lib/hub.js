/**
 * 第二种后端网关：workbuddy2api-hub（ardeyouxipianyi/workbuddy2api-hub）的安装、版本识别、
 * 更新 / 回滚 / 卸载与健康探针。用法与 backend.js（wb2api）一一对应，web.js 按所选网关分发。
 *
 * 与 wb2api 的根本差别：hub 是 Python 程序，release 里的便携包（workbuddy2api-hub-v<ver>.zip）
 * 是一整个目录——`wb-proxy/` 下是脚本、看板与自带的 CPython 运行时（python/python.exe），
 * 包顶层另有 release-manifest.json 写明 tag。所以这里换的是**整个目录**而不是单个 exe，
 * 版本身份取自 release-manifest.json 的 tag（hub 没有 Go 那种内嵌 revision）。
 *
 * 目录布局（在插件数据根目录下单独一个 hub/，与 wb2api 的账号数据互不影响）：
 *
 *   <root>/hub/backend/current/    正在用的包内容 + release-manifest.json
 *   <root>/hub/backend/versions/   历史版本（整目录，回滚用）
 *   <root>/hub/data/accounts/      hub 的账号凭证、设置、出口开关（--accounts-dir）——切版本不碰它
 *   <root>/hub/data/usage/         hub 的用量日志（--usage-dir）
 *   <root>/hub/cache/              下载缓存与 release 查询缓存
 *   <root>/hub/installed.json      插件记的安装来源与上一版本（不放 current/，换目录时不跟着走）
 *
 * 只依赖 node: 内置模块。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { backendPaths, purgeBackendData, stopForUpdate } from './backend.js';
import { downloadAsset, fetchChecksums, fetchLatestRelease, pickWindowsAsset, verifyChecksum } from './release.js';
import { isFile } from './services.js';
import { extractZipEntry, extractZipTree } from './zip.js';

/** hub 的上游仓库。 */
export const HUB_REPO = Object.freeze({ owner: 'ardeyouxipianyi', name: 'workbuddy2api-hub' });

/** Windows 便携包：`workbuddy2api-hub-v1.7.14.zip`（同一 release 里另有 apk/ipk 给路由器，不要）。 */
export const HUB_ASSET_PATTERN = /^workbuddy2api-hub-v[0-9][\w.-]*\.zip$/i;

/** 同一 release 同时发 checksums.txt 与 SHA256SUMS，内容一致；先找前者。 */
export const HUB_CHECKSUM_NAMES = Object.freeze(['checksums.txt', 'SHA256SUMS']);

/** 包顶层的版本清单（打包器写死 tag / root / 受保护目录）。 */
export const HUB_MANIFEST = 'release-manifest.json';

/** 包内程序目录名（manifest.root 缺失时的兜底，与上游打包器默认一致）。 */
const DEFAULT_PACKAGE_ROOT = 'wb-proxy';

const FAILED_SUFFIX = '-failed';

export const DEFAULT_HUB_KEEP_VERSIONS = 2;

/**
 * hub 的目录布局；`plugin` 是插件整体的数据根（wb2api 的布局），彻底卸载时清的是它。
 */
export function hubPaths(env = process.env) {
  const plugin = backendPaths(env);
  const root = join(plugin.root, 'hub');
  const current = join(root, 'backend', 'current');
  return {
    kind: 'hub',
    plugin,
    root,
    backend: join(root, 'backend'),
    current,
    versions: join(root, 'backend', 'versions'),
    data: join(root, 'data'),
    accounts: join(root, 'data', 'accounts'),
    usage: join(root, 'data', 'usage'),
    cache: join(root, 'cache'),
    logs: plugin.logs,
    exe: join(current, 'python', 'python.exe'),
    script: join(current, 'wb_proxy.py'),
    manifest: join(current, HUB_MANIFEST),
    state: join(root, 'installed.json'),
    releaseCache: join(root, 'cache', 'release.json'),
    apiKeyFile: join(root, 'data', 'plugin-api-key'),
  };
}

function ensureLayout(paths) {
  for (const dir of [paths.backend, paths.versions, paths.accounts, paths.usage, paths.cache]) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 版本目录名只留安全字符，没有 tag 就用时间戳（不会和真实 tag 撞名）。 */
export function hubVersionDirName(tag) {
  const safe = typeof tag === 'string' ? tag.trim().replace(/[^A-Za-z0-9._-]/g, '-') : '';
  return safe || `unknown-${Date.now()}`;
}

/** 一个目录是不是完整的 hub 程序目录（脚本 + 自带运行时都在）。 */
function isHubDir(dir) {
  return isFile(join(dir, 'wb_proxy.py')) && isFile(join(dir, 'python', 'python.exe'));
}

/** 本地版本：tag 来自 current/ 里的 release-manifest.json，安装来源与上一版本来自 installed.json。 */
export function localHubVersion(paths) {
  const manifest = readJson(paths.manifest);
  const state = readJson(paths.state);
  const tag = typeof manifest?.tag === 'string' && manifest.tag.trim() ? manifest.tag.trim() : null;
  return {
    tag,
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    // 与 wb2api 的快照同形状：hub 没有 commit / 构建时间，留空让面板按 tag 显示。
    revision: null,
    builtAt: null,
    modified: false,
    installedAt: typeof state?.installedAt === 'string' ? state.installedAt : null,
    managed: Boolean(state),
    drifted: Boolean(state?.tag && tag && state.tag !== tag),
    previous: state?.previous ?? null,
  };
}

export function listHubVersions(paths) {
  if (!existsSync(paths.versions)) return [];
  try {
    return readdirSync(paths.versions)
      .map((name) => {
        const dir = join(paths.versions, name);
        if (!isHubDir(dir)) return null;
        return { name, dir, at: statSync(dir).mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .map(({ at, ...rest }) => ({ ...rest, archivedAt: new Date(at).toISOString() }));
  } catch {
    return [];
  }
}

/** 不联网的状态快照（与 backend.js 的 describeBackend 同形状，面板共用一套渲染）。 */
export function describeHub(paths) {
  return {
    gateway: 'hub',
    // 「彻底卸载」清的是插件整体的数据根（两种网关一起），面板写明的也是它。
    root: paths.plugin.root,
    rootExists: existsSync(paths.plugin.root),
    exe: paths.exe,
    config: null,
    data: paths.data,
    exeExists: isHubDir(paths.current),
    configExists: false,
    version: localHubVersion(paths),
    history: listHubVersions(paths),
  };
}

/**
 * 健康探针：hub 的 `/health` 不鉴权、恒回 200，形如
 * `{ ok, realm, accounts, accounts_ready, api_key_required }`。它没有 service 字段，
 * 认身份靠 accounts 字段——hub 自己的启动器也是这么判定"端口上是不是自己"的。
 */
export async function probeHubHealth({ host = '127.0.0.1', port, timeoutMs = 5_000 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `/health 返回 ${response.status}` };
    const payload = await response.json().catch(() => null);
    if (!payload || payload.service || typeof payload.accounts !== 'number') {
      return { ok: false, reason: '/health 的应答不是 workbuddy2api-hub' };
    }
    const ready = Number(payload.accounts_ready) || 0;
    return {
      ok: true,
      servable: ready > 0,
      healthy: ready,
      total: Number(payload.accounts) || 0,
      realm: typeof payload.realm === 'string' ? payload.realm : undefined,
    };
  } catch (error) {
    return { ok: false, reason: `探测 /health 失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function readReleaseCache(paths, ttlMs, force, now) {
  if (force) return undefined;
  const cached = readJson(paths.releaseCache);
  if (!cached?.fetchedAt || !cached?.latest?.tag) return undefined;
  const age = now - Date.parse(cached.fetchedAt);
  return Number.isFinite(age) && age <= ttlMs ? cached.latest : undefined;
}

function writeReleaseCache(paths, latest, now) {
  // 与 backend.js 同理：hub 从没装过（目录不在）就不凭空建目录。
  if (!existsSync(paths.root)) return;
  try {
    mkdirSync(paths.cache, { recursive: true });
    writeJson(paths.releaseCache, { fetchedAt: new Date(now).toISOString(), latest });
  } catch {
    /* 缓存写不进去不影响功能 */
  }
}

function fetchLatestHubRelease({ env, apiBase }) {
  return fetchLatestRelease({ env, apiBase, repo: HUB_REPO, resolveCommit: false });
}

export async function checkHubUpdate({ paths, env = process.env, apiBase, ttlMs = 6 * 60 * 60 * 1000, force = false, now = Date.now() } = {}) {
  const local = localHubVersion(paths);
  let latest = readReleaseCache(paths, ttlMs, force, now);
  const fromCache = Boolean(latest);
  if (!latest) {
    latest = await fetchLatestHubRelease({ env, apiBase });
    writeReleaseCache(paths, latest, now);
  }
  const upToDate = Boolean(local.tag) && local.tag === latest.tag;
  return { local, latest, fromCache, upToDate, updateAvailable: !upToDate };
}

/**
 * 目录改名，带重试：进程刚退出时 Windows 可能还没释放 python 运行时的文件句柄，
 * 立即 rename 会 EPERM / EBUSY（与 backend.js purge 的 rmSync 重试同一考虑）。
 */
async function renameDir(from, to, { attempts = 15, delayMs = 200 } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const retryable = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error?.code);
      if (!retryable || i >= attempts - 1) throw error;
      await sleep(delayMs);
    }
  }
}

/** 目标目录已存在（同名旧归档、上次失败的残留）先删掉，避免 rename 撞名失败。 */
async function moveDir(from, to) {
  if (existsSync(to)) rmSync(to, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(join(to, '..'), { recursive: true });
  await renameDir(from, to);
}

/**
 * 换目录：current → versions/<旧 tag>，staged → current。
 * 新目录没落上去就把旧的还回来，不留一个空的 current。
 */
async function swapInDir(paths, stagedDir, fromTag) {
  ensureLayout(paths);
  const hadCurrent = existsSync(paths.current);
  const archiveDir = join(paths.versions, hubVersionDirName(fromTag));
  if (hadCurrent) await moveDir(paths.current, archiveDir);
  try {
    await renameDir(stagedDir, paths.current);
  } catch (error) {
    if (hadCurrent && !existsSync(paths.current) && existsSync(archiveDir)) await renameDir(archiveDir, paths.current);
    throw error;
  }
  return { hadCurrent, archiveDir };
}

/** 撤销切换：换上去的目录挪去 returnTo（缺省 `<tag>-failed`），原来的挪回 current。 */
async function rollbackSwapDir(paths, swap, toTag, { returnTo } = {}) {
  if (existsSync(paths.current)) {
    const target = returnTo ?? join(paths.versions, `${hubVersionDirName(toTag)}${FAILED_SUFFIX}`);
    try {
      await moveDir(paths.current, target);
    } catch {
      rmSync(paths.current, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  if (swap?.hadCurrent && existsSync(swap.archiveDir)) await renameDir(swap.archiveDir, paths.current);
}

/** 只保留 N 个历史版本：上一版本无条件保留，-failed 不占名额（理由同 backend.js 的 pruneVersions）。 */
export function pruneHubVersions(paths, keep = DEFAULT_HUB_KEEP_VERSIONS) {
  if (keep <= 0) return [];
  const previousTag = readJson(paths.state)?.previous?.tag;
  const previousName = previousTag ? hubVersionDirName(previousTag) : null;
  const all = existsSync(paths.versions) ? readdirSync(paths.versions) : [];
  const valid = listHubVersions(paths).map((item) => item.name);
  const kept = new Set(valid.includes(previousName) ? [previousName] : []);
  for (const name of valid) {
    if (kept.size >= keep) break;
    if (!name.endsWith(FAILED_SUFFIX)) kept.add(name);
  }
  const removed = [];
  for (const name of all.filter((entry) => !kept.has(entry))) {
    try {
      rmSync(join(paths.versions, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(name);
    } catch {
      /* 删不掉不影响功能 */
    }
  }
  return removed;
}

async function startAndProbe(service) {
  const started = await service.ensureRunning();
  if (started?.state === 'failed') return { ok: false, reason: started.reason ?? '启动失败' };
  return probeHubHealth({ host: service.spec?.host ?? '127.0.0.1', port: service.port });
}

/**
 * 更新 / 首次安装：下载 → 校验 → 读包内 manifest → 整包解到暂存目录 → 停服 → 换目录 → 起服 →
 * 健康检查（失败回滚）。与 backend.js 的 applyUpdate 同一套语义与返回形状。
 */
export async function applyHubUpdate({ paths, env = process.env, apiBase, service, logger, keepVersions = DEFAULT_HUB_KEEP_VERSIONS, target } = {}) {
  const latest = target ?? (await fetchLatestHubRelease({ env, apiBase }));
  const local = localHubVersion(paths);
  if (local.tag && local.tag === latest.tag && isHubDir(paths.current)) {
    return { ok: true, state: 'up-to-date', local, latest };
  }

  const asset = pickWindowsAsset(latest.assets, HUB_ASSET_PATTERN, 'workbuddy2api-hub 便携包');
  logger?.info?.(`[workbuddy] 下载 ${asset.name} …`);
  const archive = await downloadAsset(asset, { env, timeoutMs: 300_000 });
  const checksums = await fetchChecksums(latest, { env, apiBase, names: HUB_CHECKSUM_NAMES });
  const verified = verifyChecksum(archive, asset.name, checksums);
  if (!verified.ok) return { ok: false, state: 'verify-failed', reason: verified.reason, latest, asset: asset.name };

  // 包内 manifest 必须自称是目标 tag：对不上说明资产与 release 不配套，宁可不装。
  let manifest;
  try {
    manifest = JSON.parse(extractZipEntry(archive, HUB_MANIFEST).toString('utf8'));
  } catch (error) {
    return { ok: false, state: 'extract-failed', reason: `读不到包内 ${HUB_MANIFEST}：${error instanceof Error ? error.message : String(error)}`, latest };
  }
  if (manifest?.tag !== latest.tag) {
    return { ok: false, state: 'binary-mismatch', reason: `包内 ${HUB_MANIFEST} 的 tag（${manifest?.tag ?? '无'}）与 release（${latest.tag}）不一致`, latest };
  }

  ensureLayout(paths);
  const stagedDir = join(paths.cache, `staged-${hubVersionDirName(latest.tag)}`);
  rmSync(stagedDir, { recursive: true, force: true });
  const discardStaged = (result) => {
    rmSync(stagedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return result;
  };
  try {
    const root = typeof manifest.root === 'string' && manifest.root.trim() ? manifest.root.trim() : DEFAULT_PACKAGE_ROOT;
    extractZipTree(archive, stagedDir, { prefix: `${root}/` });
    // manifest 在包顶层、程序目录之外：放进目录里，版本身份跟着目录走（回滚后照样认得出）。
    writeJson(join(stagedDir, HUB_MANIFEST), manifest);
  } catch (error) {
    return discardStaged({ ok: false, state: 'extract-failed', reason: error instanceof Error ? error.message : String(error), latest });
  }
  if (!isHubDir(stagedDir)) {
    return discardStaged({ ok: false, state: 'binary-unknown', reason: '包里缺少 wb_proxy.py 或自带的 python/python.exe，拒绝安装', latest });
  }

  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return discardStaged({ ok: false, state: 'not-owned', reason: stop.reason, latest });

  let swap;
  try {
    swap = await swapInDir(paths, stagedDir, local.tag);
  } catch (error) {
    discardStaged();
    return { ok: false, state: 'swap-failed', reason: error instanceof Error ? error.message : String(error), latest };
  }

  const health = await startAndProbe(service);
  if (!health.ok) {
    logger?.error?.(`[workbuddy] hub 新版本启动后健康检查失败，回滚：${health.reason}`);
    await service.stop('健康检查失败，回滚');
    await rollbackSwapDir(paths, swap, latest.tag);
    const restored = swap.hadCurrent ? await service.ensureRunning() : undefined;
    return { ok: false, state: 'health-failed', reason: health.reason, rolledBack: swap.hadCurrent, restored: restored?.state, latest, local: localHubVersion(paths) };
  }

  writeJson(paths.state, {
    tag: latest.tag,
    asset: asset.name,
    sha256: verified.actual,
    installedAt: new Date().toISOString(),
    source: 'github-release',
    previous: local.tag ? { tag: local.tag } : undefined,
  });
  const pruned = pruneHubVersions(paths, keepVersions);
  logger?.info?.(`[workbuddy] hub 已更新到 ${latest.tag}`);
  if (health.servable === false) logger?.info?.('[workbuddy] hub 暂无可用账号，请在 hub 看板登录 WorkBuddy 账号');
  return { ok: true, state: 'updated', latest, health, pruned, local: localHubVersion(paths) };
}

export async function installHub(options = {}) {
  if (isHubDir(options.paths.current)) {
    return { ok: false, state: 'already-installed', reason: 'hub 已安装；升级请用「更新」' };
  }
  const result = await applyHubUpdate(options);
  return result.ok ? { ...result, state: 'installed' } : result;
}

export async function rollbackHub({ paths, service, logger } = {}) {
  const state = readJson(paths.state);
  const previousTag = state?.previous?.tag;
  if (!previousTag) return { ok: false, state: 'no-previous', reason: '没有记录上一版本（installed.json 里没有 previous）' };
  const previousDir = join(paths.versions, hubVersionDirName(previousTag));
  if (!isHubDir(previousDir)) return { ok: false, state: 'missing', reason: `找不到上一版本目录：${previousDir}` };

  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };

  const current = localHubVersion(paths);
  let swap;
  try {
    swap = await swapInDir(paths, previousDir, current.tag);
  } catch (error) {
    return { ok: false, state: 'swap-failed', reason: error instanceof Error ? error.message : String(error) };
  }

  const health = await startAndProbe(service);
  if (!health.ok) {
    logger?.error?.(`[workbuddy] hub 回滚后健康检查失败：${health.reason}`);
    await service.stop('回滚后健康检查失败');
    await rollbackSwapDir(paths, swap, previousTag, { returnTo: previousDir });
    await service.ensureRunning();
    return { ok: false, state: 'health-failed', reason: health.reason, restored: true };
  }

  writeJson(paths.state, {
    ...state,
    tag: previousTag,
    installedAt: new Date().toISOString(),
    source: 'rollback',
    previous: current.tag ? { tag: current.tag } : undefined,
  });
  logger?.info?.(`[workbuddy] hub 已回滚到 ${previousTag}`);
  return { ok: true, state: 'rolled-back', health, local: localHubVersion(paths) };
}

/** 卸载 hub：停进程 + 删程序目录、历史版本与缓存，**保留 data/**（账号凭证、用量）。 */
export async function uninstallHub({ paths, service, logger } = {}) {
  if (!isHubDir(paths.current)) return { ok: false, state: 'not-installed', reason: 'hub 没有安装' };
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };

  const removed = [];
  for (const target of [paths.current, paths.versions, paths.cache, paths.state]) {
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      removed.push(target.replace(paths.plugin.root, '.'));
    } catch (error) {
      logger?.warn?.(`[workbuddy] 删除 ${target} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger?.info?.('[workbuddy] hub 已卸载（hub/data/ 保留）');
  return { ok: true, state: 'uninstalled', removed, kept: ['hub/data/', 'logs/'] };
}

/** 彻底卸载：与 wb2api 相同，清插件整体的数据根（两种网关的程序与数据一起）。 */
export function purgeHubData({ paths, service, logger, env = process.env } = {}) {
  return purgeBackendData({ paths: paths.plugin, service, logger, env });
}

/**
 * hub 的网关密钥（传给 hub 的 API_KEY，也是插件拉 /v1/models 用的那个）。
 *
 * 优先沿用已有的：插件配置 apiKey → 环境变量 WORKBUDDY_PROXY_KEY → wb2api config.json 的 api_key
 * （DSH 凭据库里的 WORKBUDDY_PROXY_KEY 通常就是它，沿用它切换网关后 DSH 不用改密钥）→
 * 插件上次生成并存下的 hub/data/plugin-api-key。都没有返回空串，由启动钩子生成（见 hubKeyHooks）。
 * 本函数只读不写：配置解析会频繁调用，不能有副作用。
 */
export function readHubApiKey({ explicit = '', env = process.env, wb2apiKey = '', paths } = {}) {
  if (explicit) return explicit;
  const fromEnv = typeof env?.WORKBUDDY_PROXY_KEY === 'string' ? env.WORKBUDDY_PROXY_KEY.trim() : '';
  if (fromEnv) return fromEnv;
  if (wb2apiKey) return wb2apiKey;
  try {
    return readFileSync(paths.apiKeyFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * hub 的启动钩子：没有可沿用的密钥时生成一个并存下，同时填进子进程环境与模型同步配置。
 * 不能让 hub 无密钥运行：hub 没设密钥时 /v1/* 对本机任何进程开放。
 */
export function hubKeyHooks(resolved, logger, name = 'dsh-autostart-workbuddy') {
  return {
    beforeSpawn() {
      if (resolved.spec?.env?.API_KEY) return;
      const paths = resolved.backend?.paths;
      if (!paths?.apiKeyFile) return;
      const key = `sk-${randomBytes(18).toString('base64url')}`;
      mkdirSync(paths.data, { recursive: true });
      writeFileSync(paths.apiKeyFile, `${key}\n`, { mode: 0o600 });
      resolved.spec.env.API_KEY = key;
      resolved.models = { ...resolved.models, apiKey: key };
      logger.info(`[${name}] 已为 hub 生成网关密钥（存于 ${paths.apiKeyFile}）`);
    },
  };
}
