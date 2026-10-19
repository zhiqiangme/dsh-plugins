/**
 * 后端（wb2api.exe）的安装位置、版本识别，以及更新 / 回滚。
 *
 * 为什么要有这一层：wb2api 是个单文件二进制，但它的**版本身份只能从二进制里读**
 * （Go buildinfo 的 `vcs.revision`）——它没有 PE 版本号，`/healthz` 也不报版本。
 * 所以"是否最新"要靠 revision 与 release tag 的 commit 比对。
 *
 * 目录布局刻意放在 DSH home 下、且**程序与数据分离**；wb2api 与 hub 各占一个子目录：
 *
 *   <root>/wb2api/backend/current/   正在用的 wb2api.exe + config.json + installed.json
 *   <root>/wb2api/backend/versions/  历史版本（回滚用，只放 exe）
 *   <root>/wb2api/data/              账号凭证与状态（auths/、state.json…）——切版本不碰它
 *   <root>/wb2api/cache/             下载的 release 包与查询缓存
 *   <root>/hub/                      hub 的同一套布局（见 hub.js）
 *   <root>/logs/                     两种网关共用的日志
 *
 * 老版本插件把 wb2api 的三个目录直接放在 <root> 下，启动时由 migrateLegacyLayout 挪进 wb2api/。
 *
 * 不放进插件安装目录（profile 的 node_modules）是因为那是 pnpm 管的拷贝，重装即丢；
 * 不放进仓库是因为仓库不该塞 8MB 二进制、更新也不该往源码树里写。
 *
 * 只依赖 node: 内置模块。
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

/** release 包里我们要的那个文件。 */
export const EXE_ENTRY = 'wb2api.exe';

/** 默认检查间隔：6 小时。匿名 GitHub API 只有 60 次/小时，没必要每次开面板都问。 */
export const DEFAULT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认保留的历史版本数。 */
export const DEFAULT_KEEP_VERSIONS = 3;

/** 更新失败时新包被挪去的目录后缀（见 rollbackSwap）；这些目录只留作排查，不能回滚。 */
const FAILED_SUFFIX = '-failed';

/** wb2api 在插件数据根下的子目录名（与 hub/ 并列）。 */
export const WB2API_DIR = 'wb2api';

/** 老布局里直接放在插件数据根下、属于 wb2api 的目录。 */
const LEGACY_DIRS = ['backend', 'data', 'cache'];

function pluginRoot(env) {
  const explicit = typeof env?.DSH_WORKBUDDY_BACKEND_ROOT === 'string' ? env.DSH_WORKBUDDY_BACKEND_ROOT.trim() : '';
  return explicit ? resolve(explicit) : join(resolveDshHome(env), 'autostart-workbuddy');
}

/**
 * 目录布局。`DSH_WORKBUDDY_BACKEND_ROOT` 可整体改插件数据根（测试与多环境用）。
 *
 * `root` 是插件整体的数据根（彻底卸载删它、日志放它下面），`home` 是 wb2api 自己的目录。
 * 还没迁移的老安装（根下有 backend/、没有 wb2api/）仍按老位置用：迁移失败（例如旧 exe
 * 还被别的进程占着）时不至于看起来像没装、再装一份。
 */
export function backendPaths(env = process.env) {
  const root = pluginRoot(env);
  const legacy = !existsSync(join(root, WB2API_DIR)) && existsSync(join(root, 'backend'));
  const home = legacy ? root : join(root, WB2API_DIR);
  return {
    root,
    home,
    legacy,
    backend: join(home, 'backend'),
    current: join(home, 'backend', 'current'),
    versions: join(home, 'backend', 'versions'),
    data: join(home, 'data'),
    cache: join(home, 'cache'),
    logs: join(root, 'logs'),
    exe: join(home, 'backend', 'current', EXE_ENTRY),
    config: join(home, 'backend', 'current', 'config.json'),
    manifest: join(home, 'backend', 'current', 'installed.json'),
    releaseCache: join(home, 'cache', 'release.json'),
  };
}

/**
 * 把老布局（<root>/backend、data、cache）挪进 <root>/wb2api/，并改写 config.json 里
 * 指向老目录的绝对路径（auth_dir / state_file 常被写成绝对路径，不改的话 wb2api 会在
 * 老位置建空目录，账号"消失"）。
 *
 * 先挪进 wb2api.migrating/，全部挪完再一次改名成 wb2api/：中途失败就挪回原处，
 * backendPaths 照旧认老布局，下次启动再试。必须在 wb2api 启动前调用
 * （运行中的 exe 所在目录在 Windows 上挪不动）。
 *
 * @returns {{ state: 'none' | 'migrated' | 'failed', reason?: string, rewritten?: string[] }}
 */
export function migrateLegacyLayout(env = process.env, logger) {
  const root = pluginRoot(env);
  const target = join(root, WB2API_DIR);
  const staging = `${target}.migrating`;
  // 上次迁移被打断（进程被杀）留下的半成品：先把东西放回根下，再按老布局从头来。
  if (existsSync(staging) && !existsSync(target)) restoreStaging(root, staging);
  if (!backendPaths(env).legacy) return { state: 'none' };

  const config = rewriteLegacyConfig(join(root, 'backend', 'current', 'config.json'), root, target);
  try {
    mkdirSync(staging, { recursive: true });
    for (const name of LEGACY_DIRS) {
      if (existsSync(join(root, name))) renameSync(join(root, name), join(staging, name));
    }
    renameSync(staging, target);
  } catch (error) {
    restoreStaging(root, staging);
    const reason = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[workbuddy] wb2api 目录迁移到 ${target} 失败，本次仍用老位置：${reason}`);
    return { state: 'failed', reason };
  }

  if (config) {
    const path = join(target, 'backend', 'current', 'config.json');
    try {
      // 原子替换，权限与 wb2api 自己落盘的一致（里面有 api_key）。
      writeFileSync(`${path}.tmp`, config.text, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      // 目录已挪好、只是路径没改成：wb2api 会去老位置找账号，必须让用户知道去手改。
      const reason = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`[workbuddy] 已迁移到 ${target}，但改写 config.json 里的路径（${config.rewritten.join('、')}）失败：${reason}`);
      return { state: 'migrated', rewritten: [], reason };
    }
  }
  logger?.info?.(`[workbuddy] wb2api 的 backend/、data/、cache/ 已迁移到 ${target}`);
  return { state: 'migrated', rewritten: config?.rewritten ?? [] };
}

/** 把 staging 里的目录放回根下（根下已有同名的就不动，留给人工看），再删掉空的 staging。 */
function restoreStaging(root, staging) {
  for (const name of LEGACY_DIRS) {
    const from = join(staging, name);
    if (!existsSync(from) || existsSync(join(root, name))) continue;
    try {
      renameSync(from, join(root, name));
    } catch {
      /* 放不回去就留在 staging，下次启动再试 */
    }
  }
  try {
    // 只删空目录：放不回去的东西不能被顺手删掉。
    if (readdirSync(staging).length === 0) rmSync(staging, { recursive: true });
  } catch {
    /* ignore */
  }
}

/**
 * 算出迁移后的 config.json 文本：凡是落在老布局目录（<root>/backend|data|cache 下）的绝对路径，
 * 换成 <target> 下的同一相对位置。相对路径跟着 cwd（backend/current）一起走，不用改。
 * 读不到或没东西可改时返回 null；只改字符串值，其余内容原样保留。
 */
function rewriteLegacyConfig(path, root, target) {
  let config;
  try {
    // 记事本另存可能带 BOM，JSON.parse 不认。
    config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  // Windows 路径不分大小写，比较时统一折叠。
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = resolve(root);
  const rewritten = [];
  const walk = (node, trail) => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${trail}[${index}]`));
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, trail ? `${trail}.${key}` : key)]));
    }
    if (typeof node !== 'string' || !isAbsolute(node)) return node;
    const absolute = resolve(node);
    const inside = relative(fold(base), fold(absolute));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return node;
    if (!LEGACY_DIRS.includes(inside.split(/[\\/]/)[0])) return node;
    rewritten.push(trail);
    // 相对部分从原值截取，保留原来的大小写。
    return join(target, absolute.slice(base.length + 1));
  };
  const next = walk(config, '');
  if (rewritten.length === 0) return null;
  return { text: `${JSON.stringify(next, null, 2)}\n`, rewritten };
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
    /** 有清单却无法核对实际身份（含构建信息缺失）时，不能沿用旧 tag 自动覆盖用户的 exe。 */
    drifted: Boolean(manifest && (!manifest.commit || !info?.revision || manifest.commit !== info.revision)),
    /** 安装来源：github-release / auto-update / rollback / adopted；自动更新据此识别"用户回滚过"。 */
    source: typeof manifest?.source === 'string' ? manifest.source : null,
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
 * 健康探针：确认端口后面真的是 workbuddy2api，而不是恰好占了端口的别的进程。
 *
 * 上游 `/healthz` 是给负载均衡用的：账号池里没有"此刻能受理请求"的账号时返回 503，
 * 身份另由 `service` 字段 + `X-Service` 头表明。刚装好的后端一个账号都没有（账号要装好后
 * 在面板里登录），必然是 503——把它当失败就会回滚，用户永远装不上、也进不了面板登录。
 * 所以这里只看身份：503 且自称 workbuddy2api = 进程正常，只是暂无可用账号（servable=false）。
 */
export async function probeHealthz({ host = '127.0.0.1', port, timeoutMs = 5_000 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok && response.status !== 503) return { ok: false, reason: `/healthz 返回 ${response.status}` };
    const payload = await response.json().catch(() => null);
    if (payload?.service !== 'workbuddy2api') {
      return {
        ok: false,
        reason: response.ok ? '/healthz 的 service 不是 workbuddy2api' : `/healthz 返回 ${response.status}`,
      };
    }
    return {
      ok: true,
      servable: response.ok,
      healthy: Number(payload.healthy) || 0,
      total: Number(payload.total) || 0,
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
export async function stopForUpdate(service, logger) {
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
 * 落地校验：暂存的 exe 必须自称是目标 commit，否则说明资产与 tag 对不上（或暂存文件被换过）。
 * 不通过时返回失败结果，通过返回 undefined。
 */
function checkStagedExe(stagedExe, latest) {
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
  return undefined;
}

/**
 * 更新的前半段：下载 → 校验 → 解压到 cache/ 暂存 → 落地校验。不停服务、不碰 current/。
 *
 * 手动更新紧接着调 commitUpdate；自动更新（auto-update.js）在后台只做这一步，
 * 把暂存结果记下来，等下次 DSH 启动、后端还没起来时再换上。
 *
 * @returns 'up-to-date'；'prepared'（带 staged：暂存路径、资产名与包的 sha256）；
 *          或 ok:false 的校验失败——此时暂存文件已删掉，cache/ 里不留未通过校验的 exe。
 */
export async function prepareUpdate({ paths, env = process.env, apiBase, logger, target } = {}) {
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
  const rejected = checkStagedExe(stagedExe, latest);
  if (rejected) {
    rmSync(stagedExe, { force: true });
    forgetBuildInfo(stagedExe);
    return rejected;
  }
  return { ok: true, state: 'prepared', local, latest, staged: { path: stagedExe, asset: asset.name, sha256: verified.actual } };
}

/**
 * 更新的后半段：停服 → 切换 → 起服 → 健康检查（失败回滚）→ 写清单。
 *
 * 暂存的 exe 可能是上一次 DSH 运行时下载的（自动更新），换上之前再核对一次身份：
 * 文件在这期间被删、被截断或被换掉，都不该装上去。
 *
 * @param {{ paths: object, service?: object, logger?: object, keepVersions?: number,
 *           latest: { tag: string, commit?: string }, staged: { path: string, asset?: string, sha256?: string },
 *           keepStaged?: boolean, source?: string }} options
 *   keepStaged：端口上是别人起的进程、这次换不了时保留暂存文件（自动更新下次启动再试）；
 *   source：写进清单的安装来源，自动更新记 'auto-update'。
 */
export async function commitUpdate({
  paths,
  service,
  logger,
  keepVersions = DEFAULT_KEEP_VERSIONS,
  latest,
  staged,
  keepStaged = false,
  source = 'github-release',
} = {}) {
  const stagedExe = staged?.path;
  // 暂存文件只在换上去时被挪走；之前任何一步拒绝安装，都把它删掉，不在 cache/ 里留一个未通过校验的 exe。
  const discardStaged = (result) => {
    rmSync(stagedExe, { force: true });
    forgetBuildInfo(stagedExe);
    return result;
  };
  if (!isFile(stagedExe)) {
    return { ok: false, state: 'staged-missing', reason: `找不到暂存的新版本：${stagedExe ?? '(空)'}`, latest };
  }
  const rejected = checkStagedExe(stagedExe, latest);
  if (rejected) return discardStaged(rejected);

  const local = localVersion(paths);
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) {
    const refused = { ok: false, state: 'not-owned', reason: stop.reason, latest };
    return keepStaged ? refused : discardStaged(refused);
  }

  const swap = swapIn(paths, stagedExe, { from: local, to: latest });

  const started = await service.ensureRunning();
  const health = started?.state === 'failed'
    ? { ok: false, reason: started.reason ?? '启动失败' }
    : await probeHealthz({ host: service.spec?.host ?? '127.0.0.1', port: service.port });

  if (!health.ok) {
    logger?.error?.(`[workbuddy] 新版本启动后健康检查失败，回滚：${health.reason}`);
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
    asset: staged.asset ?? null,
    sha256: staged.sha256 ?? null,
    installedAt: new Date().toISOString(),
    source,
    previous: local.revision ? { tag: local.tag, revision: local.revision } : undefined,
  });
  const pruned = pruneVersions(paths, keepVersions);
  logger?.info?.(`[workbuddy] 后端已更新到 ${latest.tag}（${String(latest.commit ?? '').slice(0, 7)}）`);
  if (health.servable === false) logger?.info?.('[workbuddy] 后端暂无可用账号，请在后端面板登录 WorkBuddy 账号');

  return { ok: true, state: 'updated', latest, health, pruned, local: localVersion(paths) };
}

/**
 * 执行更新（面板「更新」/「安装」）：prepareUpdate 紧接 commitUpdate，
 * 即 下载 → 校验 → 解压 → 落地校验 → 停服 → 切换 → 起服 → 健康检查（失败回滚）。
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
  const prepared = await prepareUpdate({ paths, env, apiBase, logger, target });
  if (prepared.state !== 'prepared') return prepared;
  return commitUpdate({ paths, service, logger, keepVersions, latest: prepared.latest, staged: prepared.staged });
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
    if (!existsSync(target)) return;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
      if (keepDir) mkdirSync(target, { recursive: true });
    } catch (error) {
      logger?.warn?.(`[workbuddy] 删除 ${target} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  remove(paths.exe);
  remove(paths.manifest);
  remove(paths.versions, { keepDir: true });
  if (alsoCache) remove(paths.cache, { keepDir: true });
  forgetBuildInfo(paths.exe);

  logger?.info?.('[workbuddy] 后端已卸载（config.json 与 data/ 保留）');
  return {
    ok: true,
    state: 'uninstalled',
    removed: removed.map((item) => item.replace(paths.root, '.')),
    kept: [relative(paths.root, paths.config), `${relative(paths.root, paths.data)}/`, 'logs/'].map((item) => item.replace(/\\/g, '/')),
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
    logger?.warn?.(`[workbuddy] 清除 ${paths.root} 失败：${reason}`);
    return { ok: false, state: 'failed', reason: `清除 ${paths.root} 失败：${reason}`, root: paths.root };
  }
  forgetBuildInfo(paths.exe);

  logger?.info?.(`[workbuddy] 已清除后端数据目录 ${paths.root}`);
  return { ok: true, state: 'purged', root: paths.root };
}

/**
 * 整目录删除前的兜底：根目录可被 DSH_WORKBUDDY_BACKEND_ROOT 改到任意位置，
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
