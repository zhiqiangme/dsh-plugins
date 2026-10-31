/* 「极简提示词」插件页的插件更新卡片：版本检查走宿主路由，更新交给宿主官方接口或 dshmarket。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-preset-minimal-prompt',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React
    // 颜色全部取宿主主题变量，跟随明暗主题；回退值只在脱离宿主预览时生效。
    const css = `
.dmp-update{--dmp-accent:var(--dsw-alias-state-business-primary,#4d6bfe);--dmp-text:var(--dsw-alias-label-primary,currentColor);--dmp-muted:var(--dsw-alias-label-secondary,#8b919c);--dmp-faint:var(--dsw-alias-label-tertiary,#6f7682);--dmp-line:var(--dsw-alias-border-l2,#8883);--dmp-line-strong:var(--dsw-alias-border-l3,#8885);--dmp-surface:var(--dsw-alias-bg-layer-1,transparent);--dmp-base:var(--dsw-alias-bg-base,Canvas);--dmp-hover:var(--dsw-alias-interactive-bg-hover,#8881);--dmp-ok:var(--dsw-alias-state-success-primary,#22c55e);--dmp-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--dmp-error:var(--dsw-alias-state-error-primary,#ef4444);max-width:960px;box-sizing:border-box;color:var(--dmp-text);font-size:14px;line-height:1.55;border:1px solid var(--dmp-line);border-radius:var(--dsw-radius-lg,16px);background:var(--dmp-surface);padding:14px 20px}
.dmp-update *{box-sizing:border-box}
.dmp-update-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dmp-update-head h4{flex:1;min-width:100px;margin:0;font-size:14px;font-weight:600}
.dmp-badge{padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;color:var(--dmp-muted);background:var(--dmp-hover)}
.dmp-badge[data-tone=warn]{color:var(--dmp-warn);background:color-mix(in srgb,var(--dmp-warn) 14%,transparent)}
.dmp-badge[data-tone=ok]{color:var(--dmp-ok);background:color-mix(in srgb,var(--dmp-ok) 14%,transparent)}
.dmp-btn{height:30px;padding:0 12px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dmp-line-strong);background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background .15s,opacity .15s}
.dmp-btn:hover:not(:disabled){background:var(--dmp-hover)}
.dmp-btn:disabled{opacity:.45;cursor:not-allowed}
.dmp-btn:focus-visible{outline:2px solid var(--dmp-accent);outline-offset:2px}
.dmp-btn.dmp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dmp-accent));color:var(--dsw-alias-brand-primary-invert,#fff)}
.dmp-btn.dmp-danger{border-color:var(--dmp-error);color:var(--dmp-error)}
.dmp-line{margin:6px 0 0;color:var(--dmp-muted);font-size:12px;word-break:break-all}
.dmp-line code{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dmp-notice{margin:8px 0 0;font-size:13px;word-break:break-all;color:var(--dmp-ok)}
.dmp-notice[data-tone=error]{color:var(--dmp-error)}
.dmp-update details summary{margin-top:8px;color:var(--dmp-muted);font-size:12px;cursor:pointer}
.dmp-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.dmp-input{width:100%;color:inherit;font:inherit;background:var(--dmp-base);border:1px solid var(--dmp-line);border-radius:var(--dsw-radius-sm,8px);padding:8px 11px}
.dmp-spec{margin-top:8px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
`

    // 本插件的 npm 包名：官方插件管理器与 dshmarket 都按它定位 profile 中的依赖。
    const PACKAGE_NAME = '@zhiqiangme/dsh-preset-minimal-prompt'
    // 宿主半侧的版本检查路由（lib/web.js），?force=1 绕过它的 10 分钟缓存。
    const VERSION_PATH = '/plugins/dsh-preset-minimal-prompt/version'
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
    const OPERATION_STORAGE_KEY = 'dsh-preset-minimal-prompt:update-operation'
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
      pinnedHint: '复制下面的包名和版本。在「插件」页本插件详情里先关闭「极简提示词」组件，再卸载本插件（插件仍在运行时 DSH 会拒绝卸载），然后在「添加插件」中粘贴安装，装好后重新打开该组件。指定版本可避免 latest 因发布观察期选到旧版。',
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
     * 「插件更新」的共享状态与动作，随插件生命周期存在：插件包页与行设置页共用一份，挂卸只增减订阅，
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
      h('button', { key, type: 'button', className: `dmp-btn dmp-small${tone ? ` dmp-${tone}` : ''}`, disabled, onClick }, label)
    const updateNotice = (key, value) => value ? h('p', { key, className: 'dmp-notice', 'data-tone': value.tone, role: 'status' }, value.text) : null

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
        head.push(h('span', { key: 'badge', className: 'dmp-badge', 'data-tone': tone[0] }, tone[1]))
      }
      const checkBusy = version.phase === 'loading' || manager.phase === 'loading' || market.phase === 'loading'
      head.push(updateButton('check', t('check'), actions.checkUpdate, checkBusy || running))
      if (target) head.push(updateButton('update', running ? t('running') : t('now', { version: target }), () => actions.startUpdate(false), running, 'primary'))

      const section = [h('div', { key: 'head', className: 'dmp-update-head' }, ...head)]
      if (version.phase === 'loading') section.push(h('p', { key: 'checking', className: 'dmp-line' }, t('checking')))
      else if (version.phase === 'error') section.push(updateNotice('checkError', { tone: 'error', text: t('checkFailed', { reason: version.reason }) }))
      if (version.currentVersion) {
        section.push(h('p', { key: 'versions', className: 'dmp-line' },
          t('current'), h('code', null, `v${version.currentVersion}`),
          ...(ready ? ['  ·  ', t('latest'), h('code', null, `v${version.latestVersion}`)] : [])))
      }
      if (manager.phase === 'error') section.push(updateNotice('managerError', { tone: 'error', text: t('managerFailed', { reason: manager.reason }) }))
      // 只在确实有新版本时说明为什么没有一键更新；已是最新时不打扰
      const blocker = outdated && !target && !operation ? updateBlockerKey(manager, market, local, managed) : undefined
      if (blocker) section.push(h('p', { key: 'unavailable', className: 'dmp-line' }, t(blocker)))

      if (isActiveOperation(operation)) {
        // 官方接口只报阶段，不伪造百分比；dshmarket 报百分比与 pnpm 输出摘要
        const percent = operation.progress?.percent
        const text = operation.channel === 'official' ? t(UPDATE_STEPS[operation.step] ?? 'running')
          : typeof percent === 'number' ? t('progress', { percent }) : t('running')
        section.push(h('p', { key: 'progress', className: 'dmp-line' }, text))
        if (operation.progress?.detail) section.push(h('p', { key: 'detail', className: 'dmp-line' }, operation.progress.detail))
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
          section.push(h('div', { key: 'restart', className: 'dmp-toolbar' }, updateButton('restart', restartBusy ? t('restarting') : t('restartNow'), actions.restart, restartBusy, 'primary')))
        }
      } else if (operation?.state === 'failed' && operation.inUse) {
        section.push(updateNotice('inUse', { tone: 'error', text: t('inUse') }))
        if (operation.reselectFailure) section.push(updateNotice('reselectFailed', { tone: 'error', text: t('reselectFailed', { reason: operation.reselectFailure }) }))
      } else if (operation?.state === 'failed') {
        const code = operation.failure?.code
        section.push(updateNotice('failed', { tone: 'error', text: code === 'RELEASE_TOO_FRESH' ? t('tooFresh') : t('failed', { reason: operation.failure?.message ?? code ?? '' }) }))
        if (operation.restoreFailure) section.push(updateNotice('restoreFailed', { tone: 'error', text: t('restoreFailed', { reason: operation.restoreFailure }) }))
        if (operation.unknown) section.push(updateNotice('unknown', { tone: 'error', text: t('unknown') }))
        if (FORCEABLE_FAILURES.has(code)) section.push(h('div', { key: 'force', className: 'dmp-toolbar' }, updateButton('force', t('force'), () => actions.startUpdate(true), running, 'danger')))
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
          h('p', { className: 'dmp-line' }, t('pinnedHint')),
          h('input', { className: 'dmp-input dmp-spec', type: 'text', readOnly: true, value: spec, 'aria-label': t('pinned'), onFocus: event => event.currentTarget.select() }),
          h('div', { className: 'dmp-toolbar' }, updateButton('copySpec', t('copySpec'), actions.copyInstallSpec, false))))
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
      return h('div', { className: 'dmp-update', role: 'region', 'aria-label': t('title') }, ...renderUpdateSection({ ...update, notice }, actions))
    }

    /** 插件页卡片：本插件没有可编辑设置，只提供插件更新；summary 视图只给一句说明。 */
    function UpdateCard({ updater, view }) {
      if (view === 'summary') return h('span', null, '精简系统提示词的中文预设。')
      return h('section', null, h('style', null, css), h(UpdatePanel, { updater }))
    }

    function apply(ctx) {
      // 更新器跟插件同生共死：两处挂载共用；插件卸载时停掉市场任务的轮询
      const updater = createPluginUpdater(ctx.remote)
      ctx.effect(() => () => updater.dispose())
      // 插件管理器每完成一次操作就广播 changed（含官方插件页的「更新」），据此静默重读安装状态；
      // 宿主没有这个事件时不该连累卡片注册失败。
      ctx.effect(() => {
        try {
          return ctx.remote.$on('plugin-manager/changed', () => updater.refresh())
        } catch {
          return () => {}
        }
      })
      for (const [slot, key] of [
        ['plugins.bundle.config', '@zhiqiangme/dsh-preset-minimal-prompt'],
        ['plugins.row.config', '@zhiqiangme/dsh-preset-minimal-prompt#dsh-preset-minimal-prompt'],
      ]) ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: 30, inject: () => ({ updater }) }, UpdateCard))
    }
    // pluginManager 不单独声明：旧宿主没有它也要能加载卡片，缺席时更新区块退回市场或手动重装。
    return { name: 'minimal-prompt-update', inject: ['slots', 'remote'], apply, UpdateCard, UpdatePanel, renderUpdateSection, createPluginUpdater, pinnedInstallSpec }
  },
})
