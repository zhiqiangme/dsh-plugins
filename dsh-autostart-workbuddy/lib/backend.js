/**
 * 后端（wb2api.exe）的安装位置、版本识别，以及更新 / 回滚。
 *
 * 为什么要有这一层：wb2api 是个单文件二进制，但它的**版本身份只能从二进制里读**
 * （Go buildinfo 的 `vcs.revision`）——它没有 PE 版本号，`/healthz` 也不报版本。
 * 所以"是否最新"要靠 revision 与 release tag 的 commit 比对。
 *
 * 目录布局刻意放在 DSH home 下、且**程序与数据分离**：
 *
 *   <root>/backend/current/   正在用的 wb2api.exe + config.json + installed.json
 *   <root>/backend/versions/  历史版本（回滚用，只放 exe）
 *   <root>/data/              账号凭证与状态（auths/、state.json…）——切版本不碰它
 *   <root>/cache/             下载的 release 包与查询缓存
 *
 * 不放进插件安装目录（profile 的 node_modules）是因为那是 pnpm 管的拷贝，重装即丢；
 * 不放进仓库是因为仓库不该塞 8MB 二进制、更新也不该往源码树里写。
 *
 * 只依赖 node: 内置模块。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

import {
  downloadAsset,
  fetchChecksums,
  fetchLatestRelease,
  pickWindowsAsset,
  verifyChecksum,
} from './release.js';
import { isFile, probeTcp, resolveDshHome } from './services.js';
import { extractZipEntry } from './zip.js';

/** release 包里我们要的那个文件。 */
export const EXE_ENTRY = 'wb2api.exe';

/** 默认检查间隔：6 小时。匿名 GitHub API 只有 60 次/小时，没必要每次开面板都问。 */
export const DEFAULT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认保留的历史版本数。 */
export const DEFAULT_KEEP_VERSIONS = 3;

/**
 * 目录布局。`DSH_WORKBUDDY_BACKEND_ROOT` 可整体改根目录（测试与多环境用）。
 */
export function backendPaths(env = process.env) {
  const explicit = typeof env?.DSH_WORKBUDDY_BACKEND_ROOT === 'string' ? env.DSH_WORKBUDDY_BACKEND_ROOT.trim() : '';
  const root = explicit ? resolve(explicit) : join(resolveDshHome(env), 'autostart-workbuddy');
  return {
    root,
    backend: join(root, 'backend'),
    current: join(root, 'backend', 'current'),
    versions: join(root, 'backend', 'versions'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    logs: join(root, 'logs'),
    exe: join(root, 'backend', 'current', EXE_ENTRY),
    config: join(root, 'backend', 'current', 'config.json'),
    manifest: join(root, 'backend', 'current', 'installed.json'),
    releaseCache: join(root, 'cache', 'release.json'),
  };
}

export function ensureLayout(paths) {
  for (const dir of [paths.current, paths.versions, paths.data, paths.cache, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 版本目录名：优先用 tag，没有 tag 就退回 commit 前 7 位。 */
export function versionDirName(tag, revision) {
  const safeTag = typeof tag === 'string' ? tag.trim().replace(/[^A-Za-z0-9._-]/g, '-') : '';
  if (safeTag) return safeTag;
  const safeRevision = typeof revision === 'string' ? revision.trim() : '';
  return safeRevision ? `unknown-${safeRevision.slice(0, 7)}` : 'unknown';
}

/**
 * 读 exe 里的 Go 构建信息。
 *
 * 注意正则要求**恰好 40 位** hex：第一次调研时用了宽松的 `[^\x00-\x1f]{0,40}`，
 * 结果把 revision 截掉最后一位，导致与 tag 的 commit 比对"不相等"。
 *
 * 8MB 的文件按 mtime+size 缓存，避免每次开面板都重读。
 */
const buildInfoCache = new Map();

export function readBuildInfo(exePath) {
  if (!isFile(exePath)) return null;
  let stat;
  try {
    stat = statSync(exePath);
  } catch {
    return null;
  }
  const cached = buildInfoCache.get(exePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;

  const text = readFileSync(exePath).toString('latin1');
  const revision = /vcs\.revision=([0-9a-f]{40})/.exec(text)?.[1] ?? null;
  const info = revision
    ? {
        revision,
        builtAt: /vcs\.time=([0-9TZ:+\-.]{10,40})/.exec(text)?.[1] ?? null,
        modified: /vcs\.modified=(true|false)/.exec(text)?.[1] === 'true',
      }
    : null;

  buildInfoCache.set(exePath, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

/** 清掉构建信息缓存（换过 exe 之后调用，避免读到旧值）。 */
export function forgetBuildInfo(exePath) {
  buildInfoCache.delete(exePath);
}

export function readManifest(paths) {
  try {
    const parsed = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeManifest(paths, manifest) {
  mkdirSync(paths.current, { recursive: true });
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * 本地版本：以二进制里的 revision 为准（它才是"正在跑的东西"），
 * 清单只提供 tag 与来源。两者不一致说明 exe 被手动换过。
 */
export function localVersion(paths) {
  const info = readBuildInfo(paths.exe);
  const manifest = readManifest(paths);
  return {
    revision: info?.revision ?? null,
    builtAt: info?.builtAt ?? null,
    modified: info?.modified ?? false,
    tag: typeof manifest?.tag === 'string' ? manifest.tag : null,
    installedAt: typeof manifest?.installedAt === 'string' ? manifest.installedAt : null,
    /** true = 由本插件安装过（有清单）；false = 现场就有的二进制，未纳管 */
    managed: Boolean(manifest),
    /** true = 清单记录的 commit 与二进制实际 commit 不同（手动换过 exe） */
    drifted: Boolean(manifest?.commit && info?.revision && manifest.commit !== info.revision),
    previous: manifest?.previous ?? null,
  };
}

/** 不联网的状态快照：给面板首屏用。 */
export function describeBackend(paths) {
  return {
    root: paths.root,
    exe: paths.exe,
    config: paths.config,
    data: paths.data,
    exeExists: isFile(paths.exe),
    configExists: isFile(paths.config),
    version: localVersion(paths),
    history: listVersions(paths),
  };
}

/** 列出已归档的版本目录（新→旧）。 */
export function listVersions(paths) {
  if (!existsSync(paths.versions)) return [];
  try {
    return readdirSync(paths.versions)
      .map((name) => {
        const dir = join(paths.versions, name);
        const exe = join(dir, EXE_ENTRY);
        if (!isFile(exe)) return null;
        const stat = statSync(exe);
        return { name, dir, exe, size: stat.size, at: stat.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .map(({ at, ...rest }) => ({ ...rest, archivedAt: new Date(at).toISOString() }));
  } catch {
    return [];
  }
}

/** 健康探针：确认端口后面真的是 workbuddy2api，而不是恰好占了端口的别的进程。 */
export async function probeHealthz({ host = '127.0.0.1', port, timeoutMs = 5_000 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `/healthz 返回 ${response.status}` };
    const payload = await response.json();
    if (payload?.service !== 'workbuddy2api') return { ok: false, reason: `/healthz 的 service 不是 workbuddy2api` };
    return { ok: true, healthy: Number(payload.healthy) || 0, total: Number(payload.total) || 0 };
  } catch (error) {
    return { ok: false, reason: `探测 /healthz 失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function readReleaseCache(paths, ttlMs, force, now) {
  if (force) return undefined;
  try {
    const cached = JSON.parse(readFileSync(paths.releaseCache, 'utf8'));
    if (!cached?.fetchedAt || !cached?.latest?.tag) return undefined;
    const age = now - Date.parse(cached.fetchedAt);
    if (!Number.isFinite(age) || age > ttlMs) return undefined;
    return cached.latest;
  } catch {
    return undefined;
  }
}

function writeReleaseCache(paths, latest, now) {
  try {
    mkdirSync(paths.cache, { recursive: true });
    writeFileSync(paths.releaseCache, `${JSON.stringify({ fetchedAt: new Date(now).toISOString(), latest }, null, 2)}\n`);
  } catch {
    /* 缓存写不进去不影响功能，下次重新查即可 */
  }
}

/**
 * 检查更新（不装任何东西）。
 *
 * @param {{ paths: object, env?: object, apiBase?: string, ttlMs?: number, force?: boolean, now?: number }} options
 */
export async function checkForUpdate({
  paths,
  env = process.env,
  apiBase,
  ttlMs = DEFAULT_CHECK_TTL_MS,
  force = false,
  now = Date.now(),
} = {}) {
  const local = localVersion(paths);
  let latest = readReleaseCache(paths, ttlMs, force, now);
  let fromCache = Boolean(latest);
  if (!latest) {
    latest = await fetchLatestRelease({ env, apiBase });
    writeReleaseCache(paths, latest, now);
    fromCache = false;
  }
  const upToDate = Boolean(local.revision) && local.revision === latest.commit;
  return { local, latest, fromCache, upToDate, updateAvailable: !upToDate };
}

/** 跨目录移动文件；同一卷用 rename，跨卷退回复制+删除。 */
function moveFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/**
 * 把新 exe 换上去：旧版本归档到 versions/<旧版本>/，新文件落到 current/。
 * config.json 原地不动——更新永远不碰配置。
 */
export function swapIn(paths, stagedExe, { from, to }) {
  ensureLayout(paths);
  const archiveDir = join(paths.versions, versionDirName(from?.tag, from?.revision));
  const archivedExe = join(archiveDir, EXE_ENTRY);
  const hadCurrent = isFile(paths.exe);

  if (hadCurrent) moveFile(paths.exe, archivedExe);
  try {
    moveFile(stagedExe, paths.exe);
  } catch (error) {
    // 新文件没落上去就把旧的还回来，别留一个没有 exe 的 current
    if (hadCurrent && !isFile(paths.exe) && isFile(archivedExe)) moveFile(archivedExe, paths.exe);
    throw error;
  }
  forgetBuildInfo(paths.exe);
  return { archiveDir, archivedExe, hadCurrent, archivedVersion: versionDirName(from?.tag, from?.revision) };
}

/** 回滚刚才那次切换：把新版本挪去 -failed 目录，旧版本挪回来。 */
export function rollbackSwap(paths, swap, to) {
  if (isFile(paths.exe)) {
    const failedDir = join(paths.versions, `${versionDirName(to?.tag, to?.commit)}-failed`);
    try {
      moveFile(paths.exe, join(failedDir, EXE_ENTRY));
    } catch {
      /* 挪不动就删掉，避免留下一个半吊子的 current */
      rmSync(paths.exe, { force: true });
    }
  }
  if (swap?.hadCurrent && isFile(swap.archivedExe)) moveFile(swap.archivedExe, paths.exe);
  forgetBuildInfo(paths.exe);
}

/** 只保留最近 N 个历史版本（失败的 -failed 目录一并计入清理）。 */
export function pruneVersions(paths, keep = DEFAULT_KEEP_VERSIONS) {
  if (keep <= 0) return [];
  const removed = [];
  for (const item of listVersions(paths).slice(keep)) {
    try {
      rmSync(item.dir, { recursive: true, force: true });
      removed.push(item.name);
    } catch {
      /* 删不掉就算了：留着不影响功能 */
    }
  }
  return removed;
}

/**
 * 停掉正在运行的后端，准备替换文件。
 *
 * Windows 下运行中的 exe 被锁，必须先停。**只停本插件自己拉起的进程**：
 * 端口上如果是用户手动起的实例，拒绝更新并给出明确指引，绝不误杀。
 */
async function stopForUpdate(service, logger) {
  if (!service) return { ok: false, reason: '没有可用的托管实例，无法安全重启后端' };

  const host = service.spec?.host ?? '127.0.0.1';
  const port = service.port;
  const listening = await probeTcp(port, host);
  if (!listening) return { ok: true, stopped: false };

  const result = await service.stop('更新后端');
  if (result?.stopped) return { ok: true, stopped: true };

  const stillListening = await probeTcp(port, host);
  if (!stillListening) return { ok: true, stopped: false };

  logger?.warn?.(`[workbuddy] ${host}:${port} 上的进程不是本插件拉起的，拒绝更新`);
  return {
    ok: false,
    reason: `${host}:${port} 上的后端不是本插件拉起的（可能是你手动启动的）。请先停止它再更新。`,
  };
}

/**
 * 执行更新：下载 → 校验 → 解压 → 落地校验 → 停服 → 切换 → 起服 → 健康检查（失败回滚）。
 *
 * @param {{ paths: object, env?: object, apiBase?: string, service?: object, logger?: object,
 *           keepVersions?: number, target?: object }} options
 */
export async function applyUpdate({
  paths,
  env = process.env,
  apiBase,
  service,
  logger,
  keepVersions = DEFAULT_KEEP_VERSIONS,
  target,
} = {}) {
  const latest = target ?? (await fetchLatestRelease({ env, apiBase }));
  const local = localVersion(paths);
  if (local.revision && local.revision === latest.commit) {
    return { ok: true, state: 'up-to-date', local, latest };
  }

  const asset = pickWindowsAsset(latest.assets);
  logger?.info?.(`[workbuddy] 下载 ${asset.name} …`);
  const archive = await downloadAsset(asset, { env });
  const checksums = await fetchChecksums(latest, { env, apiBase });
  const verified = verifyChecksum(archive, asset.name, checksums);
  if (!verified.ok) return { ok: false, state: 'verify-failed', reason: verified.reason, latest, asset: asset.name };

  let exeBuffer;
  try {
    exeBuffer = extractZipEntry(archive, EXE_ENTRY);
  } catch (error) {
    return { ok: false, state: 'extract-failed', reason: error instanceof Error ? error.message : String(error), latest };
  }

  ensureLayout(paths);
  const stagedExe = join(paths.cache, `staged-${versionDirName(latest.tag, latest.commit)}.exe`);
  writeFileSync(stagedExe, exeBuffer);

  // 落地校验：包里的 exe 必须自称是目标 commit，否则说明资产与 tag 对不上
  const stagedInfo = readBuildInfo(stagedExe);
  if (!stagedInfo) {
    return { ok: false, state: 'binary-unknown', reason: '下载到的 exe 里读不到构建信息，拒绝安装', latest };
  }
  if (latest.commit && stagedInfo.revision !== latest.commit) {
    return {
      ok: false,
      state: 'binary-mismatch',
      reason: `包内 exe 的 revision（${stagedInfo.revision.slice(0, 7)}）与 release 的 commit（${latest.commit.slice(0, 7)}）不一致`,
      latest,
    };
  }

  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason, latest };

  const swap = swapIn(paths, stagedExe, { from: local, to: latest });

  const started = await service.ensureRunning();
  const health = started?.state === 'failed'
    ? { ok: false, reason: started.reason ?? '启动失败' }
    : await probeHealthz({ host: service.spec?.host ?? '127.0.0.1', port: service.port });

  if (!health.ok) {
    logger?.error?.(`[workbuddy] 新版本启动后健康检查失败，回滚：${health.reason}`);
    rollbackSwap(paths, swap, latest);
    const restored = await service.ensureRunning();
    return {
      ok: false,
      state: 'health-failed',
      reason: health.reason,
      rolledBack: true,
      restored: restored?.state,
      latest,
      local: localVersion(paths),
    };
  }

  writeManifest(paths, {
    tag: latest.tag,
    commit: latest.commit,
    asset: asset.name,
    sha256: verified.actual,
    installedAt: new Date().toISOString(),
    source: 'github-release',
    previous: local.revision ? { tag: local.tag, revision: local.revision } : undefined,
  });
  const pruned = pruneVersions(paths, keepVersions);
  logger?.info?.(`[workbuddy] 后端已更新到 ${latest.tag}（${latest.commit.slice(0, 7)}）`);

  return { ok: true, state: 'updated', latest, health, pruned, local: localVersion(paths) };
}

/** 回滚到清单里记录的上一版本。 */
export async function rollbackBackend({ paths, service, logger } = {}) {
  const manifest = readManifest(paths);
  const previous = manifest?.previous;
  if (!previous?.revision) {
    return { ok: false, state: 'no-previous', reason: '没有记录上一版本（installed.json 里没有 previous）' };
  }

  const dirName = versionDirName(previous.tag, previous.revision);
  const previousExe = join(paths.versions, dirName, EXE_ENTRY);
  if (!isFile(previousExe)) {
    return { ok: false, state: 'missing', reason: `找不到上一版本文件：${previousExe}` };
  }

  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };

  const current = localVersion(paths);
  const swap = swapIn(paths, previousExe, { from: current, to: previous });

  const started = await service.ensureRunning();
  const health = started?.state === 'failed'
    ? { ok: false, reason: started.reason ?? '启动失败' }
    : await probeHealthz({ host: service.spec?.host ?? '127.0.0.1', port: service.port });

  if (!health.ok) {
    logger?.error?.(`[workbuddy] 回滚后健康检查失败：${health.reason}`);
    rollbackSwap(paths, swap, previous);
    await service.ensureRunning();
    return { ok: false, state: 'health-failed', reason: health.reason, restored: true };
  }

  writeManifest(paths, {
    ...manifest,
    tag: previous.tag ?? null,
    commit: previous.revision,
    installedAt: new Date().toISOString(),
    source: 'rollback',
    previous: current.revision ? { tag: current.tag, revision: current.revision } : undefined,
  });
  logger?.info?.(`[workbuddy] 后端已回滚到 ${previous.tag ?? previous.revision.slice(0, 7)}`);
  return { ok: true, state: 'rolled-back', health, local: localVersion(paths) };
}

/**
 * 纳管现场已有的二进制：把当前 exe 的版本信息写进清单。
 *
 * 迁移（把后端搬到用户目录）和"手动换过 exe 之后"都用它，
 * 这样面板上显示的就是真实版本，而不是"未知"。
 */
export function adoptCurrentBinary(paths, { tag = null, source = 'adopted', previous } = {}) {
  const info = readBuildInfo(paths.exe);
  if (!info) return { ok: false, reason: '当前 exe 读不到构建信息' };
  writeManifest(paths, {
    tag,
    commit: info.revision,
    asset: null,
    sha256: null,
    installedAt: new Date().toISOString(),
    source,
    previous,
  });
  return { ok: true, version: localVersion(paths) };
}
