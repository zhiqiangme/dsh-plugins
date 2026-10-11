<#
.SYNOPSIS
  把本仓库的 DSH 插件安装 / 更新 / 卸载到 DSH 的 profile，或查看安装状态。

.DESCRIPTION
  入口是仓库根目录的 install-plugins.cmd（可双击）；直接运行本脚本也可以。
  不带参数时逐项询问，带参数时跳过对应问题（便于在终端里一行跑完）。

  真正干活的是 DSH 自带的 `dsh plugin --profile <名> add|remove ...`：它在 profile 锁内跑 DSH 自带的 pnpm，
  同时维护 package.json 的 dependencies 和 dsh.profile.bundles，并做插件兼容性检查。
  所以本脚本不手改 package.json，也不需要系统装 Node。

  为什么"更新"要先 remove 再 add：插件以 file: 依赖拷贝进 profile 的 node_modules，源码改动后
  再次 add（包括 --force）pnpm 都认为"已是最新"不会重新拷贝；只有先移除再添加才会拿到新代码。
  移除只动 package.json，插件写在 cordis.patch.yml 里的配置行（如模型白名单）原样保留。

.PARAMETER Action
  install（安装/更新，默认）、uninstall（卸载）、status（查看状态）。
.PARAMETER Plugins
  all（默认）、workbuddy、tavily-search，或完整包名；可多个。
.PARAMETER Profiles
  desktop（默认）、web、cli（即 DSH 的 headless profile），或其它 profile 名；可多个。
.PARAMETER Yes
  跳过执行前的确认。

.EXAMPLE
  .\install-plugins.cmd
.EXAMPLE
  .\install-plugins.cmd -Action install -Plugins workbuddy -Profiles desktop,web -Yes
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action,
  [string[]]$Plugins,
  [string[]]$Profiles,
  [switch]$Yes
)

# 本脚本需要兼容 Windows PowerShell 5.1（没装 pwsh 的机器由 .cmd 回退到它），
# 所以不用 ??、三元运算符、&& 这类 7.x 才有的语法；文件存成带 BOM 的 UTF-8，否则 5.1 会按 ANSI 读出乱码。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$RepoRoot = Split-Path -Parent $PSScriptRoot

# 本仓库提供的插件。Legacy 是改名前的包名：profile 里还留着旧名时一并移除，否则旧目录不存在会让 pnpm 安装失败。
$Catalog = @(
  [pscustomobject]@{ Name = 'dsh-autostart-workbuddy'; Alias = 'workbuddy'; Title = 'WorkBuddy 自动启动 + 模型同步'; Legacy = @() },
  [pscustomobject]@{ Name = 'dsh-tavily-search'; Alias = 'tavily-search'; Title = 'Tavily 网页搜索'; Legacy = @('dsh-autostart-websearch') }
)
foreach ($plugin in $Catalog) {
  $plugin | Add-Member -NotePropertyName Dir -NotePropertyValue (Join-Path $RepoRoot $plugin.Name)
}

# 面向用户的 profile 选项。CLI 对应 DSH 的 headless profile（`dsh headless "任务"`）：这一版 DSH 没有单独的 tui 模板。
$ProfileChoices = @(
  [pscustomobject]@{ Name = 'desktop'; Title = 'Desktop（桌面版）' },
  [pscustomobject]@{ Name = 'web'; Title = 'Web（dsh web）' },
  [pscustomobject]@{ Name = 'headless'; Title = 'CLI（dsh headless）' }
)

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host "  $Text" -ForegroundColor Red }

<# 单选菜单：直接回车取默认项（第一项）。返回选中项的下标。 #>
function Read-Choice([string]$Question, [string[]]$Options) {
  Write-Host ''
  Write-Host $Question
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $mark = ''
    if ($i -eq 0) { $mark = '（默认）' }
    Write-Host ("  [{0}] {1}{2}" -f ($i + 1), $Options[$i], $mark)
  }
  while ($true) {
    $answer = ([string](Read-Host '请输入序号，直接回车用默认')).Trim()
    if ($answer -eq '') { return 0 }
    $number = 0
    if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $Options.Count) {
      return $number - 1
    }
    Write-Warn "无效输入：$answer"
  }
}

function Read-YesNo([string]$Question) {
  $answer = ([string](Read-Host "$Question [Y/n]")).Trim()
  return ($answer -eq '' -or $answer -match '^(y|yes|是)$')
}

<#
  找 DSH 自带的命令行入口。桌面版安装时会把 resources\runtime\cli\bin 加进用户 PATH；
  没加的话按默认安装位置找。也可以用环境变量 DSH_CLI 指定。
#>
function Resolve-DshCli {
  if ($env:DSH_CLI -and (Test-Path -LiteralPath $env:DSH_CLI)) { return $env:DSH_CLI }
  $command = Get-Command 'dsh.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  $fallback = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  throw '找不到 DSH 的命令行入口 dsh.cmd。请先安装 DeepSeek Harness 桌面版，或用环境变量 DSH_CLI 指向 dsh.cmd。'
}

<# 与 DSH 的 resolveDshHome 一致：DSH_HOME 优先，否则 ~/.dsh。 #>
function Get-DshHome {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { return $env:DSH_HOME.Trim() }
  return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
}

function Get-ProfileDir([string]$ProfileName) { return Join-Path (Join-Path (Get-DshHome) 'profiles') $ProfileName }

function Read-Manifest([string]$ProfileName) {
  $path = Join-Path (Get-ProfileDir $ProfileName) 'package.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-Dependencies($Manifest) {
  $map = @{}
  if ($Manifest -and $Manifest.dependencies) {
    foreach ($property in $Manifest.dependencies.PSObject.Properties) { $map[$property.Name] = [string]$property.Value }
  }
  return $map
}

function Get-Bundles($Manifest) {
  if ($Manifest -and $Manifest.dsh -and $Manifest.dsh.profile -and $Manifest.dsh.profile.bundles) {
    return @($Manifest.dsh.profile.bundles)
  }
  return @()
}

<#
  插件目录里会被 pnpm 拷进 profile 的文件：package.json 的 files 列表 + package.json 本身。
  返回 相对路径 → SHA256，用来判断 profile 里那份拷贝和仓库是否一致。
#>
function Get-PackageDigest([string]$Dir, [string[]]$Patterns) {
  $digest = @{}
  if (-not (Test-Path -LiteralPath $Dir)) { return $digest }
  $root = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\') + '\'
  $files = New-Object System.Collections.Generic.List[string]
  $files.Add((Join-Path $Dir 'package.json'))
  foreach ($pattern in $Patterns) {
    $target = Join-Path $Dir $pattern
    if ($pattern -match '[*?]') {
      Get-ChildItem -Path $target -File -ErrorAction SilentlyContinue | ForEach-Object { $files.Add($_.FullName) }
    } elseif (Test-Path -LiteralPath $target -PathType Container) {
      Get-ChildItem -LiteralPath $target -File -Recurse | ForEach-Object { $files.Add($_.FullName) }
    } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
      $files.Add($target)
    }
  }
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    $full = (Resolve-Path -LiteralPath $file).Path
    $digest[$full.Substring($root.Length)] = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
  }
  return $digest
}

<# profile 里的拷贝是否与仓库当前代码一致（文件集合与内容都要相同）。 #>
function Test-CopyCurrent($Plugin, [string]$ProfileName) {
  $installed = Join-Path (Join-Path (Get-ProfileDir $ProfileName) 'node_modules') $Plugin.Name
  if (-not (Test-Path -LiteralPath $installed)) { return $false }
  $patterns = @((Get-Content -LiteralPath (Join-Path $Plugin.Dir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).files)
  $want = Get-PackageDigest $Plugin.Dir $patterns
  $have = Get-PackageDigest $installed $patterns
  if ($want.Count -ne $have.Count) { return $false }
  foreach ($key in $want.Keys) {
    if ($have[$key] -ne $want[$key]) { return $false }
  }
  return $true
}

<# 依赖写的是不是指向本仓库这个目录的 file: 依赖（pnpm 会把反斜杠改写成正斜杠，比较前统一）。 #>
function Test-SpecPointsHere([string]$Spec, $Plugin) {
  if (-not $Spec -or -not $Spec.StartsWith('file:')) { return $false }
  $path = $Spec.Substring(5).Replace('/', '\').TrimEnd('\')
  return ($path -ieq $Plugin.Dir.TrimEnd('\'))
}

<#
  找正在使用该 profile 的 DSH 进程。DSH 的 CLI 和桌面宿主都是 "DeepSeek Harness.exe" 以 Node 模式运行：
  - 桌面宿主：命令行含 dsh-desktop-host\lib\index.js 和 profile 目录；
  - CLI（dsh web / dsh headless）：命令行含 dsh-desktop-host\lib\cli.js 和 profile 名（排除 dsh plugin 自己）。
  只用于提醒，查不到进程信息时当作没在运行。
#>
function Get-ProfileProcesses([string]$ProfileName) {
  try {
    $processes = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction Stop
  } catch {
    return @()
  }
  $profileDir = Get-ProfileDir $ProfileName
  $namePattern = '(^|\s)(--profile\s+)?"?' + [regex]::Escape($ProfileName) + '"?(\s|$)'
  return @($processes | Where-Object {
      $line = [string]$_.CommandLine
      if ($line -like '*dsh-desktop-host\lib\index.js*') { return $line.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
      if ($line -like '*dsh-desktop-host\lib\cli.js*') {
        $rest = $line.Substring($line.IndexOf('cli.js') + 6).Trim(' ', '"')
        return ($rest -notmatch '(^|\s)plugin(\s|$)' -and $rest -match $namePattern)
      }
      return $false
    })
}

<#
  DSH 要求改 desktop profile 的插件前完全退出桌面版（运行中的宿主会和 pnpm 抢 node_modules）；
  web / CLI 正在运行时装上的插件也要重启才加载。这里等用户关掉，或放弃这个 profile。
#>
function Wait-ProfileIdle([string]$ProfileName) {
  while ($true) {
    $running = Get-ProfileProcesses $ProfileName
    if ($running.Count -eq 0) { return $true }
    if ($ProfileName -eq 'desktop') {
      Write-Warn 'DSH 桌面版正在运行。请完全退出（包括托盘图标里的"退出"）后再继续。'
    } else {
      Write-Warn "有 DSH 进程正在使用 $ProfileName profile（PID $(($running | ForEach-Object { $_.ProcessId }) -join ', ')），请先关掉它。"
    }
    $answer = ([string](Read-Host '关掉后按回车重试；输入 s 跳过这个 profile')).Trim()
    if ($answer -match '^s') { return $false }
  }
}

<# 调 dsh plugin；pnpm 的输出原样显示。返回是否成功。 #>
function Invoke-DshPlugin([string]$ProfileName, [string[]]$Arguments) {
  Write-Host "  > dsh plugin --profile $ProfileName $($Arguments -join ' ')" -ForegroundColor DarkGray
  # 输出直接送到控制台：不能留在函数的输出流里，否则会和返回值混在一起，让失败看起来像成功
  & $script:Dsh plugin --profile $ProfileName @Arguments | Out-Host
  return ($LASTEXITCODE -eq 0)
}

function Show-Status([string]$ProfileName, $Selected) {
  $dir = Get-ProfileDir $ProfileName
  Write-Step "$ProfileName  $dir"
  $manifest = Read-Manifest $ProfileName
  if (-not $manifest) {
    Write-Warn '尚未创建（安装时会自动创建；desktop 需要先打开一次桌面版）'
    return
  }
  $dependencies = Get-Dependencies $manifest
  $bundles = Get-Bundles $manifest
  foreach ($plugin in $Selected) {
    $label = $plugin.Name.PadRight(26)
    if (-not $dependencies.ContainsKey($plugin.Name)) { Write-Host "  $label 未安装"; continue }
    $version = ''
    $installedManifest = Join-Path (Join-Path (Join-Path $dir 'node_modules') $plugin.Name) 'package.json'
    if (Test-Path -LiteralPath $installedManifest) {
      $version = 'v' + (Get-Content -LiteralPath $installedManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
    }
    $notes = @()
    if ($bundles -notcontains $plugin.Name) { $notes += '已在 DSH 里停用' }
    if (-not (Test-SpecPointsHere $dependencies[$plugin.Name] $plugin)) { $notes += "来源不是本仓库：$($dependencies[$plugin.Name])" }
    if (Test-CopyCurrent $plugin $ProfileName) { $notes += '与仓库一致' } else { $notes += '与仓库代码不同，需要更新' }
    $line = "  $label 已安装 $version  $($notes -join '；')"
    if ($notes -contains '与仓库一致' -and $notes.Count -eq 1) { Write-Ok $line.Trim() } else { Write-Warn $line.Trim() }
  }
  foreach ($plugin in $Catalog) {
    foreach ($old in $plugin.Legacy) {
      if ($dependencies.ContainsKey($old)) { Write-Warn "残留旧包名 $old（已改名为 $($plugin.Name)），安装时会自动移除" }
    }
  }
}

function Install-Into([string]$ProfileName, $Selected) {
  Write-Step "安装到 $ProfileName"
  $manifest = Read-Manifest $ProfileName
  if (-not $manifest -and $ProfileName -eq 'desktop') {
    Write-Bad 'desktop profile 还没初始化：请先打开一次 DSH 桌面版，再完全退出，然后重新运行本脚本。'
    return $false
  }
  if (-not (Wait-ProfileIdle $ProfileName)) { Write-Warn '已跳过'; return $false }

  $dependencies = Get-Dependencies $manifest
  $bundles = Get-Bundles $manifest

  $legacy = @()
  foreach ($plugin in $Selected) {
    foreach ($old in $plugin.Legacy) { if ($dependencies.ContainsKey($old)) { $legacy += $old } }
  }

  # 已装且来源正确、拷贝与仓库一致、在 DSH 里启用着 → 不动；否则（含被停用的）先移除再添加：
  # 停用的插件 pnpm add 不会重新放回 bundles，用户这次明确要装，就当作重新启用。
  $refresh = @()
  $add = @()
  foreach ($plugin in $Selected) {
    if (-not $dependencies.ContainsKey($plugin.Name)) { $add += $plugin; continue }
    $current = (Test-SpecPointsHere $dependencies[$plugin.Name] $plugin) -and
      ($bundles -contains $plugin.Name) -and (Test-CopyCurrent $plugin $ProfileName)
    if ($current) {
      Write-Ok "$($plugin.Name) 已是最新"
    } else {
      $refresh += $plugin
      $add += $plugin
    }
  }
  if ($legacy.Count -eq 0 -and $add.Count -eq 0) { return $true }

  if ($legacy.Count -gt 0) {
    Write-Host "  移除旧包名：$($legacy -join ', ')"
    if (-not (Invoke-DshPlugin $ProfileName (@('remove') + $legacy))) { Write-Bad '移除旧包名失败'; return $false }
  }
  if ($refresh.Count -gt 0) {
    $names = @($refresh | ForEach-Object { $_.Name })
    Write-Host "  更新：先移除旧拷贝 $($names -join ', ')（cordis.patch.yml 里的插件配置会保留）"
    if (-not (Invoke-DshPlugin $ProfileName (@('remove') + $names))) { Write-Bad '移除旧拷贝失败，profile 未改动'; return $false }
  }
  $specs = @($add | ForEach-Object { "file:$($_.Dir)" })
  if (-not (Invoke-DshPlugin $ProfileName (@('add') + $specs))) {
    Write-Bad '安装失败（详见上面 pnpm / dsh 的输出）。'
    if ($refresh.Count -gt 0) { Write-Bad '注意：要更新的插件已被移除，排除问题后重新运行本脚本即可装回，原有配置不受影响。' }
    return $false
  }
  Write-Ok "已安装：$(($add | ForEach-Object { $_.Name }) -join ', ')"
  return $true
}

function Uninstall-From([string]$ProfileName, $Selected) {
  Write-Step "从 $ProfileName 卸载"
  $manifest = Read-Manifest $ProfileName
  $dependencies = Get-Dependencies $manifest
  $names = @()
  foreach ($plugin in $Selected) {
    foreach ($name in @($plugin.Name) + $plugin.Legacy) { if ($dependencies.ContainsKey($name)) { $names += $name } }
  }
  if ($names.Count -eq 0) { Write-Ok '没有要卸载的插件'; return $true }
  if (-not (Wait-ProfileIdle $ProfileName)) { Write-Warn '已跳过'; return $false }
  if (-not (Invoke-DshPlugin $ProfileName (@('remove') + $names))) { Write-Bad '卸载失败（详见上面的输出）'; return $false }
  Write-Ok "已卸载：$($names -join ', ')"
  Write-Host '  插件在 cordis.patch.yml 里的配置行没有删除，重新安装后沿用；不需要的话可以在 DSH 设置里清理。'
  return $true
}

# ---------- 解析选择 ----------

function Resolve-Plugins([string[]]$Values) {
  $result = @()
  foreach ($value in $Values) {
    foreach ($item in ($value -split ',')) {
      $key = $item.Trim().ToLowerInvariant()
      if ($key -eq '') { continue }
      if ($key -eq 'all') { return $Catalog }
      $match = $Catalog | Where-Object { $_.Name -eq $key -or $_.Alias -eq $key }
      if (-not $match) { throw "未知插件：$item（可选 all、$(($Catalog | ForEach-Object { $_.Alias }) -join '、')）" }
      if ($result -notcontains $match) { $result += $match }
    }
  }
  return $result
}

function Resolve-Profiles([string[]]$Values) {
  $result = @()
  foreach ($value in $Values) {
    foreach ($item in ($value -split ',')) {
      $key = $item.Trim().ToLowerInvariant()
      if ($key -eq '') { continue }
      if ($key -eq 'cli') { $key = 'headless' }
      if ($key -eq 'all') { $result += @($ProfileChoices | ForEach-Object { $_.Name }) }
      elseif ($key -match '[\\/]' -or $key -eq '.' -or $key -eq '..' -or $key -eq 'node_modules') { throw "无效的 profile 名：$item" }
      else { $result += $key }
    }
  }
  return @($result | Select-Object -Unique)
}

try {
  foreach ($plugin in $Catalog) {
    if (-not (Test-Path -LiteralPath (Join-Path $plugin.Dir 'package.json'))) {
      throw "插件目录不存在：$($plugin.Dir)。本脚本需要放在仓库的 scripts\ 目录下运行。"
    }
  }
  $script:Dsh = Resolve-DshCli

  Write-Host "DSH 插件安装脚本   仓库：$RepoRoot"
  Write-Host "DSH_HOME：$(Get-DshHome)"

  if (-not $Action) {
    $Action = @('install', 'uninstall', 'status')[(Read-Choice '要做什么？' @('安装 / 更新', '卸载', '查看安装状态'))]
  }
  if ($Plugins) {
    $selectedPlugins = Resolve-Plugins $Plugins
  } else {
    $pluginOptions = @('全部') + @($Catalog | ForEach-Object { "$($_.Name)（$($_.Title)）" })
    $index = Read-Choice '选择插件：' $pluginOptions
    if ($index -eq 0) { $selectedPlugins = $Catalog } else { $selectedPlugins = @($Catalog[$index - 1]) }
  }
  if ($Profiles) {
    $selectedProfiles = Resolve-Profiles $Profiles
  } else {
    $profileOptions = @($ProfileChoices | ForEach-Object { $_.Title }) + @('全部三个')
    $index = Read-Choice '选择 DSH（profile）：' $profileOptions
    if ($index -eq $ProfileChoices.Count) { $selectedProfiles = @($ProfileChoices | ForEach-Object { $_.Name }) }
    else { $selectedProfiles = @($ProfileChoices[$index].Name) }
  }

  if ($Action -eq 'status') {
    foreach ($target in $selectedProfiles) { Show-Status $target $selectedPlugins }
    exit 0
  }

  $verb = '安装/更新'
  if ($Action -eq 'uninstall') { $verb = '卸载' }
  Write-Host ''
  Write-Host "将要$verb：$(($selectedPlugins | ForEach-Object { $_.Name }) -join ', ')"
  Write-Host "目标 profile：$($selectedProfiles -join ', ')"
  if (-not $Yes -and -not (Read-YesNo '确认执行？')) { Write-Host '已取消'; exit 1 }

  $failed = @()
  foreach ($target in $selectedProfiles) {
    if ($Action -eq 'install') { $ok = Install-Into $target $selectedPlugins } else { $ok = Uninstall-From $target $selectedPlugins }
    if (-not $ok) { $failed += $target }
  }

  Write-Host ''
  if ($failed.Count -gt 0) {
    Write-Bad "未完成的 profile：$($failed -join ', ')"
    exit 1
  }
  Write-Ok '全部完成。重启 DSH 后生效（桌面版要完全退出再打开；dsh web / dsh headless 重新启动即可）。'
  exit 0
} catch {
  Write-Bad $_.Exception.Message
  exit 1
}
