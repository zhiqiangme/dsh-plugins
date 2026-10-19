/**
 * opencode2api 的后端安装、版本识别、SHA256 校验、健康检查和失败回滚。
 * 程序与配置位于 DSH home，独立于 npm 安装目录；更新不覆盖用户凭据与状态。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute, parse } from 'node:path';

import {
  downloadAsset,
  fetchChecksums,
  fetchLatestRelease,
  pickWindowsAsset,
  verifyChecksum,
} from './release.js';
import { isFile, probeTcp, resolveDshHome } from './services.js';
import { extractZipEntry } from './zip.js';
import { ensureBackendConfig } from './backend-config.js';

/** release 包里我们要的那个文件。 */
export const EXE_ENTRY = 'opencode2api.exe';

/** 默认检查间隔：6 小时。匿名 GitHub API 只有 60 次/小时，没必要每次开面板都问。 */
export const DEFAULT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认保留的历史版本数。 */
export const DEFAULT_KEEP_VERSIONS = 3;

/** 更新失败时新包被挪去的目录后缀（见 rollbackSwap）；这些目录只留作排查，不能回滚。 */
const FAILED_SUFFIX = '-failed';

/**
 * 目录布局。`DSH_OPENCODE2API_BACKEND_ROOT` 可整体改根目录（测试与多环境用）。
 */
export function backendPaths(env = process.env) {
  const explicit = typeof env?.DSH_OPENCODE2API_BACKEND_ROOT === 'string' ? env.DSH_OPENCODE2API_BACKEND_ROOT.trim() : '';
  // 包名已去掉 autostart，数据目录沿用首版位置，避免重装后丢失后端配置和管理密码。
  const root = explicit ? resolve(explicit) : join(resolveDshHome(env), 'autostart-opencode2api');
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
    // 面板据此决定是否显示「彻底卸载」：目录都不在时没东西可清。
    rootExists: existsSync(paths.root),
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

/**
 * 健康响应同时包含版本、目录、密钥与代理摘要，不依赖不存在的 service 字段。
 * 503 可能仅表示目录尚未加载：保留管理页供用户配置，servable 单独反映就绪状态。
 */
export async function probeHealthz({ host = '127.0.0.1', port, timeoutMs = 5_000 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok && response.status !== 503) return { ok: false, reason: `/healthz 返回 ${response.status}` };
    const payload = await response.json().catch(() => null);
    // 上游不返回 service 字段；版本、目录和密钥摘要是它的健康接口契约。
    if (typeof payload?.version !== 'string' || typeof payload?.ready !== 'boolean' ||
        !payload?.models || !payload?.keys || !payload?.proxies) {
      return {
        ok: false,
        reason: `/healthz 返回 ${response.status}，响应不符合 opencode2api 健康接口`,
      };
    }
    return {
      ok: true,
      servable: payload.ready,
      version: payload.version,
      healthy: Number(payload.proxies.healthy) || 0,
      total: Number(payload.models.exposed) || 0,
    };
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
  // 数据根目录不在（从没装过，或刚被「彻底卸载」删掉）就不写：查更新是联网的慢操作，
  // 启动时那次检查晚于清除才返回的话，会凭空把 cache/ 建回来。首次安装由 ensureLayout 建目录。
  if (!existsSync(paths.root)) return;
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

/**
 * 撤销刚才那次切换：换上去的版本挪走，原来的版本挪回 current。
 *
 * 换上去的版本挪去哪由来源决定：
 *   - 更新（新下载的包）：挪去 `<版本>-failed`，留作排查，不会再被当成可回滚的版本；
 *   - 回滚（`returnTo` = 它原本在 versions/ 里的位置）：原样放回去。健康检查失败可能只是
 *     端口起得慢、上游一时不通，放进 -failed 会让 installed.json 的 previous 指向一个空目录，
 *     一次偶发失败就永久丢掉回滚能力。
 */
export function rollbackSwap(paths, swap, to, { returnTo } = {}) {
  if (isFile(paths.exe)) {
    const target = returnTo ?? join(paths.versions, `${versionDirName(to?.tag, to?.commit)}${FAILED_SUFFIX}`, EXE_ENTRY);
    try {
      moveFile(paths.exe, target);
    } catch {
      /* 挪不动就删掉，避免留下一个半吊子的 current */
      rmSync(paths.exe, { force: true });
    }
  }
  if (swap?.hadCurrent && isFile(swap.archivedExe)) moveFile(swap.archivedExe, paths.exe);
  forgetBuildInfo(paths.exe);
}

/**
 * 只保留 N 个可回滚的历史版本；只在更新成功后调用。
 *
 * listVersions 按 exe 的修改时间排序，而换文件用 rename，修改时间是当初下载的时间，不是归档时间：
 * 回滚过再更新时，installed.json 里的上一版本未必排在最前。所以上一版本无条件保留并占一个名额，
 * 其余按时间补足。-failed 不占名额：更新已经成功，之前失败的包没有排查价值，一并清掉；
 * 否则几次失败就能把真正的回滚目标挤出去。
 */
export function pruneVersions(paths, keep = DEFAULT_KEEP_VERSIONS) {
  if (keep <= 0) return [];
  const previous = readManifest(paths)?.previous;
  const previousName = previous?.revision ? versionDirName(previous.tag, previous.revision) : null;
  const all = listVersions(paths);
  const kept = new Set(all.some((item) => item.name === previousName) ? [previousName] : []);
  for (const item of all) {
    if (kept.size >= keep) break;
    if (!item.name.endsWith(FAILED_SUFFIX)) kept.add(item.name);
  }
  const removed = [];
  for (const item of all.filter((entry) => !kept.has(entry.name))) {
    try {
      assertManagedPath(paths, item.dir);
      rmSync(item.dir, { recursive: true, force: true });
      removed.push(item.name);
    } catch {
      /* 删不掉就算了：留着不影响功能 */
    }
  }
  return removed;
}

/** 清理只能落在本插件数据根目录内，不能删除根本身或调用者传入的外部路径。 */
function assertManagedPath(paths, target) {
  const inside = relative(resolve(paths.root), resolve(target));
  if (!inside || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) {
    throw new Error('拒绝清理后端数据根目录以外的路径');
  }
}

/**
 * 停掉正在运行的后端，准备替换文件。
 *
 * Windows 下运行中的 exe 被锁，必须先停。**只停本插件自己拉起的进程**：
 * 端口上如果是用户手动起的实例，拒绝更新并给出明确指引，绝不误杀。
 */
export async function stopForUpdate(service, logger) {
  if (!service) return { ok: false, reason: '没有可用的托管实例，无法安全重启后端' };

  const host = service.spec?.host ?? '127.0.0.1';
  const port = service.port;
  const listening = await probeTcp(port, host);
  // Tiara 可能还在预热 OpenCode，此时 API 尚未监听也必须先停掉自己的进程树。
  if (!listening && !service.isAlive?.()) return { ok: true, stopped: false };

  const result = await service.stop('更新后端');
  if (result?.stopped) return { ok: true, stopped: true };

  const stillListening = await probeTcp(port, host);
  if (!stillListening) return { ok: true, stopped: false };

  logger?.warn?.(`[opencode2api] ${host}:${port} 上的进程不是本插件拉起的，拒绝更新`);
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
  logger?.info?.(`[opencode2api] 下载 ${asset.name} …`);
  const archive = await downloadAsset(asset, { env });
  const checksums = await fetchChecksums(latest, { env, apiBase, assetName: asset.name });
  const verified = verifyChecksum(archive, asset.name, checksums);
  if (!verified.ok) return { ok: false, state: 'verify-failed', reason: verified.reason, latest, asset: asset.name };

  let exeBuffer;
  try {
    // 正式 ZIP 多套一层同名目录；只读取目标 exe，不把归档路径写到磁盘。
    try { exeBuffer = extractZipEntry(archive, `${asset.name.slice(0, -4)}/${EXE_ENTRY}`); }
    catch { exeBuffer = extractZipEntry(archive, EXE_ENTRY); }
  } catch (error) {
    return { ok: false, state: 'extract-failed', reason: error instanceof Error ? error.message : String(error), latest };
  }

  ensureLayout(paths);
  const stagedExe = join(paths.cache, `staged-${versionDirName(latest.tag, latest.commit)}.exe`);
  writeFileSync(stagedExe, exeBuffer);
  // 暂存文件只在换上去时被挪走；之前任何一步拒绝安装，都把它删掉，不在 cache/ 里留一个未通过校验的 exe。
  const discardStaged = (result) => {
    rmSync(stagedExe, { force: true });
    forgetBuildInfo(stagedExe);
    return result;
  };

  // 落地校验：包里的 exe 必须自称是目标 commit，否则说明资产与 tag 对不上
  const stagedInfo = readBuildInfo(stagedExe);
  if (!stagedInfo) {
    return discardStaged({ ok: false, state: 'binary-unknown', reason: '下载到的 exe 里读不到构建信息，拒绝安装', latest });
  }
  if (latest.commit && stagedInfo.revision !== latest.commit) {
    return discardStaged({
      ok: false,
      state: 'binary-mismatch',
      reason: `包内 exe 的 revision（${stagedInfo.revision.slice(0, 7)}）与 release 的 commit（${latest.commit.slice(0, 7)}）不一致`,
      latest,
    });
  }

  ensureBackendConfig(paths, service.spec);
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return discardStaged({ ok: false, state: 'not-owned', reason: stop.reason, latest });

  const swap = swapIn(paths, stagedExe, { from: local, to: latest });

  const started = await service.ensureRunning();
  const health = started?.state === 'failed'
    ? { ok: false, reason: started.reason ?? '启动失败' }
    : await probeHealthz({ host: service.spec?.host ?? '127.0.0.1', port: service.port });

  if (!health.ok) {
    logger?.error?.(`[opencode2api] 新版本启动后健康检查失败，回滚：${health.reason}`);
    // 先停掉刚拉起的新进程再挪文件：Windows 允许给运行中的 exe 改名，不停的话它会
    // 在 -failed 目录里继续跑着占住端口，下面 ensureRunning 就会把它当成"已在运行"。
    await service.stop('健康检查失败，回滚');
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
  logger?.info?.(`[opencode2api] 后端已更新到 ${latest.tag}（${latest.commit.slice(0, 7)}）`);
  if (health.servable === false) logger?.info?.('[opencode2api] 模型目录尚未就绪，请在后端管理页检查上游配置与连接状态');

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
    logger?.error?.(`[opencode2api] 回滚后健康检查失败：${health.reason}`);
    await service.stop('回滚后健康检查失败'); // 同 applyUpdate：先停进程再挪文件
    rollbackSwap(paths, swap, previous, { returnTo: previousExe });
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
  logger?.info?.(`[opencode2api] 后端已回滚到 ${previous.tag ?? previous.revision.slice(0, 7)}`);
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

/**
 * 安装后端：只在"当前没有 exe"时允许。
 *
 * 已经装了就拒绝——那应该走更新。允许"安装"覆盖会让人以为能装成任意版本，
 * 而版本只能来自 release（见 release.js）。
 */
export async function installBackend({ paths, env = process.env, apiBase, service, logger, target, keepVersions } = {}) {
  if (isFile(paths.exe)) {
    return { ok: false, state: 'already-installed', reason: '后端已安装；升级请用「更新」' };
  }
  const result = await applyUpdate({ paths, env, apiBase, service, logger, target, keepVersions });
  if (!result.ok) return result;
  return { ...result, state: 'installed' };
}

/**
 * 卸载后端：停进程 + 删程序文件，**保留 `config.json` 与 `data/`**。
 *
 * 保留凭证是刻意的：卸载后端不该顺带把账号删掉（`data/auths` 里是明文 token）。
 * 要连数据一起清，请自己删 `data/`。
 */
export async function uninstallBackend({ paths, service, logger, alsoCache = true } = {}) {
  if (!isFile(paths.exe)) {
    return { ok: false, state: 'not-installed', reason: '后端没有安装' };
  }

  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };

  const removed = [];
  const remove = (target, { keepDir = false } = {}) => {
    assertManagedPath(paths, target);
    if (!existsSync(target)) return;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
      if (keepDir) mkdirSync(target, { recursive: true });
    } catch (error) {
      logger?.warn?.(`[opencode2api] 删除 ${target} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  remove(paths.exe);
  remove(paths.manifest);
  remove(paths.versions, { keepDir: true });
  if (alsoCache) remove(paths.cache, { keepDir: true });
  forgetBuildInfo(paths.exe);

  logger?.info?.('[opencode2api] 后端已卸载（config.json 与 data/ 保留）');
  return {
    ok: true,
    state: 'uninstalled',
    removed: removed.map((item) => item.replace(paths.root, '.')),
    kept: ['backend/current/config.json', 'data/', 'logs/'],
  };
}

/**
 * 清除后端数据：停掉本插件拉起的后端，再整个删掉数据根目录（程序、历史版本、config.json、
 * data/ 里的凭证、缓存、日志）。
 *
 * 为什么要用户手动点：DSH 卸载插件时不通知插件（dshmarket 与 dsh CLI 都只跑 pnpm remove，
 * pnpm 也不执行 preuninstall），插件的 dispose 又分不清"卸载"与"停用 / 重启 / 更新"，
 * 在那里自动删会在更新插件时误删已装好的后端。所以只给一个显式入口，卸载插件前点一下。
 */
export async function purgeBackendData({ paths, service, logger, env = process.env } = {}) {
  assertPurgeableRoot(paths.root, env);
  if (!existsSync(paths.root)) {
    return { ok: true, state: 'nothing-to-purge', root: paths.root };
  }

  // 与卸载同一道关：端口上是别人起的进程就拒绝，什么都不删（它可能正用着这个目录）。
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };

  try {
    // Windows 上进程刚退出时 exe 与日志句柄可能还没释放，rmSync 自带的重试能跨过这段窗口
    // （10 次 × 200ms ≈ 2s，够一个正常退出的 Go 进程释放文件）。
    rmSync(paths.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[opencode2api] 清除 ${paths.root} 失败：${reason}`);
    return { ok: false, state: 'failed', reason: `清除 ${paths.root} 失败：${reason}`, root: paths.root };
  }
  forgetBuildInfo(paths.exe);

  logger?.info?.(`[opencode2api] 已清除后端数据目录 ${paths.root}`);
  return { ok: true, state: 'purged', root: paths.root };
}

/**
 * 整目录删除前的兜底：根目录可被 DSH_OPENCODE2API_BACKEND_ROOT 改到任意位置，
 * 配错成盘符根、用户目录或 DSH home（或它们的上级）时，删下去就是灾难，直接拒绝。
 */
function assertPurgeableRoot(root, env) {
  const fold = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  const target = fold(root);
  const guarded = [parse(resolve(root)).root, homedir(), resolveDshHome(env)].map(fold);
  // target 等于或包含任一受保护目录 → 拒绝。
  const covers = (dir) => {
    const inside = relative(target, dir);
    return !inside.startsWith('..') && !isAbsolute(inside);
  };
  if (guarded.some(covers)) {
    throw new Error(`拒绝清除 ${root}：它是（或包含）盘符根、用户目录或 DSH home`);
  }
}
