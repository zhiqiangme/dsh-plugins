import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compareVersions, downloadRelease, fetchRelease, formatError, sha256, versionOf } from './release.js';

const exec = promisify(execFile);
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value, null, 2)); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
export function backendPaths(env = process.env) {
  const home = env.DSH_HOME?.trim() ? resolve(env.DSH_HOME) : join(homedir(), '.dsh');
  const root = env.DSH_MAGPIE_BACKEND_ROOT?.trim() ? resolve(env.DSH_MAGPIE_BACKEND_ROOT) : join(home, 'magpie');
  // Magpie 自己的设置：设置了 XDG_CONFIG_HOME 时在其下，否则在 ~/.config/magpie（Windows 同样如此）。
  const config = env.XDG_CONFIG_HOME?.trim() ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config');
  return { root, current: join(root, 'backend', 'current'), versions: join(root, 'backend', 'versions'), cache: join(root, 'cache'), exe: join(root, 'backend', 'current', 'magpie.exe'), settings: join(config, 'magpie', 'settings.json') };
}
export function targetPath(value, paths) {
  if (value !== undefined && value !== '' && (typeof value !== 'string' || !isAbsolute(value.trim()) || /[\x00-\x1f]/.test(value) || !/\.exe$/i.test(value.trim()))) throw new Error('Magpie 路径必须是 exe 文件的绝对路径，留空使用插件独立目录');
  const path = value ? resolve(value.trim()) : paths.exe;
  if (existsSync(path) && (!isFile(path) || lstatSync(path).isSymbolicLink())) throw new Error('Magpie 路径必须是普通文件，不能是目录或符号链接');
  return path;
}
export async function probeVersion(path, signal) {
  const { stdout } = await exec(path, ['--version'], { windowsHide: true, timeout: 8_000, maxBuffer: 64 * 1024, signal });
  const version = /^magpie\s+v?(\d+\.\d+\.\d+)\b/im.exec(stdout)?.[1];
  if (!version) throw new Error('该文件没有返回有效的 Magpie 版本，拒绝覆盖');
  return version;
}
/**
 * 以独立进程启动 Magpie：detached 让它脱离 DSH 的进程组与作业对象，DSH 退出不会连带结束它
 * （是否随 DSH 关闭由「退出 DSH 时同时关闭 Magpie」决定）。
 * DSH 的运行时以 ELECTRON_RUN_AS_NODE 启动，继承下去会让 Electron 类程序变成 Node；启动前去掉。
 */
export function launchDetached(path, args = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[name];
    const child = spawn(path, args, { cwd: dirname(path), detached: true, stdio: 'ignore', windowsHide: false, env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}
/**
 * 本机是否已有任何 Magpie 在运行：目标路径本身，或文件名为 magpie.exe / 官方 Windows 产物名的进程
 * （用户自己另装的 Magpie 也算），避免开机时再拉起第二个实例抢端口。
 */
export async function anyMagpieRunning(path) {
  const script = "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:DSH_MAGPIE_PROBE_TARGET); @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target) -or ($_.Name -match '^magpie(?:-windows-(?:amd64|arm64))?\\.exe$') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, env: { ...process.env, DSH_MAGPIE_PROBE_TARGET: path } });
  const found = stdout.trim() ? JSON.parse(stdout.trim()) : [];
  return Array.isArray(found) ? found.length > 0 : Number.isSafeInteger(found) && found > 0;
}
async function runningWindows(path) {
  // 路径经环境传入固定脚本，不能把用户输入拼进 PowerShell 命令。
  const script = "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:DSH_MAGPIE_PROBE_TARGET); $name=[IO.Path]::GetFileName($target); @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target) -or (!$_.ExecutablePath -and $_.Name -eq $name) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, env: { ...process.env, DSH_MAGPIE_PROBE_TARGET: path } });
  const found = stdout.trim() ? JSON.parse(stdout.trim()) : [];
  return Array.isArray(found) ? found.length > 0 : Number.isSafeInteger(found) && found > 0;
}

/**
 * 结束目标路径上的 Magpie 并等待退出。Magpie 没有退出命令，关窗口只会缩到托盘，只能结束进程；
 * 它的插件宿主子进程（magpie-bun.exe）会在几秒内自行退出（本机实测），这里一并结束，免得新旧插件宿主短暂并存。
 */
export async function stopWindows(path) {
  const script = "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:DSH_MAGPIE_PROBE_TARGET); $all=@(Get-CimInstance Win32_Process); $found=@($all | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target }); $ids=@($found | Select-Object -ExpandProperty ProcessId); $children=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.Name -match '^magpie-bun' }); foreach ($p in @($found) + @($children)) { Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue }; foreach ($p in @($found) + @($children)) { Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }; @($ids) | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, DSH_MAGPIE_PROBE_TARGET: path } });
  const found = stdout.trim() ? JSON.parse(stdout.trim()) : [];
  return Array.isArray(found) ? found : [found];
}

// 「防止休眠」在 Magpie 里是三档：关闭、开启（keepAwake）、屏幕也常亮（再加 keepAwakeDisplay）。
export const KEEP_AWAKE_MODES = Object.freeze(['off', 'on', 'display']);

/** 与 WB 一样把程序、备份和缓存放在 DSH home，绝不把 Magpie 的账号目录随程序搬走。 */
export class MagpieBackend {
  constructor({ env = process.env, platform = process.platform, arch = process.arch, fetchImpl = fetch, probe = probeVersion, isRunning = runningWindows, launch = launchDetached, stop = stopWindows, retryDelayMs } = {}) {
    Object.assign(this, { env, platform, arch, fetchImpl, probe, isRunning, launch, stop, retryDelayMs });
    this.paths = backendPaths(env); this.latest = null; this.operation = null; this.pending = null; this.disposed = false; this.versions = new Map();
  }
  get supported() { return this.platform === 'win32' && ['x64', 'arm64'].includes(this.arch); }
  async local(path, signal) {
    if (!isFile(path)) return { installed: false, version: null, reason: null };
    const stat = statSync(path), key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (this.versions.get(path)?.key === key) return this.versions.get(path).value;
    let value;
    try { value = { installed: true, version: versionOf(await this.probe(path, signal)), reason: null }; if (!value.version) throw new Error('Magpie 版本无效'); }
    catch (error) { if (signal?.aborted) throw error; value = { installed: true, version: null, reason: formatError(error) }; }
    this.versions.set(path, { key, value }); return value;
  }
  async describe(value) {
    let path;
    try { path = targetPath(value, this.paths); }
    catch (error) {
      // 已保存的路径可能后来变成目录或符号链接；只在程序区块报错，不能让整张卡片读不出配置。
      return { supported: this.supported, path: typeof value === 'string' ? value.trim() : '', defaultPath: this.paths.exe, installed: false, version: null, reason: formatError(error), latest: this.latestView(), updateAvailable: false, operation: this.operation };
    }
    const local = !this.supported ? { installed: isFile(path), version: null, reason: '下载升级目前支持 Windows x64 / ARM64，模型管理不受影响' }
      : this.operation?.running && this.operation.path === path ? { installed: isFile(path), version: this.versions.get(path)?.value.version ?? null, reason: null } : await this.local(path);
    return { supported: this.supported, path, defaultPath: this.paths.exe, ...local, latest: this.latestView(), updateAvailable: Boolean(local.version && this.latest && compareVersions(local.version, this.latest.version) < 0), operation: this.operation };
  }
  /**
   * 读 Magpie 的 settings.json。文件由 Magpie 首次运行时创建；不存在时不代写，免得一个残缺文件被当成已有设置。
   * Magpie 用 omitempty 保存布尔值，关闭的开关就是缺省字段。
   */
  settings() {
    const value = readJson(this.paths.settings);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { available: false, path: this.paths.settings };
    return { available: true, path: this.paths.settings, lightweight: value.lightweight === true, keepAwake: !value.keepAwake ? 'off' : value.keepAwakeDisplay ? 'display' : 'on' };
  }
  /**
   * 只改轻量模式和防止休眠，其余字段原样保留。运行中的 Magpie 保存自己的设置前会重新读取文件，
   * 外部改动不会被它覆盖（本机实测）。
   */
  updateSettings({ lightweight, keepAwake } = {}) {
    if (lightweight !== undefined && typeof lightweight !== 'boolean') throw new Error('轻量模式必须是布尔值');
    if (keepAwake !== undefined && !KEEP_AWAKE_MODES.includes(keepAwake)) throw new Error(`防止休眠只能是 ${KEEP_AWAKE_MODES.join('、')}`);
    const value = readJson(this.paths.settings);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('还没有 Magpie 设置文件，请先打开一次 Magpie');
    const set = (key, on) => { if (on) value[key] = true; else delete value[key]; };
    if (lightweight !== undefined) set('lightweight', lightweight);
    if (keepAwake !== undefined) { set('keepAwake', keepAwake !== 'off'); set('keepAwakeDisplay', keepAwake === 'display'); }
    atomicJson(this.paths.settings, value);
    return this.settings();
  }
  /** 打开轻量模式；已开启或设置文件尚不存在时不动，失败不影响启动。 */
  ensureLightweight() {
    try { const current = this.settings(); if (current.available && !current.lightweight) this.updateSettings({ lightweight: true }); return true; }
    catch { return false; }
  }
  /** 打开 Magpie 窗口：Magpie 单实例，已在托盘运行时再启动一次只会让原进程显示窗口，不会出现第二个网关（本机实测）。 */
  async open(value, { lightweight = false } = {}) {
    if (!this.supported) throw new Error('打开 Magpie 目前支持 Windows x64 / ARM64');
    const path = targetPath(value, this.paths);
    if (this.operation?.running && this.operation.path === path) throw new Error('Magpie 正在下载或升级，请稍后再打开');
    const local = await this.local(path);
    if (!local.installed) throw new Error('尚未下载 Magpie');
    if (!local.version) throw new Error(local.reason || '该程序未能验证为 Magpie');
    if (lightweight) this.ensureLightweight();
    return { pid: await this.launch(path, []) };
  }
  latestView() { return this.latest ? { version: this.latest.version, url: this.latest.url, publishedAt: this.latest.publishedAt } : null; }
  assertReady() {
    if (this.disposed) throw new Error('插件已关闭');
    if (!this.supported) throw new Error('Magpie 下载升级目前支持 Windows x64 / ARM64');
    if (this.pending) { const error = new Error('Magpie 正在检查、下载或升级，请等待当前操作结束'); error.status = 409; throw error; }
  }
  async check(value) {
    this.assertReady(); const path = targetPath(value, this.paths);
    this.operation = null;
    this.versions.delete(path);
    const controller = this.controller = new AbortController();
    const work = this.pending = fetchRelease({ env: this.env, arch: this.arch, fetchImpl: this.fetchImpl, signal: controller.signal });
    try { this.latest = await work; controller.signal.throwIfAborted(); return await this.describe(path); }
    finally { if (this.pending === work) this.pending = null; }
  }
  install(value, { lightweight = false } = {}) {
    this.assertReady(); const path = targetPath(value, this.paths);
    const controller = this.controller = new AbortController();
    this.operation = { id: randomUUID(), path, phase: 'checking', running: true, received: 0, total: 0 };
    const work = this.pending = Promise.resolve().then(() => this.apply(path, controller.signal, { lightweight }));
    work.then((result) => { this.operation = { ...this.operation, ...result, phase: result.state, running: false }; }, (error) => { this.operation = { ...this.operation, phase: 'failed', running: false, reason: formatError(error) }; }).finally(() => { if (this.pending === work) this.pending = null; });
    return { ...this.operation };
  }
  acquireLock() {
    mkdirSync(this.paths.cache, { recursive: true });
    const lock = join(this.paths.cache, 'install.lock');
    if (existsSync(lock)) {
      const pid = readJson(lock)?.pid;
      let stale = false;
      if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
      if (!stale) throw new Error('另一 DSH 进程正在安装 Magpie，或安装锁无法确认，请稍后重试');
      rmSync(lock);
    }
    const fd = openSync(lock, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } catch (error) { closeSync(fd); rmSync(lock, { force: true }); throw error; }
    closeSync(fd);
    return () => rmSync(lock, { force: true });
  }
  /** 替换前退出运行中的目标程序；下载和校验期间不打断，尽量缩短网关不可用的时间。 */
  async stopRunning(path) {
    if (!isFile(path) || !await this.isRunning(path)) return false;
    this.operation.phase = 'stopping';
    await this.stop(path);
    if (await this.isRunning(path)) throw new Error('未能退出正在运行的 Magpie，现有程序未更改；请手动退出 Magpie（包括托盘）后重试');
    return true;
  }
  async apply(path, signal, { lightweight = false } = {}) {
    signal.throwIfAborted();
    const unlock = this.acquireLock();
    let staged;
    try {
      const before = await this.local(path, signal);
      if (before.installed && !before.version) throw new Error(before.reason || '现有文件未能验证为 Magpie，未覆盖');
      targetPath(path, this.paths);
      const initialHash = before.installed ? sha256(readFileSync(path)) : null;
      this.latest = await fetchRelease({ env: this.env, arch: this.arch, fetchImpl: this.fetchImpl, signal });
      if (before.version && compareVersions(before.version, this.latest.version) >= 0) return { state: 'up-to-date', version: before.version };
      this.operation.phase = 'downloading';
      const download = await downloadRelease(this.latest, { fetchImpl: this.fetchImpl, signal, partialDir: join(this.paths.cache, 'downloads'), retryDelayMs: this.retryDelayMs, onProgress: (received, total) => Object.assign(this.operation, { received, total }) });
      signal.throwIfAborted();
      this.operation.phase = 'verifying';
      mkdirSync(dirname(path), { recursive: true });
      staged = join(dirname(path), `.${basename(path)}.${randomUUID()}.download.exe`);
      writeFileSync(staged, download.bytes, { flag: 'wx' });
      if (versionOf(await this.probe(staged, signal)) !== this.latest.version) throw new Error('下载程序版本与 Release 不符，现有程序未更改');
      signal.throwIfAborted();
      const stopped = await this.stopRunning(path);
      try {
        signal.throwIfAborted();
        targetPath(path, this.paths);
        if ((isFile(path) ? sha256(readFileSync(path)) : null) !== initialHash) throw new Error('下载期间目标程序发生变化，请重新检查后再升级');
        this.operation.phase = 'installing';
        await this.swap(path, staged, before, this.latest, download.sha256, signal);
      } catch (error) {
        // 是插件把它退出的，升级没成就把原程序在后台重新打开，网关不能因此一直停着。
        if (stopped && isFile(path)) try { await this.launch(path, ['tray']); } catch { /* 原因已在升级失败里报告 */ }
        throw error;
      }
      staged = null; this.versions.delete(path);
      // 失败时保留已校验的下载供下次直接使用；装好后再删。
      rmSync(download.file, { force: true });
      // 首次下载打开窗口供用户配置；升级沿用后台托盘模式，不打断当前桌面。
      return { state: before.installed ? 'updated' : 'installed', version: this.latest.version, stopped, ...await this.start(path, { window: !before.installed, lightweight }) };
    } finally { try { if (staged) rmSync(staged, { force: true }); } finally { unlock(); } }
  }
  /** 安装已完成，启动失败只作提示，不能把成功的安装报成失败。 */
  async start(path, { window = false, lightweight = false } = {}) {
    this.operation.phase = 'starting';
    try {
      if (lightweight) this.ensureLightweight();
      // 替换前已退出目标；这里再查一次，避免重复打开用户刚手动启动的同一程序。
      if (await this.isRunning(path)) return { launched: false, alreadyRunning: true };
      return { launched: true, window, pid: await this.launch(path, window ? [] : ['tray']) };
    } catch (error) { return { launched: false, launchError: formatError(error) }; }
  }
  async swap(path, staged, before, release, hash, signal) {
    const retired = `${path}.${randomUUID()}.old`;
    const manifest = join(this.paths.cache, `install-${sha256(path.toLowerCase()).slice(0, 24)}.json`);
    const previous = readJson(manifest)?.previous ?? [];
    let archived, oldMoved = false, newMoved = false, obsolete = [];
    if (before.installed) {
      mkdirSync(this.paths.versions, { recursive: true });
      archived = { file: `${randomUUID()}.exe`, version: before.version };
      copyFileSync(path, join(this.paths.versions, archived.file));
    }
    try {
      signal.throwIfAborted();
      if (before.installed) { renameSync(path, retired); oldMoved = true; }
      renameSync(staged, path); newMoved = true;
      if (versionOf(await this.probe(path, signal)) !== release.version) throw new Error('替换后版本验证失败');
      if (sha256(readFileSync(path)) !== hash) throw new Error('替换后文件校验失败');
      signal.throwIfAborted();
      const backups = [...(archived ? [archived] : []), ...(Array.isArray(previous) ? previous : [])];
      atomicJson(manifest, { path, version: release.version, sha256: hash, installedAt: new Date().toISOString(), previous: backups.slice(0, 3) });
      obsolete = backups.slice(3);
    } catch (error) {
      try { if (newMoved) rmSync(path); if (oldMoved) renameSync(retired, path); }
      catch (restoreError) { throw new Error(`升级失败且自动恢复未完成，旧程序保留于 ${retired}：${formatError(restoreError)}`, { cause: error }); }
      // 恢复成功后这份备份没有记进清单，不再有人清理；恢复失败时保留它兜底。
      if (archived) try { rmSync(join(this.paths.versions, archived.file), { force: true }); } catch { /* 留给用户清理 */ }
      this.versions.delete(path);
      throw new Error(`安装失败${oldMoved ? '，已恢复旧程序' : ''}：${formatError(error)}`, { cause: error });
    }
    // 安装已完成；旧副本清理失败不能把一个成功安装误报为失败或回滚。
    if (oldMoved) try { rmSync(retired, { force: true }); } catch { /* 保留副本，供用户稍后清理。 */ }
    for (const item of obsolete) if (/^[a-f0-9-]{36}\.exe$/.test(item.file)) try { rmSync(join(this.paths.versions, item.file), { force: true }); } catch { /* 下次由用户清理旧备份。 */ }
  }
  async dispose() { this.disposed = true; this.controller?.abort(); await this.pending?.catch(() => {}); }
}
