/**
 * TiaraBasori/OpenCode2API：上游没有 release，按不可变 commit 下载源码并按 lockfile 装生产依赖。
 * Node 复用 DSH；npm 与 OpenCode 1.x 装在本插件目录，更新整目录、数据独立保留。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { backendPaths, DEFAULT_CHECK_TTL_MS, purgeBackendData, stopForUpdate } from './backend.js';
import { panelApiKey } from './models.js';
import { isFile } from './services.js';
import { extractZipEntry, extractZipTree } from './zip.js';

export const TIARA_REPO = 'TiaraBasori/OpenCode2API';
// 上游 SDK 与 1.x 协议绑定；自动装 latest 会拿到不兼容的 OpenCode 2.x。
export const OPENCODE_VERSION = '1.19.0';
export const NPM_VERSION = '10.9.4';
// 官方 v1.19.0 Release 的 asset.digest；版本与校验和一起固定，避免无校验执行下载的二进制。
const OPENCODE_ASSETS = Object.freeze({
  x64: { name: 'opencode-windows-x64.zip', sha256: '17108e9448c4fdad48eb8714c4ed6f5dfc9cf86c2eb8f2ce5d02043fef806eb5' },
  arm64: {
    name: 'opencode-windows-arm64.zip',
    sha256: 'cfb6f1d40c4596613d2d40e34c48500da7b873f98f7458d3d4ea11136bf174f6',
  },
});
const NPM_INTEGRITY = 'OnUG836FwboQIbqtefDNlyR0gTHzIfwRfE3DuiNewBvnMnWEpB0VEXwBlFVgqpNzIgYo/MHh3d2Hel/pszapAA==';
export const DEFAULT_TIARA_KEEP_VERSIONS = 2;
const MANIFEST = 'dsh-source.json';

export function tiaraPaths(env = process.env) {
  const plugin = backendPaths(env);
  const root = join(plugin.root, 'tiara');
  const current = join(root, 'backend', 'current');
  return {
    kind: 'tiara',
    plugin,
    root,
    current,
    backend: join(root, 'backend'),
    versions: join(root, 'backend', 'versions'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    logs: plugin.logs,
    exe: process.execPath,
    script: join(current, 'src', 'proxy.js'),
    config: join(root, 'data', 'config.json'),
    state: join(root, 'installed.json'),
    manifest: join(current, MANIFEST),
    releaseCache: join(root, 'cache', 'release.json'),
  };
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function layout(paths) {
  for (const dir of [paths.backend, paths.versions, paths.data, paths.cache]) mkdirSync(dir, { recursive: true });
}
function versionName(tag) {
  if (!/^main-[a-f0-9]{12,40}$/.test(tag ?? '')) throw new Error('Tiara 版本标识无效');
  return tag;
}
export function tiaraBinary(dir, arch = process.arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`不支持的 Windows 架构：${arch}`);
  return join(dir, 'runtime', 'opencode.exe');
}
export function isTiaraDir(dir) {
  return (
    isFile(join(dir, 'src', 'proxy.js')) &&
    isFile(join(dir, 'node_modules', 'express', 'package.json')) &&
    isFile(tiaraBinary(dir))
  );
}
export function localTiaraVersion(paths) {
  const manifest = readJson(paths.manifest),
    state = readJson(paths.state);
  return {
    tag: manifest?.tag ?? null,
    revision: manifest?.commit ?? null,
    builtAt: null,
    modified: false,
    managed: Boolean(state),
    installedAt: state?.installedAt ?? null,
    previous: state?.previous ?? null,
    version: manifest?.version ?? null,
    drifted: Boolean(state?.commit && state.commit !== manifest?.commit),
  };
}
export function listTiaraVersions(paths) {
  if (!existsSync(paths.versions)) return [];
  return readdirSync(paths.versions)
    .filter((name) => /^main-[a-f0-9]{12,40}$/.test(name) && isTiaraDir(join(paths.versions, name)))
    .map((name) => ({
      name,
      dir: join(paths.versions, name),
      archivedAt: statSync(join(paths.versions, name)).mtime.toISOString(),
    }))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
export function describeTiara(paths) {
  return {
    root: paths.plugin.root,
    rootExists: existsSync(paths.plugin.root),
    exe: paths.script,
    exeExists: isTiaraDir(paths.current),
    config: paths.config,
    configExists: isFile(paths.config),
    data: paths.data,
    version: localTiaraVersion(paths),
    history: listTiaraVersions(paths),
  };
}
export function ensureTiaraConfig(paths) {
  if (existsSync(paths.config)) {
    if (!readJson(paths.config)?.API_KEY || !readJson(paths.config)?.OPENCODE_SERVER_PASSWORD)
      throw new Error('Tiara config.json 缺少 API_KEY 或 OPENCODE_SERVER_PASSWORD，请补齐后再启动');
    return { created: false };
  }
  // 沿用原网关的本地密钥，切换后 DSH 的同名凭据仍然有效；上游 Zen key 不在这里迁移。
  writeJson(paths.config, {
    API_KEY: panelApiKey(paths.plugin.config) || `sk-${randomBytes(24).toString('base64url')}`,
    OPENCODE_SERVER_PASSWORD: randomBytes(24).toString('base64url'),
    DISABLE_TOOLS: true,
    WEB_PANEL_ENABLED: true,
    OMIT_SYSTEM_PROMPT: false,
  });
  return { created: true };
}

export async function probeTiaraHealth({ host = '127.0.0.1', port, timeoutMs = 5_000 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    if (!response.ok || body?.status !== 'ok' || body.proxy !== true)
      return { ok: false, reason: '/health 的应答不是 Tiara OpenCode2API' };
    return { ok: true, servable: true };
  } catch (error) {
    return { ok: false, reason: `探测 /health 失败：${error.message}` };
  }
}
function headers(env) {
  const token = env?.GITHUB_TOKEN || env?.GH_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-opencode2api',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
export async function fetchTiaraSource({ env = process.env, apiBase = 'https://api.github.com' } = {}) {
  const response = await fetch(`${apiBase}/repos/${TIARA_REPO}/commits/main`, {
    headers: headers(env),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`查询 Tiara 源码版本失败：HTTP ${response.status}`);
  const body = await response.json();
  if (!/^[a-f0-9]{40}$/.test(body?.sha ?? '')) throw new Error('GitHub 没有返回有效的 Tiara commit');
  return { tag: `main-${body.sha.slice(0, 12)}`, commit: body.sha, publishedAt: body.commit?.committer?.date ?? '' };
}
export async function checkTiaraUpdate({
  paths,
  env,
  apiBase,
  ttlMs = DEFAULT_CHECK_TTL_MS,
  force = false,
  now = Date.now(),
} = {}) {
  const cached = !force && readJson(paths.releaseCache);
  let latest = cached?.latest;
  const fromCache = Boolean(
    latest?.commit && now - Date.parse(cached.fetchedAt) >= 0 && now - Date.parse(cached.fetchedAt) <= ttlMs,
  );
  if (!fromCache) latest = await fetchTiaraSource({ env, apiBase });
  if (!fromCache && existsSync(paths.root))
    writeJson(paths.releaseCache, { fetchedAt: new Date(now).toISOString(), latest });
  const local = localTiaraVersion(paths),
    upToDate = local.revision === latest.commit && isTiaraDir(paths.current);
  return { local, latest, fromCache, upToDate, updateAvailable: !upToDate };
}

/** 子进程不走 shell，不执行包的生命周期脚本；输出只写后端日志，不返回可能含凭据的环境。 */
export function runInstallCommand(exe, args, { cwd, env = process.env, timeoutMs = 300_000, logger } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '',
      expired = false;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        tail = (tail + chunk).slice(-3000);
      });
    const timer = setTimeout(() => {
      expired = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !expired) done();
      else {
        logger?.warn?.(tail);
        fail(new Error(expired ? '安装依赖超时，请检查网络后重试' : `安装子进程退出 (${code})：${tail}`));
      }
    });
  });
}
async function download(url) {
  // codeload 与 npm registry 都不需要 GitHub token，避免把宿主令牌发给无关域名。
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} (${url})`);
  return Buffer.from(await response.arrayBuffer());
}
async function npmCli(paths, options) {
  const cli = join(paths.cache, `npm-${NPM_VERSION}`, 'package', 'bin', 'npm-cli.js');
  if (isFile(cli)) return cli;
  const archive = await download(`https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`);
  if (createHash('sha512').update(archive).digest('base64') !== NPM_INTEGRITY)
    throw new Error('npm 安装器完整性校验失败');
  const dir = join(paths.cache, `npm-${NPM_VERSION}`),
    file = join(paths.cache, 'npm.tgz');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, archive);
  await runInstallCommand('tar.exe', ['-xzf', file, '-C', dir], options);
  if (!isFile(cli)) throw new Error('npm 安装器不完整');
  return cli;
}
export async function prepareTiaraPackage({ paths, stagedDir, latest, env, logger, arch = process.arch } = {}) {
  if (process.platform !== 'win32') throw new Error('Tiara 自动安装目前仅支持 Windows');
  const binary = tiaraBinary(stagedDir, arch);
  logger?.info?.('[opencode2api] Tiara：下载固定提交的源码…');
  const archive = await download(`https://codeload.github.com/${TIARA_REPO}/zip/${latest.commit}`);
  extractZipTree(archive, stagedDir, { prefix: `OpenCode2API-${latest.commit}/` });
  if (!isFile(join(stagedDir, 'package-lock.json')) || !isFile(join(stagedDir, 'src', 'proxy.js')))
    throw new Error('Tiara 源码缺少入口或 package-lock.json');
  const options = { cwd: stagedDir, env: { ...process.env, ...env }, logger };
  const cli = await npmCli(paths, options);
  // 显式 registry 与独立缓存；不修改全局 npm 配置，依赖由 lockfile 的 integrity 校验。
  const common = [
    '--prefer-offline',
    '--fetch-timeout=30000',
    '--fetch-retries=3',
    '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=10000',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
    `--cache=${join(paths.cache, 'npm-cache')}`,
  ];
  logger?.info?.('[opencode2api] Tiara：安装锁定的生产依赖…');
  await runInstallCommand(process.execPath, [cli, 'ci', '--omit=dev', ...common], options);
  logger?.info?.(`[opencode2api] Tiara：下载 OpenCode ${OPENCODE_VERSION} 独立运行时…`);
  const asset = OPENCODE_ASSETS[arch];
  const cacheFile = join(paths.cache, asset.name);
  let runtime = isFile(cacheFile) ? readFileSync(cacheFile) : null;
  const digest = (data) => createHash('sha256').update(data).digest('hex');
  if (!runtime || digest(runtime) !== asset.sha256) {
    runtime = await download(
      `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset.name}`,
    );
    if (digest(runtime) !== asset.sha256) throw new Error('OpenCode 运行时 SHA256 校验失败');
    writeFileSync(cacheFile, runtime);
  }
  mkdirSync(join(stagedDir, 'runtime'), { recursive: true });
  writeFileSync(binary, extractZipEntry(runtime, 'opencode.exe'));
  if (!isFile(binary)) throw new Error('未找到兼容的 OpenCode 1.x 程序');
  const pkg = readJson(join(stagedDir, 'package.json'));
  writeJson(join(stagedDir, MANIFEST), {
    ...latest,
    version: pkg?.version,
    opencodeVersion: OPENCODE_VERSION,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
  });
}
function assertChild(paths, target) {
  const rel = relative(resolve(paths.root), resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('拒绝操作 Tiara 数据目录以外的路径');
}
function remove(paths, target) {
  assertChild(paths, target);
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
async function rename(from, to) {
  for (let n = 0; ; n++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (n >= 14 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      await sleep(200);
    }
  }
}
async function swapIn(paths, staged, tag) {
  const hadCurrent = existsSync(paths.current),
    archived = join(paths.versions, tag ? versionName(tag) : `unknown-${Date.now()}`);
  if (hadCurrent) {
    if (existsSync(archived)) remove(paths, archived);
    await rename(paths.current, archived);
  }
  try {
    await rename(staged, paths.current);
  } catch (error) {
    if (hadCurrent) await rename(archived, paths.current);
    throw error;
  }
  return { hadCurrent, archived };
}
async function restore(paths, swap, returnTo) {
  if (existsSync(paths.current)) {
    if (existsSync(returnTo)) remove(paths, returnTo);
    await rename(paths.current, returnTo);
  }
  if (swap.hadCurrent) await rename(swap.archived, paths.current);
}
async function startAndProbe(service) {
  try {
    const result = await service.ensureRunning();
    return result?.state === 'failed'
      ? { ok: false, reason: result.reason }
      : await probeTiaraHealth({ host: service.spec.host, port: service.port });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
export async function applyTiaraUpdate({
  paths,
  env = process.env,
  apiBase,
  service,
  logger,
  keepVersions = DEFAULT_TIARA_KEEP_VERSIONS,
  target,
  prepare = prepareTiaraPackage,
} = {}) {
  const latest = target ?? (await fetchTiaraSource({ env, apiBase }));
  if (!/^[a-f0-9]{40}$/.test(latest.commit ?? '') || latest.tag !== `main-${latest.commit.slice(0, 12)}`)
    throw new Error('Tiara 源码版本无效');
  const local = localTiaraVersion(paths);
  if (local.revision === latest.commit && isTiaraDir(paths.current))
    return { ok: true, state: 'up-to-date', local, latest };
  layout(paths);
  const staged = join(paths.cache, `staged-${versionName(latest.tag)}`);
  remove(paths, staged);
  mkdirSync(staged, { recursive: true });
  try {
    await prepare({ paths, stagedDir: staged, latest, env, logger });
    if (!isTiaraDir(staged) || readJson(join(staged, MANIFEST))?.commit !== latest.commit)
      throw new Error('Tiara 安装目录不完整或版本不符');
  } catch (error) {
    remove(paths, staged);
    return { ok: false, state: 'prepare-failed', reason: error.message };
  }
  if (service?.disposed) {
    remove(paths, staged);
    return { ok: false, state: 'cancelled', reason: '插件已关闭，安装已取消' };
  }
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) {
    remove(paths, staged);
    return { ok: false, state: 'not-owned', reason: stop.reason };
  }
  let swap;
  try {
    ensureTiaraConfig(paths);
    swap = await swapIn(paths, staged, local.tag);
  } catch (error) {
    remove(paths, staged);
    if (local.tag) await service.ensureRunning();
    return { ok: false, state: 'swap-failed', reason: error.message };
  }
  const health = await startAndProbe(service);
  if (!health.ok) {
    await service.stop('Tiara 健康检查失败，回滚');
    await restore(paths, swap, join(paths.cache, `failed-${versionName(latest.tag)}`));
    const restored = swap.hadCurrent ? await service.ensureRunning() : undefined;
    return {
      ok: false,
      state: 'health-failed',
      reason: health.reason,
      rolledBack: swap.hadCurrent,
      restored: restored?.state,
    };
  }
  writeJson(paths.state, {
    ...latest,
    installedAt: new Date().toISOString(),
    previous: local.tag ? { tag: local.tag, commit: local.revision } : undefined,
  });
  const history = listTiaraVersions(paths),
    kept = new Set([local.tag, ...history.map((v) => v.name)].filter(Boolean).slice(0, Math.max(1, keepVersions)));
  for (const item of history) {
    if (kept.has(item.name)) continue;
    try {
      remove(paths, item.dir);
    } catch (error) {
      logger?.warn?.(`[opencode2api] 清理 Tiara 历史版本失败：${error.message}`);
    }
  }
  logger?.info?.(`[opencode2api] Tiara 已安装 ${latest.tag}`);
  return { ok: true, state: 'updated', latest, health, local: localTiaraVersion(paths) };
}
export async function installTiara(options) {
  if (isTiaraDir(options.paths.current))
    return { ok: false, state: 'already-installed', reason: 'Tiara 已安装，升级请用「更新」' };
  const result = await applyTiaraUpdate(options);
  return result.ok ? { ...result, state: 'installed' } : result;
}
export async function rollbackTiara({ paths, service, logger } = {}) {
  const state = readJson(paths.state),
    previous = state?.previous;
  if (!previous?.tag) return { ok: false, state: 'no-previous', reason: '没有可回滚的 Tiara 版本' };
  const dir = join(paths.versions, versionName(previous.tag));
  if (!isTiaraDir(dir)) return { ok: false, state: 'missing', reason: '上一版本目录不存在或不完整' };
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };
  const current = localTiaraVersion(paths);
  let swap;
  try {
    swap = await swapIn(paths, dir, current.tag);
  } catch (error) {
    await service.ensureRunning();
    return { ok: false, state: 'swap-failed', reason: error.message };
  }
  const health = await startAndProbe(service);
  if (!health.ok) {
    await service.stop('Tiara 回滚失败');
    await restore(paths, swap, dir);
    await service.ensureRunning();
    return { ok: false, state: 'health-failed', reason: health.reason, restored: true };
  }
  writeJson(paths.state, {
    ...readJson(paths.manifest),
    installedAt: new Date().toISOString(),
    previous: { tag: current.tag, commit: current.revision },
  });
  return { ok: true, state: 'rolled-back', health, local: localTiaraVersion(paths) };
}
export async function uninstallTiara({ paths, service, logger } = {}) {
  const stop = await stopForUpdate(service, logger);
  if (!stop.ok) return { ok: false, state: 'not-owned', reason: stop.reason };
  for (const file of [paths.current, paths.versions, paths.cache, paths.state])
    if (existsSync(file)) remove(paths, file);
  return { ok: true, state: 'uninstalled', kept: ['tiara/data/', 'logs/'] };
}
export function purgeTiaraData({ paths, service, logger, env } = {}) {
  return purgeBackendData({ paths: paths.plugin, service, logger, env });
}
