/* 复用宿主的配置表单、持久化与版本检查，不另建配置文件或 HTTP 写入接口；插件更新交给宿主官方接口或 dshmarket。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-presets-zh',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React
    // 顺序与 lib/modes.js 的注册顺序一致；客户端是独立浏览器模块，不能直接导入服务端快照。
    const modes = [
      { key: 'standard', label: '中文标准', id: 'standard-zh', glyph: '标', summary: '标准工具与完整操作说明', context: true },
      { key: 'ptc', label: '中文 PTC', id: 'ptc-zh', glyph: 'P', summary: 'run_code 编排批量工具调用', context: true },
      { key: 'minimal', label: '中文极简', id: 'minimal-zh', glyph: '简', summary: '终端、读图与上下文压缩', context: false },
      { key: 'creation', label: '中文创造', id: 'cordis-zh', glyph: '创', summary: 'Cordis 检查与插件管理', context: true },
    ]
    // 颜色全部取宿主主题变量，跟随明暗主题；回退值只在脱离宿主预览时生效。
    const css = `
.dpz{--dpz-accent:var(--dsw-alias-state-business-primary,#4d6bfe);--dpz-text:var(--dsw-alias-label-primary,currentColor);--dpz-muted:var(--dsw-alias-label-secondary,#8b919c);--dpz-faint:var(--dsw-alias-label-tertiary,#6f7682);--dpz-line:var(--dsw-alias-border-l2,#8883);--dpz-line-strong:var(--dsw-alias-border-l3,#8885);--dpz-surface:var(--dsw-alias-bg-layer-1,transparent);--dpz-base:var(--dsw-alias-bg-base,Canvas);--dpz-hover:var(--dsw-alias-interactive-bg-hover,#8881);--dpz-ok:var(--dsw-alias-state-success-primary,#22c55e);--dpz-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--dpz-error:var(--dsw-alias-state-error-primary,#ef4444);max-width:960px;color:var(--dpz-text);font-size:14px;line-height:1.55}
.dpz *{box-sizing:border-box}
.dpz-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:16px}
.dpz-head h3{margin:0;font-size:18px;font-weight:600}
.dpz-head p{margin:4px 0 0;color:var(--dpz-muted);font-size:13px}
.dpz-count{flex:none;padding:3px 10px;border:1px solid var(--dpz-line);border-radius:999px;color:var(--dpz-muted);font-size:12px;font-variant-numeric:tabular-nums}
.dpz-count b{color:var(--dpz-text);font-weight:600}
.dpz-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px}
.dpz-mode{position:relative;display:flex;border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-md,12px);background:var(--dpz-surface);transition:border-color .15s,background .15s}
.dpz-mode:hover{background:var(--dpz-hover)}
.dpz-mode[data-selected=true]{border-color:var(--dpz-accent);background:color-mix(in srgb,var(--dpz-accent) 9%,var(--dpz-surface))}
.dpz-mode[data-enabled=false] .dpz-glyph,.dpz-mode[data-enabled=false] .dpz-mode-name{opacity:.5}
.dpz-pick{flex:1;min-width:0;display:flex;gap:10px;align-items:flex-start;padding:12px 4px 12px 12px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:inherit}
.dpz-pick:focus-visible,.dpz-btn:focus-visible,.dpz-switch:focus-visible{outline:2px solid var(--dpz-accent);outline-offset:2px}
.dpz-glyph{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--dpz-accent) 16%,transparent);color:var(--dpz-accent);font-weight:700;font-size:14px}
.dpz-glyph.dpz-lg{width:40px;height:40px;font-size:16px;border-radius:10px}
.dpz-mode-text{min-width:0;display:grid;gap:2px}
.dpz-mode-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dpz-mode-sub{color:var(--dpz-faint);font-size:12px;line-height:1.4}
.dpz-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.dpz-badge{padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;color:var(--dpz-muted);background:var(--dpz-hover)}
.dpz-badge[data-tone=warn]{color:var(--dpz-warn);background:color-mix(in srgb,var(--dpz-warn) 14%,transparent)}
.dpz-badge[data-tone=accent]{color:var(--dpz-accent);background:color-mix(in srgb,var(--dpz-accent) 14%,transparent)}
.dpz-switch{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:34px;height:20px;margin:14px 12px 0 0;border-radius:999px;background:var(--dpz-line-strong);cursor:pointer;transition:background .15s}
.dpz-switch::before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0004;transition:transform .15s}
.dpz-switch:checked{background:var(--dpz-accent)}
.dpz-switch:checked::before{transform:translateX(14px)}
.dpz-switch:disabled{opacity:.45;cursor:not-allowed}
.dpz-panel{border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-lg,16px);background:var(--dpz-surface);padding:20px}
.dpz-panel-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--dpz-line)}
.dpz-panel-title{flex:1;min-width:180px}
.dpz-panel-title h4{margin:0;font-size:16px;font-weight:600}
.dpz-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;color:var(--dpz-faint);font-size:12px}
.dpz-meta code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;padding:1px 6px;border-radius:6px;background:var(--dpz-hover);color:var(--dpz-muted)}
.dpz-enable{display:flex;align-items:center;gap:8px;color:var(--dpz-muted);font-size:13px;cursor:pointer}
.dpz-enable .dpz-switch{margin:0}
.dpz-fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:16px}
.dpz-fieldset:disabled{opacity:.6}
.dpz-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.dpz-field{display:grid;gap:6px;min-width:0}
.dpz-label{display:flex;justify-content:space-between;gap:8px;font-size:13px;font-weight:500}
.dpz-label small{color:var(--dpz-faint);font-weight:400;font-size:12px;font-variant-numeric:tabular-nums}
.dpz-input{width:100%;color:inherit;font:inherit;background:var(--dpz-base);border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-sm,8px);padding:8px 11px;transition:border-color .15s,box-shadow .15s}
.dpz-input::placeholder{color:var(--dpz-faint)}
.dpz-input:hover{border-color:var(--dpz-line-strong)}
.dpz-input:focus{outline:none;border-color:var(--dpz-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dpz-accent) 22%,transparent)}
textarea.dpz-input{min-height:168px;resize:vertical;line-height:1.65}
.dpz-hint{color:var(--dpz-faint);font-size:12px}
.dpz-bar{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding:12px 0;background:var(--dpz-base);border-top:1px solid var(--dpz-line)}
.dpz-status{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 240px;color:var(--dpz-muted);font-size:13px}
.dpz-status::before{content:'';flex:none;width:7px;height:7px;border-radius:50%;background:var(--dpz-faint)}
.dpz-status[data-tone=ok]::before{background:var(--dpz-ok)}
.dpz-status[data-tone=warn]::before{background:var(--dpz-warn)}
.dpz-status[data-tone=error]{color:var(--dpz-error)}
.dpz-status[data-tone=error]::before{background:var(--dpz-error)}
.dpz-actions{display:flex;gap:8px;margin-left:auto}
.dpz-btn{height:34px;padding:0 16px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dpz-line-strong);background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,opacity .15s}
.dpz-btn:hover:not(:disabled){background:var(--dpz-hover)}
.dpz-btn:disabled{opacity:.45;cursor:not-allowed}
.dpz-btn.dpz-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dpz-accent));color:var(--dsw-alias-brand-primary-invert,#fff)}
.dpz-btn.dpz-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dpz-accent))}
.dpz-btn.dpz-small{height:30px;padding:0 12px;font-size:12px}
.dpz-btn.dpz-danger{border-color:var(--dpz-error);color:var(--dpz-error)}
.dpz-badge[data-tone=ok]{color:var(--dpz-ok);background:color-mix(in srgb,var(--dpz-ok) 14%,transparent)}
.dpz-update{margin-top:14px;border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-lg,16px);background:var(--dpz-surface);padding:14px 20px}
.dpz-update-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dpz-update-head h4{flex:1;min-width:100px;margin:0;font-size:14px;font-weight:600}
.dpz-line{margin:6px 0 0;color:var(--dpz-muted);font-size:12px;word-break:break-all}
.dpz-line code{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dpz-notice{margin:8px 0 0;font-size:13px;word-break:break-all;color:var(--dpz-ok)}
.dpz-notice[data-tone=error]{color:var(--dpz-error)}
.dpz-update details summary{margin-top:8px;color:var(--dpz-muted);font-size:12px;cursor:pointer}
.dpz-update .dpz-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.dpz-spec{margin-top:8px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
`
    const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
    const fields = [
      { field: 'name', title: '显示名称', hint: '留空使用默认名称' },
      { field: 'description', title: '模式描述', hint: '显示在模式选择列表中' },
    ]

    // 本插件的 npm 包名：官方插件管理器与 dshmarket 都按它定位 profile 中的依赖。
    const PACKAGE_NAME = '@zhiqiangme/dsh-presets-zh'
    // 宿主半侧的版本检查路由（lib/web.js），?force=1 绕过它的 10 分钟缓存。
    const VERSION_PATH = '/plugins/dsh-presets-zh/version'
    // 官方 listVersions 每次要在宿主上跑 1 + 最多 20 次 `pnpm view`，结果按已装版本缓存，时长与 version 路由一致。
    const VERSION_LIST_TTL_MS = 10 * 60 * 1000
    // 官方 updateBundle 经 `plugin-manager/update-state` 报的阶段 → 文案 key。
    const UPDATE_STEPS = { checking: 'checkingTarget', removing: 'removing', installing: 'installing', restoring: 'restoring' }
    // 官方管理结果里算作“已装上”的应用状态；overridden 是已写入 profile、只是启用状态被更高优先级的配置层盖住。
    const APPLIED_STATES = new Set(['applied', 'restart-required', 'overridden'])
    // dshmarket 的公开更新 API v1，只在宿主没有官方更新接口（DSH 0.2.1-rc.5 及更早）时兜底。
    // 只认 capabilities 这个固定入口，其余路径按答复里的 endpoints 走；schema 对不上就当市场不存在。
    const MARKET_CAPABILITIES_PATH = '/dsh-market/api/v1/capabilities'
    const MARKET_SCHEMA = 'dsh-market/update-api/v1'
    const MARKET_DEFAULT_ENDPOINTS = { updates: '/dsh-market/api/v1/updates', operations: '/dsh-market/api/v1/operations', restart: '/dsh-market/api/v1/restart' }
    // pnpm 一次更新通常十几秒，1s 轮询足够跟上进度又不刷屏。
    const POLL_MS = 1000
    // dshmarket 更新本插件时 DSH 可能热重载本 bundle；进行中的任务记在 sessionStorage，重建后接着轮询。
    const OPERATION_STORAGE_KEY = 'dsh-presets-zh:update-operation'
    // dshmarket 认为“可以带 force 重试”的两种失败：发布冷却期未过 / 装完版本没变。
    const FORCEABLE_FAILURES = new Set(['RELEASE_TOO_FRESH', 'VERSION_UNCHANGED'])
    // dshmarket 不更新 file:/link: 本地安装（linked），桌面端自带的 generation 安装也只报版本。
    const MARKET_UNMANAGED_SOURCES = new Set(['linked', 'generation'])
    // DSH 0.2.1 卸载仍启用的 bundle 时会拒绝并报这个错误码，官方更新与 dshmarket 都先卸载再安装。
    const IN_USE = 'bundle-in-use'
    const updateText = {
      title: '插件更新',
      checking: '正在检查更新…',
      check: '检查更新',
      checkFailed: '检查更新失败：{reason}',
      current: '当前运行版本：',
      latest: 'npm 最新版本：',
      upToDate: '已是最新',
      available: '有新版本',
      pendingRestart: '等待重启',
      pendingRefresh: '等待刷新',
      now: '更新到 v{version}',
      noMarket: '当前 DSH 版本还没有官方插件更新接口。装上 DSH 插件市场（dshmarket）后可以在这里一键更新；也可以按下面的指定版本重新安装。',
      linked: '本插件从本地目录安装，请更新源码后重新运行安装脚本。',
      managed: '此安装由 DSH 统一管理，请通过宿主更新。',
      running: '正在更新…',
      progress: '正在更新… {percent}%',
      checkingTarget: '正在核对目标版本…',
      removing: '正在卸载旧版本…',
      installing: '正在安装新版本…',
      restoring: '正在恢复旧版本…',
      startFailed: '没能开始更新：{reason}',
      managerFailed: '官方插件管理器检查失败：{reason}',
      succeeded: '已更新到 v{version}。',
      restartHint: '重启 DSH 后生效。',
      refreshHint: '刷新页面后生效。',
      mismatch: '注意：装上的是 v{installed}，不是预期的 v{target}。',
      restoreFailed: '恢复旧版本失败：{reason}。请在「插件」页检查并重新安装。',
      failed: '更新失败：{reason}',
      inUse: 'DSH 无法在本插件运行时卸下它（bundle-in-use），没有安装新版本，当前版本照常运行。请按下面的指定版本手动重新安装。',
      reselectFailed: 'DSH 拒绝卸载时已把本插件移出启用列表，自动补回失败：{reason}。重启 DSH 前请在「插件」页重新启用本插件。',
      tooFresh: '新版本刚发布，还没过 pnpm 的发布冷却期。可以稍后再试，或强制更新。',
      force: '强制更新',
      noCompatible: '官方插件管理器暂未提供可更新的兼容正式版。',
      notUpdatable: '官方插件管理器不支持更新此安装，请在「插件」页查看安装来源。',
      pinned: '按指定版本安装',
      pinnedHint: '复制下面的包名和版本。在「插件」页本插件详情里先关闭「中文预设」组件，再卸载本插件（插件仍在运行时 DSH 会拒绝卸载），然后在「添加插件」中粘贴安装，装好后重新打开该组件。指定版本可避免 latest 因发布观察期选到旧版。',
      copySpec: '复制包名和版本',
      specCopied: '已复制 {spec}。按上面的步骤卸载后，添加这个指定版本。',
      specCopyFailed: '复制失败，请选中包名和版本手动复制。',
      cancelled: '更新已取消。',
      rolledBack: '更新已回滚，插件保持在 v{version}。',
      unknown: '未能确认更新结果，请检查「插件」页的实际安装版本后重试。',
      lost: '上次的更新任务已经结束或 DSH 已重启，以当前显示的版本为准。',
      restartNow: '立即重启 DSH',
      restarting: '正在重启 DSH…',
      restartFailed: '重启失败：{reason}',
    }
    const t = (key, vars = {}) => updateText[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
    const errorText = error => error instanceof Error ? error.message : String(error)

    /** 调宿主半侧的路由与 dshmarket；状态码与响应体原样交回，市场的 409 / 404 本身就是要展示的结果。 */
    async function fetchJson(path, method = 'GET', body) {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try { payload = await response.json() } catch {}
      return { status: response.status, ok: response.ok, body: payload }
    }

    const marketReason = result => result.body?.failure?.message ?? result.body?.error ?? `HTTP ${result.status}`

    /** remote 调用的结果是 `{ ok, value }` 信封；也兼容直接返回值的实现，失败统一抛 Error。 */
    function unwrap(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok) return response.value
        throw new Error(response.error?.message ?? response.error?.code ?? 'remote call failed')
      }
      return response
    }

    /** 官方管理结果 → 一句可展示的原因：管理错误的诊断，其次 pnpm 失败分类，最后是应用状态本身。 */
    const managementReason = result => result?.error?.diagnostic ?? result?.error?.code ?? result?.packageResult?.kind ?? result?.application ?? 'invalid response'

    /**
     * 官方 updateBundle 的结果 → 任务状态。只有走到安装步骤、宿主报已装上、且装上的正是目标版本才算成功；
     * 带 restore 时再核对装回的是不是原来的版本。
     */
    function officialOutcome(value, target) {
      const result = value?.result
      const application = result?.application
      if (value?.restore) {
        const restored = value.restore
        const restoredOK = APPLIED_STATES.has(restored.application) && restored.version === value.from
        return {
          channel: 'official',
          state: restoredOK ? 'rolled-back' : 'failed',
          installedVersion: restored.version,
          failure: { message: managementReason(result) },
          restoreFailure: restoredOK ? undefined : managementReason(restored),
          outcome: { restartRequired: restored.application === 'restart-required' },
        }
      }
      if (application === 'cancelled') return { channel: 'official', state: 'cancelled' }
      // 宿主在卸载步骤拒绝了运行中的本插件：什么都没装，旧版本照常运行，但启用状态可能已被移出（见 reselect）
      if (value?.step === 'remove' && result?.error?.code === IN_USE) {
        return { channel: 'official', state: 'failed', inUse: true, failure: { message: managementReason(result) } }
      }
      if (value?.step === 'install' && APPLIED_STATES.has(application) && result.version === target) {
        return { channel: 'official', state: 'succeeded', installedVersion: result.version, outcome: { restartRequired: application === 'restart-required' } }
      }
      // 宿主明确报 failed 时原因可信；其余情况（版本不符、停在卸载步骤等）说不清实际装了什么，提示去核对
      return { channel: 'official', state: 'failed', failure: { message: managementReason(result) }, unknown: application !== 'failed' }
    }

    /** dshmarket 把宿主的拒绝原文放进失败信息；它会自己补回被移出的插件行，这里只需认出原因。 */
    const marketInUse = failure => `${failure?.code ?? ''} ${failure?.message ?? ''}`.includes(IN_USE)

    /** 官方更新的 requestId：宿主按它把 update-state 进度与安装日志归到本次调用。 */
    function updateRequestId() {
      if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
      // Web 版也可通过非本机 HTTP 打开；randomUUID 仅限安全上下文，getRandomValues 不受此限。
      const bytes = window.crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
    }

    /** 官方插件管理器的 Remote 命名空间；宿主没有它时 cordis 取值会抛错，这里当作没有。 */
    function pluginManagerOf(remote) {
      try { return remote?.pluginManager } catch { return undefined }
    }

    /** sessionStorage 读写都可能抛（隐私模式、存储被禁），失败就当没有记录。 */
    function readStoredOperation() {
      try {
        const value = JSON.parse(window.sessionStorage.getItem(OPERATION_STORAGE_KEY) ?? 'null')
        return typeof value?.operationId === 'string' ? value : undefined
      } catch { return undefined }
    }

    function storeOperation(value) {
      try {
        if (value) window.sessionStorage.setItem(OPERATION_STORAGE_KEY, JSON.stringify(value))
        else window.sessionStorage.removeItem(OPERATION_STORAGE_KEY)
      } catch {}
    }

    const isActiveOperation = operation => operation?.state === 'queued' || operation?.state === 'running'

    /** `x.y.z` 数字段比较，用来核对实际安装版本与目标 / 最新版本。 */
    function versionBelow(installed, target) {
      const parse = value => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))?.slice(1, 4).map(Number)
      const left = parse(installed)
      const right = parse(target)
      if (!left || !right) return String(installed ?? '') !== String(target ?? '')
      for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index]) return left[index] < right[index]
      }
      return /-/.test(String(installed).split('+')[0]) && !/-/.test(String(target).split('+')[0])
    }

    /** npm 的安装规格用不带 v 的明确版本；拒绝标签、范围和其它安装来源。 */
    function pinnedInstallSpec(version) {
      if (typeof version !== 'string') return undefined
      const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(version.trim())
      return match ? `${PACKAGE_NAME}@${match[1]}` : undefined
    }

    /**
     * 「插件更新」的共享状态与动作，随插件生命周期存在：两处设置页共用一份，挂卸只增减订阅，
     * 不会打断进行中的更新，也不会重复提交。按宿主接口在不在选择更新路，不写死 DSH 版本号：
     *   - 官方：pluginManager 有 listVersions / updateBundle 时，资格、目标版本与注册表都由宿主确定，
     *     锁、卸载、安装与失败恢复也归宿主；
     *   - dshmarket：宿主还没有官方接口时的兜底，按其公开 API v1 提交并轮询任务。
     */
    function createPluginUpdater(remote) {
      let snapshot = { version: { phase: 'loading' }, manager: { phase: 'loading' }, market: { phase: 'idle' }, busy: false }
      const listeners = new Set()
      let checking, updating, pollTimer
      // 最近一次官方版本列表 `{ installed, at, value }`：同一已装版本在 VERSION_LIST_TTL_MS 内复用。
      let versionList
      let disposed = false
      const patch = value => {
        snapshot = { ...snapshot, ...value }
        for (const listener of listeners) listener()
      }

      const loadVersion = async force => {
        try {
          const result = await fetchJson(force ? `${VERSION_PATH}?force=1` : VERSION_PATH)
          if (!result.body) throw new Error(`HTTP ${result.status}`)
          if (!result.ok) throw new Error(result.body.reason ?? `HTTP ${result.status}`)
          patch({ version: { ...result.body, phase: result.body.ok ? 'ready' : 'error' } })
        } catch (error) {
          patch({ version: { ...snapshot.version, phase: 'error', reason: errorText(error) } })
        }
      }

      /** 读宿主的插件列表：安装来源、官方更新资格与实际安装版本。 */
      const readManager = async () => {
        const manager = pluginManagerOf(remote)
        const official = typeof manager?.listVersions === 'function' && typeof manager?.updateBundle === 'function'
        let bundle
        try {
          if (typeof manager?.listBundles === 'function') {
            const bundles = unwrap(await manager.listBundles())
            if (!Array.isArray(bundles)) throw new Error('Invalid bundle list')
            bundle = bundles.find(item => item.name === PACKAGE_NAME)
          }
        } catch (error) {
          // 新宿主上插件列表是更新资格的唯一来源，读不到就如实报错；旧宿主只是少了安装来源，照样走市场兜底
          if (official) throw error
        }
        const state = {
          // source 是 pnpm add 认的规格，本地目录安装以 file: / link: 开头
          local: /^(?:file:|link:)/.test(bundle?.source ?? ''),
          // DSH 自带的官方 bundle 或安装包里的副本，跟着 DSH 版本走
          managed: bundle?.official === true || bundle?.availability === 'installation',
          installedVersion: bundle?.version,
        }
        if (!official) return { ...state, phase: 'unsupported' }
        if (!bundle || bundle.updatable !== true) return { ...state, phase: 'blocked' }
        return { ...state, phase: 'ready' }
      }

      /** 官方版本列表 → 可更新的目标版本。 */
      const listCandidate = async (state, force) => {
        const fresh = versionList?.installed === state.installedVersion && Date.now() - versionList.at < VERSION_LIST_TTL_MS
        if (fresh && !force) return versionList.value
        // npm 已是最新时不列版本，省下宿主上那串 pnpm view；npm 落后于宿主注册表的少见情况，点「检查更新」即可
        if (!force && snapshot.version.phase === 'ready' && !snapshot.version.updateAvailable) return { candidate: undefined }
        const list = unwrap(await pluginManagerOf(remote).listVersions(PACKAGE_NAME, {}))
        if (list?.status === 'refused') {
          if (list.problem === 'not-updatable') return { phase: 'blocked', reason: list.reason }
          throw new Error(list.reason ?? list.problem)
        }
        if (list?.status !== 'listed' || !Array.isArray(list.versions)) throw new Error('Invalid version list')
        // 宿主只列比已装版本新的、按版本倒序；不自动选预发布、弃用或不兼容版本，npm latest 不代表能装
        const candidate = list.versions.find(item => item.bundle === true && item.prerelease === false
          && !item.deprecated && !item.incompatible && pinnedInstallSpec(item.version))
        const value = { installedVersion: list.installed, candidate: candidate?.version, registry: list.registry }
        versionList = { installed: state.installedVersion, at: Date.now(), value }
        return value
      }

      /** 先问一次 dshmarket 本插件的安装来源，免得按钮点下去才失败；问不到时不拦着。 */
      const installSourceOf = async updatesPath => {
        try {
          const result = await fetchJson(`${updatesPath}?name=${encodeURIComponent(PACKAGE_NAME)}`)
          const source = result.status === 200 ? result.body?.package?.source : undefined
          return typeof source === 'string' ? { source, updatable: !MARKET_UNMANAGED_SOURCES.has(source) } : {}
        } catch { return {} }
      }

      /** 热重载后接着轮询原来的市场任务；任务 id 以市场进程的 bootId 开头，对不上说明 DSH 已重启。 */
      const resumeMarketOperation = market => {
        const stored = readStoredOperation()
        if (!stored) return
        if (market.bootId && !stored.operationId.startsWith(`${market.bootId}-`)) return storeOperation(undefined)
        if (snapshot.operation) return
        patch({ target: stored.target, operation: { channel: 'market', operationId: stored.operationId, state: 'running' } })
        pollMarket()
      }

      /** 探测 dshmarket，已探到时不重复问。只在宿主没有官方更新接口时调用。 */
      const probeMarket = async () => {
        if (snapshot.market.phase === 'ready') return
        patch({ market: { phase: 'loading' } })
        let market = { phase: 'absent' }
        try {
          const { status, body } = await fetchJson(MARKET_CAPABILITIES_PATH)
          // 没装 dshmarket 时这条路径由宿主答 404（多半不是 JSON），schema 对不上同样当作不存在
          if (status === 200 && body?.schema === MARKET_SCHEMA && body.features?.update === true) {
            market = {
              phase: 'ready',
              bootId: typeof body.bootId === 'string' ? body.bootId : undefined,
              // 桌面版的重启归桌面壳管，市场会答 supported:false，此时不显示重启按钮
              restartSupported: body.restart?.supported === true,
              endpoints: { ...MARKET_DEFAULT_ENDPOINTS, ...body.endpoints },
            }
            Object.assign(market, await installSourceOf(market.endpoints.updates))
          }
        } catch {
          market = { phase: 'absent' }
        }
        if (disposed) return
        patch({ market })
        if (market.phase === 'ready') resumeMarketOperation(market)
      }

      /** 轮询进行中的市场任务。用 setTimeout 链而不是 setInterval：慢响应时不会叠出并发请求。 */
      const pollMarket = () => {
        clearTimeout(pollTimer)
        const tick = async () => {
          const { operation, market } = snapshot
          const path = market.endpoints?.operations
          if (disposed || !path || operation?.channel !== 'market' || !isActiveOperation(operation)) return
          let result
          try {
            result = await fetchJson(`${path}?operationId=${encodeURIComponent(operation.operationId)}`)
          } catch {
            result = undefined // 网络抖动或宿主正在重载：下一拍再问
          }
          if (disposed || snapshot.operation?.operationId !== operation.operationId) return
          if (result?.status === 404) {
            // 任务记录只活在市场当前进程里，查不到说明进程已经换过
            storeOperation(undefined)
            return patch({ operation: { channel: 'market', state: 'lost' } })
          }
          const next = result?.body?.operation
          if (next && typeof next.state === 'string') {
            // 沿用查询用的 operationId：答复没带它时下一拍也还能接着问同一个任务
            const inUse = next.state === 'failed' && marketInUse(next.failure)
            patch({ operation: { ...next, operationId: operation.operationId, channel: 'market', ...(inUse ? { inUse } : {}) } })
            if (!isActiveOperation(next)) return storeOperation(undefined)
          }
          pollTimer = setTimeout(tick, POLL_MS)
        }
        pollTimer = setTimeout(tick, POLL_MS)
      }

      /**
       * 检查版本与更新途径。quiet 给宿主的插件变更广播用：不把区块切成“正在检查”，只静默重读，
       * 避免在插件页上开关别的插件时这块跟着闪。
       */
      const run = (force, quiet) => {
        if (updating) return updating
        if (checking) return checking
        if (isActiveOperation(snapshot.operation)) return Promise.resolve()
        if (!quiet) {
          // 保留上一次的版本号与安装来源：重新检查时那几行不闪
          patch({ version: { ...snapshot.version, phase: 'loading' }, manager: { ...snapshot.manager, phase: 'loading' }, startFailure: undefined })
        }
        const failure = error => ({ phase: 'error', reason: errorText(error) })
        checking = Promise.all([loadVersion(force), readManager().catch(failure)])
          .then(async ([, state]) => {
            let manager = state
            if (manager.phase === 'ready') {
              try { manager = { ...manager, ...(await listCandidate(manager, force)) } } catch (error) { manager = { ...manager, ...failure(error) } }
            }
            // 外部更新 / 重装之后，旧任务的成功版本不能覆盖刚读到的安装事实；读不到安装版本时不下结论
            const { operation } = snapshot
            const stale = operation?.installedVersion && manager.installedVersion && manager.installedVersion !== operation.installedVersion
            patch({ manager, operation: stale ? undefined : operation })
            if (manager.phase === 'unsupported') await probeMarket()
          })
          .finally(() => { checking = undefined })
        return checking
      }

      /**
       * 宿主卸载前会先把本插件移出启用列表，拒绝时不撤回；不补回的话下次启动 DSH 本插件就不加载了。
       * 只在确实被移出时才动；返回补回失败的原因，成功或无需补回时返回 undefined。
       */
      const reselect = async () => {
        try {
          const manager = pluginManagerOf(remote)
          const bundles = unwrap(await manager.listBundles())
          const bundle = Array.isArray(bundles) ? bundles.find(item => item.name === PACKAGE_NAME) : undefined
          if (!bundle || bundle.enabled !== false) return undefined
          if (typeof manager.setBundleEnabled !== 'function') return 'setBundleEnabled unavailable'
          const result = unwrap(await manager.setBundleEnabled(PACKAGE_NAME, true))
          return APPLIED_STATES.has(result?.application) ? undefined : managementReason(result)
        } catch (error) {
          return errorText(error)
        }
      }

      const startOfficial = (target, registry) => {
        const requestId = updateRequestId()
        patch({ busy: true, target, startFailure: undefined, operation: { channel: 'official', state: 'running', step: 'checking', requestId } })
        // 锁、卸载、安装与失败恢复都交给宿主。只显示本次 requestId 的阶段，不伪造百分比。
        updating = Promise.resolve().then(async () => {
          let off
          try {
            off = remote.$on('plugin-manager/update-state', progress => {
              if (progress.requestId === requestId && UPDATE_STEPS[progress.step]) patch({ operation: { ...snapshot.operation, step: progress.step } })
            })
            const answer = await pluginManagerOf(remote).updateBundle(PACKAGE_NAME, target, { registry, requestId })
            const operation = officialOutcome(unwrap(answer), target)
            if (operation.inUse) {
              const reason = await reselect()
              if (reason) operation.reselectFailure = reason
            }
            const installedVersion = operation.installedVersion ?? snapshot.manager.installedVersion
            patch({ operation, manager: { ...snapshot.manager, installedVersion } })
          } catch (error) {
            // 连接断开不等于宿主取消了安装；不冒充成功，也不自动重试写操作
            patch({ operation: { channel: 'official', state: 'failed', failure: { message: errorText(error) }, unknown: true } })
          } finally {
            if (typeof off === 'function') off()
            // 成功后已装版本变了，失败后宿主给的版本事实也可能变了：下次检查重新列版本
            versionList = undefined
            patch({ busy: false, manager: { ...snapshot.manager, candidate: undefined } })
            updating = undefined
          }
        })
        return updating
      }

      /** dshmarket：提交更新后轮询任务。force 只在市场报了冷却期 / 版本未变之后由用户显式选择。 */
      const startMarket = force => {
        const goal = snapshot.version.latestVersion
        patch({ busy: true, startFailure: undefined, restart: undefined, operation: undefined })
        updating = Promise.resolve().then(async () => {
          try {
            // 市场的公开 v1 API 只接受纯包名，由市场解析并固定版本，不能往 packageName 后拼 @version
            const body = force ? { packageName: PACKAGE_NAME, force: true } : { packageName: PACKAGE_NAME }
            const result = await fetchJson(snapshot.market.endpoints.updates, 'POST', body)
            const next = result.body?.operation
            if (result.status === 202 && typeof next?.operationId === 'string') {
              patch({ target: goal, operation: { ...next, channel: 'market' } })
              storeOperation({ operationId: next.operationId, target: goal })
              pollMarket()
            } else {
              patch({ startFailure: marketReason(result) })
            }
          } catch (error) {
            patch({ startFailure: errorText(error) })
          } finally {
            patch({ busy: false })
            updating = undefined
          }
        })
        return updating
      }

      const startUpdate = (force = false) => {
        if (updating) return updating
        if (checking || isActiveOperation(snapshot.operation)) return Promise.resolve()
        const { manager, market, version } = snapshot
        if (manager.phase === 'ready' && manager.candidate) return startOfficial(manager.candidate, manager.registry)
        // 市场按 npm 最新版解析目标；本地与托管安装它会拒绝，不去提交
        const marketReady = manager.phase === 'unsupported' && market.phase === 'ready' && market.updatable !== false && !manager.local && !manager.managed
        if (marketReady && version.phase === 'ready' && version.updateAvailable) return startMarket(force)
        return Promise.resolve()
      }

      /** dshmarket 的重启：Web 版才支持，桌面版的重启归桌面壳管。 */
      const restart = async () => {
        const path = snapshot.market.endpoints?.restart
        if (!path) return
        patch({ restart: { phase: 'busy' } })
        try {
          const result = await fetchJson(path, 'POST', {})
          patch({ restart: result.ok ? { phase: 'done' } : { phase: 'error', reason: marketReason(result) } })
        } catch {
          // 宿主可能在答复前就开始退出，连接随之断开——这正说明重启已经开始
          patch({ restart: { phase: 'done' } })
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        check: (force = false) => run(force, false),
        refresh: () => run(false, true),
        startUpdate,
        restart,
        dispose: () => {
          disposed = true
          clearTimeout(pollTimer)
        },
      }
    }

    /** 有新版本却没有一键更新时，说明原因的文案 key；还在探测或检查失败时不说。 */
    function updateBlockerKey(manager, market, local, managed) {
      if (local) return 'linked'
      if (managed) return 'managed'
      if (manager.phase === 'blocked') return 'notUpdatable'
      if (manager.phase === 'ready') return 'noCompatible'
      if (manager.phase === 'unsupported' && market.phase === 'absent') return 'noMarket'
      return undefined
    }

    const updateButton = (key, label, onClick, disabled, tone) =>
      h('button', { key, type: 'button', className: `dpz-btn dpz-small${tone ? ` dpz-${tone}` : ''}`, disabled, onClick }, label)
    const updateNotice = (key, value) => value ? h('p', { key, className: 'dpz-notice', 'data-tone': value.tone, role: 'status' }, value.text) : null

    /**
     * 「插件更新」区块的纯渲染。宿主有官方更新接口时，按钮只给宿主确认兼容的正式版（manager.candidate）；
     * 没有时退回 dshmarket，由市场按 npm 最新版解析。都走不通时说明原因，并给出按指定版本重装的规格。
     */
    function renderUpdateSection(update, actions) {
      const { version, manager, market, operation } = update
      const running = Boolean(update.busy) || isActiveOperation(operation)
      const ready = version.phase === 'ready'
      const viaMarket = manager.phase === 'unsupported'
      // 本地目录与 DSH 托管的安装两条更新路都不接，只说明怎么更新
      const local = manager.local === true || market.source === 'linked'
      const managed = manager.managed === true || market.source === 'generation'
      // 当前运行版本要等重启 / 刷新才换，所以按实际安装版本判断是否已装上最新版
      const installed = operation?.state === 'succeeded' ? operation.installedVersion : manager.installedVersion
      const latestInstalled = ready && Boolean(installed) && !versionBelow(installed, version.latestVersion)
      const outdated = ready && version.updateAvailable && !latestInstalled

      let target
      if (manager.phase === 'ready') {
        // 官方路径以宿主列出的兼容正式版为准：npm latest 滞后时不隐藏，已装上的版本不重复给
        if (manager.candidate && (!installed || versionBelow(installed, manager.candidate))) target = manager.candidate
      } else if (viaMarket && market.phase === 'ready' && market.updatable !== false && !local && !managed && outdated) {
        target = version.latestVersion
      }

      const head = [h('h4', { key: 'title' }, t('title'))]
      if (ready) {
        const pending = latestInstalled && operation?.state === 'succeeded' ? operation.outcome : undefined
        const tone = pending?.restartRequired ? ['warn', t('pendingRestart')]
          : pending?.refreshRequired ? ['warn', t('pendingRefresh')]
            : target || outdated ? ['warn', t('available')] : ['ok', t('upToDate')]
        head.push(h('span', { key: 'badge', className: 'dpz-badge', 'data-tone': tone[0] }, tone[1]))
      }
      const checkBusy = version.phase === 'loading' || manager.phase === 'loading' || market.phase === 'loading'
      head.push(updateButton('check', t('check'), actions.checkUpdate, checkBusy || running))
      if (target) head.push(updateButton('update', running ? t('running') : t('now', { version: target }), () => actions.startUpdate(false), running, 'primary'))

      const section = [h('div', { key: 'head', className: 'dpz-update-head' }, ...head)]
      if (version.phase === 'loading') section.push(h('p', { key: 'checking', className: 'dpz-line' }, t('checking')))
      else if (version.phase === 'error') section.push(updateNotice('checkError', { tone: 'error', text: t('checkFailed', { reason: version.reason }) }))
      if (version.currentVersion) {
        section.push(h('p', { key: 'versions', className: 'dpz-line' },
          t('current'), h('code', null, `v${version.currentVersion}`),
          ...(ready ? ['  ·  ', t('latest'), h('code', null, `v${version.latestVersion}`)] : [])))
      }
      if (manager.phase === 'error') section.push(updateNotice('managerError', { tone: 'error', text: t('managerFailed', { reason: manager.reason }) }))
      // 只在确实有新版本时说明为什么没有一键更新；已是最新时不打扰
      const blocker = outdated && !target && !operation ? updateBlockerKey(manager, market, local, managed) : undefined
      if (blocker) section.push(h('p', { key: 'unavailable', className: 'dpz-line' }, t(blocker)))

      if (isActiveOperation(operation)) {
        // 官方接口只报阶段，不伪造百分比；dshmarket 报百分比与 pnpm 输出摘要
        const percent = operation.progress?.percent
        const text = operation.channel === 'official' ? t(UPDATE_STEPS[operation.step] ?? 'running')
          : typeof percent === 'number' ? t('progress', { percent }) : t('running')
        section.push(h('p', { key: 'progress', className: 'dpz-line' }, text))
        if (operation.progress?.detail) section.push(h('p', { key: 'detail', className: 'dpz-line' }, operation.progress.detail))
      } else if (operation?.state === 'succeeded') {
        const parts = [t('succeeded', { version: operation.installedVersion })]
        if (operation.outcome?.restartRequired) parts.push(t('restartHint'))
        else if (operation.outcome?.refreshRequired) parts.push(t('refreshHint'))
        section.push(updateNotice('done', { tone: 'ok', text: parts.join(' ') }))
        // 市场回报成功不等于装上的就是答应的那个版本，客户端自己再核对一次（官方路径成功前已核对）
        if (update.target && versionBelow(operation.installedVersion, update.target)) {
          section.push(updateNotice('mismatch', { tone: 'error', text: t('mismatch', { installed: operation.installedVersion, target: update.target }) }))
        }
        // 只有探测过的 dshmarket 才可能答 restartSupported（Web 版）
        if (operation.outcome?.restartRequired && market.restartSupported) {
          const restartBusy = update.restart?.phase === 'busy' || update.restart?.phase === 'done'
          section.push(h('div', { key: 'restart', className: 'dpz-toolbar' }, updateButton('restart', restartBusy ? t('restarting') : t('restartNow'), actions.restart, restartBusy, 'primary')))
        }
      } else if (operation?.state === 'failed' && operation.inUse) {
        section.push(updateNotice('inUse', { tone: 'error', text: t('inUse') }))
        if (operation.reselectFailure) section.push(updateNotice('reselectFailed', { tone: 'error', text: t('reselectFailed', { reason: operation.reselectFailure }) }))
      } else if (operation?.state === 'failed') {
        const code = operation.failure?.code
        section.push(updateNotice('failed', { tone: 'error', text: code === 'RELEASE_TOO_FRESH' ? t('tooFresh') : t('failed', { reason: operation.failure?.message ?? code ?? '' }) }))
        if (operation.restoreFailure) section.push(updateNotice('restoreFailed', { tone: 'error', text: t('restoreFailed', { reason: operation.restoreFailure }) }))
        if (operation.unknown) section.push(updateNotice('unknown', { tone: 'error', text: t('unknown') }))
        if (FORCEABLE_FAILURES.has(code)) section.push(h('div', { key: 'force', className: 'dpz-toolbar' }, updateButton('force', t('force'), () => actions.startUpdate(true), running, 'danger')))
      } else if (operation?.state === 'cancelled') {
        section.push(updateNotice('cancelled', { tone: 'error', text: t('cancelled') }))
      } else if (operation?.state === 'rolled-back') {
        // 官方路径带上失败原因与恢复后是否要重启；dshmarket 的回滚只报保持的版本
        const parts = []
        if (operation.failure?.message) parts.push(t('failed', { reason: operation.failure.message }))
        parts.push(t('rolledBack', { version: operation.installedVersion }))
        if (operation.outcome?.restartRequired) parts.push(t('restartHint'))
        section.push(updateNotice('rolledBack', { tone: 'error', text: parts.join(' ') }))
      } else if (operation?.state === 'lost') {
        section.push(updateNotice('lost', { tone: 'ok', text: t('lost') }))
      }
      if (update.startFailure) section.push(updateNotice('startFailed', { tone: 'error', text: t('startFailed', { reason: update.startFailure }) }))

      // 官方接口在且已给出结论时不建议绕过它的更新资格；宿主拒绝卸载运行中的本插件时只能手动重装
      const spec = outdated ? pinnedInstallSpec(version.latestVersion) : undefined
      if (spec && !running && !local && !managed && (viaMarket || manager.phase === 'error' || operation?.inUse)) {
        // 没有任何一键更新、卸载被拒、市场报了冷却期 / 版本未变、或装上的仍低于最新版时自动展开
        const open = (viaMarket && market.phase === 'absent') || operation?.inUse === true
          || FORCEABLE_FAILURES.has(operation?.failure?.code) || operation?.state === 'succeeded'
        section.push(h('details', { key: 'pinned', open },
          h('summary', null, t('pinned')),
          h('p', { className: 'dpz-line' }, t('pinnedHint')),
          h('input', { className: 'dpz-input dpz-spec', type: 'text', readOnly: true, value: spec, 'aria-label': t('pinned'), onFocus: event => event.currentTarget.select() }),
          h('div', { className: 'dpz-toolbar' }, updateButton('copySpec', t('copySpec'), actions.copyInstallSpec, false))))
      }
      if (update.restart?.phase === 'error') section.push(updateNotice('restartError', { tone: 'error', text: t('restartFailed', { reason: update.restart.reason }) }))
      section.push(updateNotice('copyNotice', update.notice))
      return section
    }

    /** 接到共享的更新器上：状态与进行中的任务都在 updater 里，这里只多管一条复制规格的提示。 */
    function UpdatePanel({ updater }) {
      const update = useSyncExternalStore(listener => updater.subscribe(listener), () => updater.getSnapshot())
      const [notice, setNotice] = useState(null)
      // 版本路由与官方版本列表都有缓存，挂载时不强制重查
      useEffect(() => { updater.check() }, [updater])
      const actions = {
        checkUpdate: () => {
          setNotice(null)
          return updater.check(true)
        },
        startUpdate: force => {
          setNotice(null)
          return updater.startUpdate(force)
        },
        restart: () => updater.restart(),
        copyInstallSpec: async () => {
          const spec = pinnedInstallSpec(update.version.latestVersion)
          if (!spec) return
          try {
            await window.navigator.clipboard.writeText(spec)
            setNotice({ tone: 'ok', text: t('specCopied', { spec }) })
          } catch {
            setNotice({ tone: 'error', text: t('specCopyFailed') })
          }
        },
      }
      return h('div', { className: 'dpz-update', role: 'region', 'aria-label': t('title') }, ...renderUpdateSection({ ...update, notice }, actions))
    }

    function ModeSettings({ form, view, updater }) {
      const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [revision, setRevision] = useState()
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [selected, setSelected] = useState(modes[0].key)
      useEffect(() => {
        if (!dirty && snapshot.value) {
          setDraft(structuredClone(snapshot.value))
          setRevision(snapshot.revision)
        }
      }, [snapshot.value, snapshot.revision, dirty])

      if (view === 'summary') return h('span', null, '四种中文模式，各自启用并设置提示词。')
      if (!draft) return h('p', { role: 'status' }, snapshot.status === 'error' ? '配置读取失败，请重新打开插件设置。' : '正在读取模式配置…')

      const change = (key, field, value) => {
        setDraft(previous => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
        setDirty(true)
        setNotice(null)
      }
      const reload = () => {
        setDraft(structuredClone(snapshot.value))
        setRevision(snapshot.revision)
        setDirty(false)
        setNotice(null)
      }
      const reset = key => {
        setDraft(previous => ({ ...previous, [key]: structuredClone(snapshot.base[key]) }))
        setDirty(true)
        setNotice({ tone: 'warn', text: '默认内容已填入，点击保存后生效。' })
      }
      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          // 绑定开始编辑时的版本；其他页面写入后须重新载入，不能覆盖较新的设置。
          const accepted = await form.mutate(modes.map(({ key }) => ({ op: 'set', path: [key], value: draft[key] })), revision)
          if (accepted) {
            setDirty(false)
            setNotice({ tone: 'ok', text: '已保存。新会话使用新设置；已有会话可切换模式后使用。' })
          } else setNotice({ tone: 'error', text: '未保存，配置可能已在其他页面更新。请重新载入后再编辑。' })
        } catch (error) {
          setNotice({ tone: 'error', text: `保存失败：${error.message}` })
        } finally { setBusy(false) }
      }

      const readonly = busy || !snapshot.writable
      const enabledCount = modes.filter(({ key }) => draft[key]?.enabled !== false).length
      const status = notice
        ?? (!snapshot.writable ? { tone: 'error', text: '当前配置为只读，无法保存。' }
          : dirty ? { tone: 'warn', text: '有未保存的更改' } : { tone: 'idle', text: '设置与已保存内容一致' })
      const mode = modes.find(item => item.key === selected) ?? modes[0]
      const value = draft[mode.key] ?? {}
      const base = snapshot.base?.[mode.key] ?? {}

      const toggle = (key, label) => h('input', {
        type: 'checkbox', role: 'switch', className: 'dpz-switch', 'aria-label': `启用${label}`,
        checked: draft[key]?.enabled !== false, disabled: readonly,
        onChange: event => change(key, 'enabled', event.target.checked),
      })
      const card = ({ key, label, glyph, summary }) => {
        const enabled = draft[key]?.enabled !== false
        const badges = [
          !enabled && h('span', { key: 'off', className: 'dpz-badge' }, '已停用'),
          !same(draft[key], snapshot.value[key]) && h('span', { key: 'dirty', className: 'dpz-badge', 'data-tone': 'warn' }, '未保存'),
          !same(draft[key], snapshot.base?.[key]) && h('span', { key: 'custom', className: 'dpz-badge', 'data-tone': 'accent' }, '已自定义'),
        ].filter(Boolean)
        return h('div', { key, className: 'dpz-mode', 'data-selected': String(key === mode.key), 'data-enabled': String(enabled) },
          h('button', { type: 'button', role: 'tab', 'aria-selected': key === mode.key, 'data-mode': key, className: 'dpz-pick', onClick: () => setSelected(key) },
            h('span', { className: 'dpz-glyph', 'aria-hidden': true }, glyph),
            h('span', { className: 'dpz-mode-text' },
              h('span', { className: 'dpz-mode-name' }, draft[key]?.name?.trim() || label),
              h('span', { className: 'dpz-mode-sub' }, summary),
              badges.length ? h('span', { className: 'dpz-badges' }, ...badges) : null)),
          toggle(key, label))
      }

      return h('section', { className: 'dpz' },
        h('style', null, css),
        h('header', { className: 'dpz-head' },
          h('div', null,
            h('h3', null, '中文预设'),
            h('p', null, '选择模式后编辑，修改后点击保存。标准、PTC 和创造模式保留 AGENTS.md 与技能原文。')),
          h('span', { className: 'dpz-count' }, '已启用 ', h('b', null, String(enabledCount)), ' / 4')),
        h('div', { className: 'dpz-modes', role: 'tablist', 'aria-label': '中文预设模式' }, ...modes.map(card)),
        h('div', { className: 'dpz-panel', role: 'tabpanel', 'aria-label': mode.label },
          h('div', { className: 'dpz-panel-head' },
            h('span', { className: 'dpz-glyph dpz-lg', 'aria-hidden': true }, mode.glyph),
            h('div', { className: 'dpz-panel-title' },
              h('h4', null, mode.label),
              h('div', { className: 'dpz-meta' },
                h('code', null, mode.id),
                h('span', null, mode.context ? '保留 AGENTS.md 与 Skills' : '不注入 AGENTS.md 与 Skills'))),
            h('label', { className: 'dpz-enable' }, toggle(mode.key, mode.label), '启用此模式')),
          h('fieldset', { className: 'dpz-fieldset', disabled: readonly },
            h('div', { className: 'dpz-row' }, ...fields.map(({ field, title, hint }) => h('label', { key: field, className: 'dpz-field' },
              h('span', { className: 'dpz-label' }, title),
              h('input', { className: 'dpz-input', value: value[field] ?? '', placeholder: base[field] || hint, onChange: event => change(mode.key, field, event.target.value) })))),
            h('label', { className: 'dpz-field' },
              h('span', { className: 'dpz-label' }, '系统提示词', h('small', null, `${(value.prompt ?? '').length} 字`)),
              h('textarea', { className: 'dpz-input', rows: 8, value: value.prompt ?? '', placeholder: base.prompt, onChange: event => change(mode.key, 'prompt', event.target.value) }),
              h('span', { className: 'dpz-hint' }, mode.context
                ? '作为角色前缀；工具、团队、MCP 等操作说明仍由当前组合动态组装并汉化。留空使用默认内容。'
                : '中文极简只使用这段提示词。留空使用默认内容。')),
            h('div', null,
              h('button', { type: 'button', className: 'dpz-btn dpz-small', disabled: same(value, base), onClick: () => reset(mode.key) }, '恢复此模式默认设置')))),
        h('div', { className: 'dpz-bar' },
          h('p', { className: 'dpz-status', role: 'status', 'aria-live': 'polite', 'data-tone': status.tone, style: { margin: 0 } }, status.text),
          h('div', { className: 'dpz-actions' },
            h('button', { type: 'button', className: 'dpz-btn', disabled: busy, onClick: reload }, '重新载入'),
            h('button', { type: 'button', className: 'dpz-btn dpz-primary', disabled: readonly || !dirty, onClick: save }, busy ? '保存中…' : '保存设置'))),
        updater ? h(UpdatePanel, { updater }) : null)
    }

    function apply(ctx) {
      const form = ctx.configForms.get('dsh-presets-zh')
      // 更新器跟插件同生共死：两处设置页共用；插件卸载时停掉市场任务的轮询
      const updater = createPluginUpdater(ctx.remote)
      ctx.effect(() => () => updater.dispose())
      // 插件管理器每完成一次操作就广播 changed（含官方插件页的「更新」），据此静默重读安装状态；
      // 宿主没有这个事件时不该连累设置页注册失败。
      ctx.effect(() => {
        try {
          return ctx.remote.$on('plugin-manager/changed', () => updater.refresh())
        } catch {
          return () => {}
        }
      })
      for (const [slot, key] of [
        ['plugins.bundle.config', '@zhiqiangme/dsh-presets-zh'],
        ['plugins.row.config', '@zhiqiangme/dsh-presets-zh#dsh-presets-zh'],
      ]) ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: 30, inject: () => ({ form, updater }) }, ModeSettings))
    }
    // pluginManager 不单独声明：旧宿主没有它也要能加载设置页，缺席时更新区块退回市场或手动重装。
    return { name: 'minimal-prompt-settings', inject: ['slots', 'configForms', 'remote'], apply, ModeSettings, UpdatePanel, renderUpdateSection, createPluginUpdater, pinnedInstallSpec }
  },
})
