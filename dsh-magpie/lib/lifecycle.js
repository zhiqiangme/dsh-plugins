import { spawnSync } from 'node:child_process';
import { anyMagpieRunning, backendPaths, targetPath } from './backend.js';
import { isLocal } from './config.js';

// 退出关闭脚本本机实测约 1.2 秒，但 PowerShell 冷启动加枚举全部进程在慢机器上会超过 4 秒
// （GitHub Windows runner 实际遇到过）。只在开启联动时阻塞退出，放宽到 10 秒换取可靠关闭。
export const CLOSE_TIMEOUT = 10_000;
// 端口探测只用于判断“已有服务在听”，2 秒足够本机回应。
const PORT_TIMEOUT = 2_000;

/** 本机 Magpie 端口是否已被占用；连接被拒绝视为空闲，超时等无法确定的情况按占用处理，宁可不启动也不重复启动。 */
async function portBusy(baseURL, fetchImpl) {
  try {
    await fetchImpl(`${baseURL}/api/hello`, { signal: AbortSignal.timeout(PORT_TIMEOUT), redirect: 'manual' });
    return true;
  } catch (error) {
    const codes = [error?.code, error?.cause?.code, ...(error?.cause?.errors ?? []).map((e) => e?.code)];
    return !codes.includes('ECONNREFUSED');
  }
}

/**
 * DSH 启动、插件激活时，若本机没有 Magpie 在运行，启动程序路径中的 Magpie。
 * 只处理本机地址，且程序必须能验证为 Magpie；远程地址、未下载或正在下载升级时不动。
 */
export async function autoStartMagpie(manager, { platform = process.platform, fetchImpl = manager.fetch, findRunning = anyMagpieRunning } = {}) {
  const config = manager.config, backend = manager.backend;
  if (!config.autoStart || platform !== 'win32' || !isLocal(config.baseURL)) return { state: 'disabled' };
  if (backend.pending) return { state: 'busy' };
  const path = targetPath(config.magpiePath, backend.paths);
  const local = await backend.local(path);
  if (!local.installed) return { state: 'not-installed', path };
  if (!local.version) return { state: 'unverified', path, reason: local.reason };
  if (await portBusy(config.baseURL, fetchImpl) || await findRunning(path)) return { state: 'running', path };
  if (manager.disposed || backend.pending) return { state: 'busy' };
  return { state: 'started', path, pid: await backend.launch(path) };
}

export function registerAutoStart(ctx, manager, { start = autoStartMagpie } = {}) {
  const logger = ctx.logger ?? console;
  start(manager).then((result) => {
    if (result.state === 'started') logger.info(`[dsh-magpie] 本机未运行 Magpie，已启动 ${result.path}（PID ${result.pid}）`);
    else if (result.state === 'unverified') logger.warn(`[dsh-magpie] ${result.path} 未能验证为 Magpie，未自动启动：${result.reason ?? ''}`);
  }, (error) => logger.warn(`[dsh-magpie] 自动启动 Magpie 失败：${error.message}`));
}

// exit 阶段不允许异步等待。固定脚本通过环境变量接收路径和端口，不拼接用户输入。
const CLOSE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$target = [IO.Path]::GetFullPath($env:DSH_MAGPIE_CLOSE_TARGET)
$processes = @(Get-CimInstance Win32_Process)
$magpieCandidates = @()
if ($env:DSH_MAGPIE_CLOSE_EXPLICIT -ne '1' -and $env:DSH_MAGPIE_CLOSE_PORT) {
  $port = [int]$env:DSH_MAGPIE_CLOSE_PORT
  $owners = @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp | ForEach-Object {
    $parts = $_.Trim() -split '\s+'
    if ($parts.Count -eq 5 -and $parts[0] -eq 'TCP' -and $parts[1] -match ":$port$" -and $parts[3] -eq 'LISTENING') { [int]$parts[4] }
  })
  $magpieCandidates = @($processes | Where-Object {
    $_.ProcessId -in $owners -and $_.ExecutablePath -and
    [IO.Path]::GetFileName($_.ExecutablePath) -match '^magpie(?:-windows-(?:amd64|arm64))?\.exe$'
  })
}
if ($magpieCandidates.Count -eq 0) {
  $magpieCandidates = @($processes | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target })
}
$closed = @()
foreach ($candidate in $magpieCandidates) {
  $current = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
  # 再核对 PID 当前的完整路径；没有读到路径时不按名称盲目结束。
  if (!$current -or !$current.Path -or [IO.Path]::GetFullPath($current.Path) -ne [IO.Path]::GetFullPath($candidate.ExecutablePath)) { continue }
  try { Stop-Process -InputObject $current -ErrorAction Stop }
  catch { if (Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue) { throw }; continue }
  $closed += @{ pid = $candidate.ProcessId; path = $candidate.ExecutablePath }
}
ConvertTo-Json -InputObject @($closed) -Compress
`;

/** 只关闭明确的本机目标；网关自动识别额外限制 Magpie 文件名，避免关闭占用同端口的其它软件。 */
export function closeMagpieSync(config, { env = process.env, platform = process.platform, run = spawnSync } = {}) {
  if (!config.closeOnExit || platform !== 'win32') return [];
  const target = targetPath(config.magpiePath, backendPaths(env));
  const url = new URL(config.baseURL);
  const port = isLocal(url.href) ? url.port || (url.protocol === 'https:' ? '443' : '80') : '';
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CLOSE_SCRIPT], {
    windowsHide: true, encoding: 'utf8', timeout: CLOSE_TIMEOUT, maxBuffer: 64 * 1024,
    env: { ...env, DSH_MAGPIE_CLOSE_TARGET: target, DSH_MAGPIE_CLOSE_EXPLICIT: config.magpiePath ? '1' : '0', DSH_MAGPIE_CLOSE_PORT: port },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Magpie 退出检查失败（${result.status}）`);
  return JSON.parse(result.stdout.trim() || '[]');
}

/** 普通插件停用/重载只解绑；根上下文关闭或进程正式退出才执行联动。 */
export function registerExitClose(ctx, manager, { hostProcess = process, close = closeMagpieSync } = {}) {
  ctx.effect(() => {
    let attempted = false;
    const onExit = () => {
      if (attempted || !manager.config.closeOnExit) return;
      attempted = true;
      try {
        const closed = close(manager.config, { env: manager.env });
        if (closed.length) (ctx.logger ?? console).info(`[dsh-magpie] DSH 退出，已关闭 Magpie（PID ${closed.map((p) => p.pid).join(', ')}）`);
      } catch (error) { (ctx.logger ?? console).warn(`[dsh-magpie] 退出时关闭 Magpie 失败：${error.message}`); }
    };
    hostProcess.once('exit', onExit);
    return () => {
      hostProcess.removeListener('exit', onExit);
      // 当前 Cordis 在根 fiber.dispose() 时先进入 DISPOSING(5)，再卸载插件；插件自身重载时根仍为 ACTIVE(2)。
      if (ctx.root?.fiber?.state === 5) onExit();
    };
  }, 'dsh-magpie: close on host exit');
}
