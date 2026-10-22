import { spawnSync } from 'node:child_process';
import { backendPaths, targetPath } from './backend.js';
import { isLocal } from './config.js';

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
    windowsHide: true, encoding: 'utf8', timeout: 4_000, maxBuffer: 64 * 1024,
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
