/**
 * 浏览器半侧：DSH「插件」页里的 WorkBuddy 模型卡片。
 *
 * 为什么手写而不是过打包器：本插件是 file: 挂载的私有包，仓库里没有构建链。
 * DSH 的客户端模块加载器只要求这个文件按 `__ModuleLoader__.load({ id, factory })`
 * 注册一个 Cordis 插件（导出 name / inject / apply），React 由 factory 的 require 提供
 * （react 在平台的 seed 模块表里），所以直接写一份可读的 JS 即可，改完不用构建。
 *
 * 卡片挂在哪（与 Trae / Qoder 同款）：
 *   - `plugins.bundle.config`：key = npm 包名，显示在组合包页面的描述与组件列表之间；
 *   - `plugins.row.config`：key = `<包名>#<行 id>`，给本插件那一行一个"配置"入口。
 * 两处共用同一个组件。key 必须逐字等于包名，写错不会报错——只是卡片不出现。
 *
 * 数据从哪来：宿主半侧（lib/web.js）开的两条 loopback 路由。页面自己够不到
 * 127.0.0.1:7863（跨源 + 无 CORS），也改不了 profile 里的白名单；而 DSH 的
 * configForms 通道要求宿主半侧声明带 .volatile() 的 schemastery Config，
 * 本插件刻意不引这个依赖，所以走自建路由。
 *
 * 后端网关（"后端版本"区最上面）：wb2api / workbuddy2api-hub 二选一，切换写本插件的 config.gateway。
 *
 * 插件更新（卡片最底部，与上面"后端版本"那块无关——那块管后端网关，这块管本插件自己）：
 * 版本检查走宿主半侧的 version 路由（问 npm）；一键更新交给 dshmarket 的公开更新 API v1，
 * 装了市场才有按钮，没装只提示有新版本，本插件不自己跑 pnpm。
 *
 * 样式：全部自带（data-plugin-css 标记，避免重复注入），类名统一 `dsm-wb-*`，
 * 颜色只取 `--dsw-alias-*` 令牌，跟随主题。刻意不借用其它插件注入的类名
 * （Trae/Qoder 的 `dsm-btn` / `dsm-plugin-card` 是它们自己的 CSS，不是宿主全局类）。
 */

// 模块 id 必须是 npm 包名：宿主的客户端模块表按包名登记，对不上就加载不到本 bundle。
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-autostart-workbuddy',
  factory: (require) => {
    // ModuleLoader 的 factory 只注入 require；这里自行建立 CommonJS 导出对象，
    // 与 DSH 其它客户端 bundle 的包装约定一致。
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    /**
     * 宿主 UI 组件（primitives 在客户端的 seed 模块表里）。只取 Modal 做"二次确认"弹窗；
     * 拿不到就退回卡片内的行内确认——不能因为一个可选依赖让整块卡片加载失败。
     */
    let Modal;
    try {
      Modal = require('@deepseek-ai/dsh-client-ui-primitives')?.Modal;
    } catch {
      Modal = undefined;
    }

    const name = 'dsh-autostart-workbuddy-client';
    const inject = ['slots', 'locale'];
    const namespace = 'settings.dsh-autostart-workbuddy';
    /** 与 lib/web.js 的两个端点必须一致。 */
    const MODELS_PATH = '/plugins/dsh-autostart-workbuddy/models';
    const BACKEND_PATH = '/plugins/dsh-autostart-workbuddy/backend';
    /**
     * 后端管理面板地址的兜底值。宿主会在 /backend 的应答里给出真实地址
     * （host/port 可被 profile 覆盖），拿不到时才用这个。
     */
    const DEFAULT_PANEL_URL = 'http://127.0.0.1:7863/panel';
    /** 宿主半侧的控制台访问密钥路由（lib/web.js）：POST 才给，点「复制访问密钥」时取一次。 */
    const PANEL_KEY_PATH = '/plugins/dsh-autostart-workbuddy/panel-key';

    /** 本插件的 npm 包名：dshmarket 按它定位要更新的依赖。 */
    const PACKAGE_NAME = '@zhiqiangme/dsh-autostart-workbuddy';
    /** 宿主半侧的版本检查路由（lib/web.js），?force=1 绕过它的 10 分钟缓存。 */
    const VERSION_PATH = '/plugins/dsh-autostart-workbuddy/version';
    /**
     * dshmarket 的公开更新 API v1（其包内 UPDATE-API-V1.md）。只认 capabilities 这一个固定入口，
     * 其余路径按它答复里的 endpoints 走；答复的 schema 对不上就当市场不存在，不去猜旧路由。
     */
    const MARKET_CAPABILITIES_PATH = '/dsh-market/api/v1/capabilities';
    const MARKET_SCHEMA = 'dsh-market/update-api/v1';
    const MARKET_DEFAULT_ENDPOINTS = {
      updates: '/dsh-market/api/v1/updates',
      operations: '/dsh-market/api/v1/operations',
      restart: '/dsh-market/api/v1/restart',
    };
    /** 轮询更新任务的间隔：pnpm 一次更新通常十几秒，1s 足够跟上进度又不刷屏。 */
    const POLL_MS = 1000;
    /**
     * 进行中的更新任务记在 sessionStorage：更新本插件自己时 DSH 可能热重载本 bundle，
     * 卡片会被卸下再挂上，靠它接着轮询同一个任务，而不是丢掉进度。
     */
    const OPERATION_STORAGE_KEY = 'dsh-autostart-workbuddy:update-operation';
    /** dshmarket 认为"可以带 force 重试"的两种失败：发布冷却期未过 / 装完版本没变。 */
    const FORCEABLE_FAILURES = new Set(['RELEASE_TOO_FRESH', 'VERSION_UNCHANGED']);

    /** 后端动作 → 成功后的提示文案 key。 */
    const BACKEND_NOTICE = {
      start: 'backendStarted',
      install: 'backendInstalled',
      update: 'backendUpdated',
      rollback: 'backendRolledBack',
      uninstall: 'backendUninstalled',
      purge: 'backendPurged',
    };

    /** 模型区失败状态（lib/web.js 的 BACKEND_NOT_INSTALLED）：后端没装，提示去点「安装」。 */
    const BACKEND_NOT_INSTALLED = 'backend-not-installed';
    /** 模型区失败状态（lib/web.js 的 BACKEND_NO_ACCOUNTS）：hub 在跑但账号池是空的。 */
    const BACKEND_NO_ACCOUNTS = 'backend-no-accounts';
    /** 切换网关后等新网关就绪的上限与间隔：hub 冷启动（自带 Python）实测 2~5 秒，留足余量。 */
    const GATEWAY_WAIT_MS = 60_000;
    const GATEWAY_POLL_MS = 1_000;

    const CSS = `
.dsm-wb-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;padding:14px 16px}
.dsm-wb-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-wb-desc{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-wb-panel{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
/* 外链用 DSH 自己那套：http(s) + target=_blank，宿主主窗口的 setWindowOpenHandler
   会把它交给 shell.openExternal，即默认浏览器打开。 */
.dsm-wb-link{color:var(--dsw-alias-state-business-primary,#5686fe);text-decoration:none;cursor:pointer}
.dsm-wb-link:hover{text-decoration:underline}
.dsm-wb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 8px}
.dsm-wb-count{flex:1;min-width:120px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-wb-sync{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;cursor:pointer}
.dsm-wb-sync input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-wb-btn:disabled{cursor:default}
/* 主按钮用"反色"配色，不用 --dsw-alias-brand-primary 当底色：本主题把
   brand-primary 定义成 --dsw-alias-label-primary（深色模式下 #f9fafb，接近纯白），
   拿它当背景再配白字就是白底白字。label-primary 当底 + bg-layer-3 当字，
   明暗两种主题都成立（Trae 的 .dsm-btn-primary 也是这个写法）。 */
.dsm-wb-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-wb-btn-primary:hover:not(:disabled){opacity:.88}
.dsm-wb-btn-outline{background:transparent;border-color:var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-wb-btn-outline:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 禁用态给明确的弱化配色，而不是整体降透明度——降透明度会把文字一起洗掉，
   深色主题下就变成"看不清字"的灰块。 */
.dsm-wb-btn-primary:disabled{background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-dimmed,#8a8f99);border-color:var(--dsw-alias-border-l2,#36373b)}
.dsm-wb-btn-outline:disabled{color:var(--dsw-alias-label-dimmed,#8a8f99)}
.dsm-wb-list{display:flex;flex-direction:column;gap:2px;max-height:340px;overflow:auto;padding:2px 0}
.dsm-wb-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;cursor:pointer}
.dsm-wb-row:hover{background:var(--dsw-alias-bg-layer-2,#25262b)}
.dsm-wb-row input{margin:0;flex:none;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-wb-meta{flex:none;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.dsm-wb-credits{flex:none;font-variant-numeric:tabular-nums;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;padding:1px 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-wb-credits-free{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.dsm-wb-tag{flex:none;border-radius:6px;padding:1px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-wb-hint{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
.dsm-wb-notice{margin:8px 0 0;font-size:13px;line-height:1.6}
.dsm-wb-notice-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dsm-wb-notice-error{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-wb-empty{padding:12px 0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px}
.dsm-wb-panel-key{margin-left:8px;padding:1px 10px;font-size:12px}
.dsm-wb-key{display:inline-block;margin-left:4px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#e6e6e6);user-select:all;word-break:break-all}
.dsm-wb-path{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;word-break:break-all}
.dsm-wb-backend{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-wb-backend-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-wb-gateway{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-wb-backend-title{flex:1;min-width:100px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:1.5}
.dsm-wb-backend-line{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6;word-break:break-all}
.dsm-wb-backend-line strong{color:var(--dsw-alias-label-secondary,#c6c9d0);font-weight:500}
.dsm-wb-badge{flex:none;border-radius:6px;padding:1px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-wb-badge-new{color:var(--dsw-alias-state-warning-primary,#d29922);border-color:currentColor}
.dsm-wb-badge-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
/* 危险动作（卸载）用错误色描边；不做成实心红，避免误点。 */
.dsm-wb-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-wb-btn-danger:hover:not(:disabled){background:rgba(217,45,32,.12)}
.dsm-wb-confirm{margin-top:10px;border:1px solid var(--dsw-alias-state-warning-primary,#d29922);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#25262b);padding:12px 14px}
.dsm-wb-confirm-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:1.5}
.dsm-wb-confirm-body{margin-top:4px}
`;

    // 字典值必须是**字符串**：DSH 的 t(key, params) 用 `{name}` 占位符插值
    // （见 @deepseek-ai/dsh-client-locale 的 bind）。放函数会让 t() 返回函数本身，
    // React 拿它当 child 直接抛错，整块卡片从页面上消失——这个坑已经踩过一次。
    const zh = {
      title: 'WorkBuddy 模型列表',
      description: '勾选要出现在 DSH 模型列表里的模型；倍率取自后端 /v1/models。',
      summary: '由插件接管 WorkBuddy 的模型列表（勾选 + 倍率）。',
      loading: '正在读取后端模型…',
      modelsNotInstalled: '后端还没有安装。请点下方「后端版本」里的「安装」，装好后模型列表会自动刷新。',
      modelsNoAccounts: 'hub 里还没有可用账号（共 {total} 个，可用 0），模型暂时用不了，所以这里不列出来。请打开上方后端面板登录或导入 WorkBuddy 账号，再点「重试」。',
      retry: '重试',
      selectAll: '全部勾选',
      clearAll: '全部取消',
      refresh: '刷新',
      save: '保存',
      saveSync: '保存并同步',
      syncEnabled: '同步到 DSH 模型列表',
      syncHint: '开启后，打开或刷新此列表会同步到 DSH；后台默认每分钟自动同步。',
      saving: '保存中…',
      count: '后端共 {total} 个模型，已勾选 {picked} 个',
      vision: '视觉',
      emptyBackend: '后端没有返回任何模型。',
      emptyHint: '一个都没勾 = 同步后端全部模型（白名单留空的既有语义）。',
      disabledHint: '模型同步已关闭，保存只更新勾选结果。勾选“同步到 DSH 模型列表”并保存，即可生成模型清单。',
      savedSync: '已保存，并已重新生成模型清单：{count} 个模型。',
      savedNoSync: '已保存白名单；模型清单未更新（{state}）。',
      savedDisabled: '已保存，同步已关闭；保留现有 DSH 模型列表。',
      saveFailed: '保存失败。',
      patchPath: '写入目标：{path}',
      panelHint: '后端面板：',
      panelKeyCopy: '复制访问密钥',
      panelKeyWorking: '读取中…',
      panelKeyCopied: '已复制访问密钥：打开后端面板，粘贴到「需要访问密钥」的弹窗里即可，浏览器会记住。',
      panelKeyManual: '没能写入剪贴板，请手动选中复制：',
      panelKeyNone: '后端没有设置访问密钥，打开面板无需输入。',
      backendTitle: '后端版本',
      backendCurrent: '当前 {version}',
      backendLatest: '上游 {tag}',
      backendUpToDate: '已是最新',
      backendAvailable: '可更新到 {tag}',
      backendCheck: '检查更新',
      backendUpdate: '更新',
      backendRollback: '回滚',
      backendWorking: '处理中…',
      backendUpdated: '已更新到 {tag}，健康检查通过。',
      backendRolledBack: '已回滚到 {tag}。',
      backendUnmanaged: '未纳管',
      backendNoHistory: '历史版本：无',
      backendHistory: '历史版本：{list}',
      backendBuilt: '构建于 {time}',
      backendInstall: '安装',
      backendUninstall: '卸载',
      backendInstalled: '后端已安装 {tag}。',
      backendNoAccounts: '后端已启动，但还没有可用的 WorkBuddy 账号，请打开上面的后端面板登录。',
      backendStarted: '后端已启动。',
      recoveryStatus: '自动恢复：{state}（本窗口已尝试 {attempts} 次）',
      recoveryIdle: '待命', recoveryWaiting: '等待重试', recoveryRestarting: '正在重启', recoveryRecovered: '已恢复', recoveryExhausted: '连续失败，已暂停',
      recoveryRetry: '重试启动',
      diagnose: '一键诊断', diagnoseCopy: '复制脱敏报告', diagnoseCopied: '诊断报告已复制', diagnoseWorking: '正在诊断…',
      backendUninstalled: '后端已卸载（config.json 与 data/ 已保留）。',
      backendUninstalledHub: 'hub 已卸载（hub/data/ 已保留）。',
      autoUpdateLabel: '自动更新后端',
      autoUpdateHint: '后台下载发布满 {hours} 小时的正式版，下次启动 DSH 时安装；新版本起不来会自动退回原版本。',
      autoUpdateUnavailable: '后端程序是在配置里自己指定的（或关了版本管理），插件不管它的版本，自动更新不生效。',
      autoUpdatePending: '已下载 {tag}，下次启动 DSH 时自动安装。',
      autoUpdateLast: '{time} 已自动从 {from} 更新到 {to}；有问题可点「回滚」。',
      autoUpdateFailed: '自动更新到 {tag} 没成功（{reason}），原版本照常在用；这个版本不再自动安装，需要的话手动点「更新」。',
      autoUpdateRolledBack: '你从 {tag} 回滚过，自动更新会跳过它，等下一个新版本。',
      autoUpdateWaiting: '上游 {tag} 发布未满 {hours} 小时，{time} 之后自动下载。',
      autoUpdateDrifted: '当前后端程序被手动换过，自动更新不会覆盖它。',
      autoUpdateUnknown: '认不出当前后端的版本号，自动更新不生效；可以手动点「更新」。',
      autoUpdateError: '上次自动检查更新失败：{reason}',
      gatewayTitle: '后端网关',
      gatewayWb2api: 'wb2api（默认）',
      gatewayHub: 'workbuddy2api-hub',
      gatewaySwitching: '切换中…',
      gatewaySwitched: '已切换到 {name}。',
      gatewayWaiting: '正在切换到 {name}，等它启动…',
      gatewayNotInstalled: '已切换到 {name}，但它还没安装：请在下方点「安装」。',
      gatewayTimeout: '已切换到 {name}，但 {seconds} 秒内没等到它就绪；稍后可点模型区的「重试」或「刷新」。',
      gatewayHubHint: 'hub 一次只服务一个出口（国内 / 国际），跟随 hub 看板顶部的出口开关。CN 与 GL 的勾选分开保存（与 wb2api 的 cn: / global: 共用），在看板切换出口后，DSH 的模型列表几秒内自动换成那一组。',
      hubRealm: 'hub 当前出口：{realm}。这里勾的是 {realm} 这一组；切到另一个出口后，DSH 自动换成那一组的勾选（从没勾过就是全部）。',
      panelPasswordCopy: '复制面板密码',
      panelPasswordCopied: '已复制 hub 的默认面板密码 admin：打开后端面板粘贴即可；登录后建议在看板「设置」里改掉。',
      panelPasswordChanged: 'hub 的面板密码已经改过：hub 只存它的哈希，插件读不到明文，请用你自己设的密码登录。',
      uninstallHubTitle: '卸载 hub？',
      uninstallHubDesc: '会停止 hub，并删除程序目录（含自带的 Python 运行时）、历史版本与下载缓存。',
      uninstallHubKept: 'hub 的账号凭证、设置与用量（hub/data/）会保留。',
      uninstallHubConfirm: '确认卸载',
      cancel: '取消',
      uninstallTitle: '卸载后端？',
      uninstallDesc: '会停止后端，并删除程序文件：wb2api.exe、历史版本、下载缓存。',
      uninstallKept: '账号凭证与状态（data/）以及 config.json 会保留。',
      uninstallConfirm: '确认卸载',
      backendPurge: '彻底卸载',
      backendPurgeHint: 'DSH 卸载本插件时不会删除 {root}；卸载插件前先点「彻底卸载」即可清干净。',
      backendPurged: '已清除 {root}，现在可以去「插件」页卸载本插件。',
      purgeTitle: '彻底卸载后端？',
      purgeDesc: '会停止后端，并删除 {root} 整个目录：程序、历史版本、config.json、账号凭证与状态（data/）、缓存和日志。',
      purgeKept: '无法撤销。之后想继续用，需要重新安装后端并重新登录账号。',
      purgeConfirm: '确认彻底卸载',
      updateTitle: '插件更新',
      updateChecking: '正在检查更新…',
      updateCheck: '检查更新',
      updateCheckFailed: '检查更新失败：{reason}',
      updateCurrent: '当前运行版本：',
      updateLatestVersion: 'npm 最新版本：',
      updateUpToDate: '已是最新',
      updateAvailable: '有新版本',
      updatePendingRestart: '等待重启',
      updatePendingRefresh: '等待刷新',
      updateNow: '更新到 v{version}',
      updateNoMarket: '装上 DSH 插件市场（dshmarket）后可以在这里一键更新；也可以在「插件」页卸载本插件，再重新安装新版。',
      updateLinked: '本插件是从本地目录（file:）安装的，dshmarket 不更新本地安装。请在源码目录拉取新代码后重新安装；改为从 npm 安装后，才能在这里一键更新。',
      updateManaged: '本插件由 DSH 桌面端统一管理，dshmarket 不会更新它。请在「插件」页卸载后重新安装新版。',
      updateRunning: '正在更新…',
      updateProgress: '正在更新… {percent}%',
      updateStartFailed: '没能开始更新：{reason}',
      updateSucceeded: '已更新到 v{version}。',
      updateRestartHint: '重启 DSH 后生效。',
      updateRefreshHint: '刷新页面后生效。',
      updateMismatch: '注意：装上的是 v{installed}，不是预期的 v{target}。',
      updateFailed: '更新失败：{reason}',
      updateTooFresh: '新版本刚发布，还没过 pnpm 的发布冷却期。可以稍后再试，或强制更新。',
      updateForce: '强制更新',
      updateCancelled: '更新已取消。',
      updateRolledBack: '更新已回滚，插件保持在 v{version}。',
      updateLost: '上次的更新任务已经结束或 DSH 已重启，以当前显示的版本为准。',
      restartNow: '立即重启 DSH',
      restarting: '正在重启 DSH…',
      restartFailed: '重启失败：{reason}',
    };

    const en = {
      title: 'WorkBuddy models',
      description: 'Tick the models that should appear in the DSH model list; the multiplier comes from the backend /v1/models.',
      summary: 'This plugin manages the WorkBuddy model list (selection + multiplier).',
      loading: 'Reading models from the backend…',
      modelsNotInstalled: 'The backend is not installed yet. Click "Install" under "Backend version" below; the model list refreshes once it is installed.',
      modelsNoAccounts: 'The hub has no usable account yet ({total} total, 0 usable), so its models cannot be used and are not listed. Sign in or import a WorkBuddy account in the backend panel above, then click "Retry".',
      retry: 'Retry',
      selectAll: 'Select all',
      clearAll: 'Clear all',
      refresh: 'Refresh',
      save: 'Save',
      saveSync: 'Save and sync',
      syncEnabled: 'Sync to the DSH model list',
      syncHint: 'When enabled, opening or refreshing this list syncs it to DSH; background sync runs every minute by default.',
      saving: 'Saving…',
      count: '{total} models on the backend, {picked} selected',
      vision: 'vision',
      emptyBackend: 'The backend returned no models.',
      emptyHint: 'Selecting nothing means “sync every backend model” (the existing meaning of an empty allow-list).',
      disabledHint: 'Model sync is off; saving only updates the selection. Enable “Sync to the DSH model list” and save to generate the list.',
      savedSync: 'Saved and regenerated the model list: {count} models.',
      savedNoSync: 'Allow-list saved; the model list was not updated ({state}).',
      savedDisabled: 'Saved with sync off; the existing DSH model list is kept.',
      saveFailed: 'Save failed.',
      patchPath: 'Written to: {path}',
      panelHint: 'Panel: ',
      panelKeyCopy: 'Copy access key',
      panelKeyWorking: 'Reading…',
      panelKeyCopied: 'Access key copied: open the panel and paste it into the “access key” prompt; the browser remembers it.',
      panelKeyManual: 'Could not write to the clipboard; select and copy it manually: ',
      panelKeyNone: 'The backend has no access key set; the panel opens without one.',
      backendTitle: 'Backend version',
      backendCurrent: 'current {version}',
      backendLatest: 'upstream {tag}',
      backendUpToDate: 'up to date',
      backendAvailable: 'update to {tag} available',
      backendCheck: 'Check',
      backendUpdate: 'Update',
      backendRollback: 'Roll back',
      backendWorking: 'Working…',
      backendUpdated: 'Updated to {tag}; health check passed.',
      backendRolledBack: 'Rolled back to {tag}.',
      backendUnmanaged: 'unmanaged',
      backendNoHistory: 'History: none',
      backendHistory: 'History: {list}',
      backendBuilt: 'built {time}',
      backendInstall: 'Install',
      backendUninstall: 'Uninstall',
      backendInstalled: 'Backend installed: {tag}.',
      backendNoAccounts: 'The backend is running but has no usable WorkBuddy account yet; sign in from the backend panel above.',
      backendStarted: 'Backend started.',
      recoveryStatus: 'Recovery: {state} ({attempts} attempts in this window)',
      recoveryIdle: 'Ready', recoveryWaiting: 'Waiting', recoveryRestarting: 'Restarting', recoveryRecovered: 'Recovered', recoveryExhausted: 'Paused after repeated failures',
      recoveryRetry: 'Retry start',
      diagnose: 'Diagnose', diagnoseCopy: 'Copy redacted report', diagnoseCopied: 'Report copied', diagnoseWorking: 'Diagnosing…',
      backendUninstalled: 'Backend uninstalled (config.json and data/ kept).',
      backendUninstalledHub: 'Hub uninstalled (hub/data/ kept).',
      autoUpdateLabel: 'Update the backend automatically',
      autoUpdateHint: 'Stable releases older than {hours} hours are downloaded in the background and installed the next time DSH starts; if the new version fails to start, the previous one is restored.',
      autoUpdateUnavailable: 'The backend executable is set in your config (or version management is off), so the plugin does not manage its version and automatic updates do not apply.',
      autoUpdatePending: '{tag} is downloaded and will be installed the next time DSH starts.',
      autoUpdateLast: 'Automatically updated from {from} to {to} at {time}; click "Roll back" if something is wrong.',
      autoUpdateFailed: 'The automatic update to {tag} did not succeed ({reason}); the previous version is still in use. This version will not be installed automatically again; click "Update" to install it by hand.',
      autoUpdateRolledBack: 'You rolled back from {tag}; automatic updates skip it and wait for the next release.',
      autoUpdateWaiting: 'Upstream {tag} is less than {hours} hours old; it will be downloaded after {time}.',
      autoUpdateDrifted: 'The backend executable was replaced by hand; automatic updates will not overwrite it.',
      autoUpdateUnknown: 'The current backend version cannot be identified, so automatic updates do not apply; you can still click "Update".',
      autoUpdateError: 'The last automatic update check failed: {reason}',
      gatewayTitle: 'Gateway',
      gatewayWb2api: 'wb2api (default)',
      gatewayHub: 'workbuddy2api-hub',
      gatewaySwitching: 'Switching…',
      gatewaySwitched: 'Switched to {name}.',
      gatewayWaiting: 'Switching to {name}, waiting for it to start…',
      gatewayNotInstalled: 'Switched to {name}, but it is not installed yet: click "Install" below.',
      gatewayTimeout: 'Switched to {name}, but it was not ready within {seconds} s; try "Retry" or "Refresh" in the model list later.',
      gatewayHubHint: 'The hub serves one exit at a time (China or international), following the exit switch at the top of the hub dashboard. CN and GL selections are saved separately (shared with wb2api\'s cn: / global: ids); after you switch the exit in the dashboard, the DSH model list changes to that set within seconds.',
      hubRealm: 'Current hub exit: {realm}. You are choosing the {realm} set; after switching to the other exit, DSH uses that exit\'s own selection (all of its models if you never chose any).',
      panelPasswordCopy: 'Copy panel password',
      panelPasswordCopied: "Copied the hub's default panel password admin: paste it in the backend panel; consider changing it under Settings after signing in.",
      panelPasswordChanged: "The hub's panel password has been changed: the hub stores only its hash, so the plugin cannot read it. Sign in with the password you set.",
      uninstallHubTitle: 'Uninstall the hub?',
      uninstallHubDesc: 'Stops the hub and deletes its program directory (including the bundled Python runtime), archived versions and download cache.',
      uninstallHubKept: "The hub's credentials, settings and usage (hub/data/) are kept.",
      uninstallHubConfirm: 'Uninstall',
      cancel: 'Cancel',
      uninstallTitle: 'Uninstall the backend?',
      uninstallDesc: 'Stops the backend and deletes its program files: wb2api.exe, archived versions, download cache.',
      uninstallKept: 'Credentials and state (data/) plus config.json are kept.',
      uninstallConfirm: 'Uninstall',
      backendPurge: 'Fully uninstall',
      backendPurgeHint: 'Uninstalling this plugin in DSH does not delete {root}; click "Fully uninstall" first to remove it.',
      backendPurged: 'Cleared {root}. You can now uninstall this plugin on the Plugins page.',
      purgeTitle: 'Fully uninstall the backend?',
      purgeDesc: 'Stops the backend and deletes the whole {root} directory: program, archived versions, config.json, credentials and state (data/), cache and logs.',
      purgeKept: 'This cannot be undone. To use it again you will need to reinstall the backend and sign in to your accounts again.',
      purgeConfirm: 'Fully uninstall',
      updateTitle: 'Plugin update',
      updateChecking: 'Checking for updates…',
      updateCheck: 'Check for updates',
      updateCheckFailed: 'Update check failed: {reason}',
      updateCurrent: 'Running version: ',
      updateLatestVersion: 'Latest on npm: ',
      updateUpToDate: 'up to date',
      updateAvailable: 'update available',
      updatePendingRestart: 'waiting for restart',
      updatePendingRefresh: 'waiting for reload',
      updateNow: 'Update to v{version}',
      updateNoMarket: 'Install the DSH plugin market (dshmarket) to update from here, or uninstall this plugin on the Plugins page and install the new version.',
      updateLinked: 'This plugin is installed from a local directory (file:), which dshmarket does not update. Pull the new code in the source directory and reinstall, or reinstall it from npm to update from here.',
      updateManaged: 'This plugin is managed by the DSH desktop app, so dshmarket will not update it. Uninstall it on the Plugins page and install the new version.',
      updateRunning: 'Updating…',
      updateProgress: 'Updating… {percent}%',
      updateStartFailed: 'Could not start the update: {reason}',
      updateSucceeded: 'Updated to v{version}.',
      updateRestartHint: 'Restart DSH to apply it.',
      updateRefreshHint: 'Reload the page to apply it.',
      updateMismatch: 'Note: v{installed} was installed, not the expected v{target}.',
      updateFailed: 'Update failed: {reason}',
      updateTooFresh: 'The new version is still inside pnpm\'s release cool-down. Try again later, or force the update.',
      updateForce: 'Force update',
      updateCancelled: 'Update cancelled.',
      updateRolledBack: 'Update rolled back; the plugin stays at v{version}.',
      updateLost: 'The previous update task has finished or DSH restarted; the version shown here is current.',
      restartNow: 'Restart DSH now',
      restarting: 'Restarting DSH…',
      restartFailed: 'Restart failed: {reason}',
    };

    function ensureStyle() {
      const id = `${name}/client.css`;
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = name;
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 调宿主半侧的路由；HTTP 层的失败也翻成 Error，交给卡片显示。 */
    async function request(path, method, body) {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!payload) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw new Error(payload.reason ?? `HTTP ${response.status}`);
      return payload;
    }

    /** 区域排序：cn 在前、global 在后（与 profile 里模型清单的既有排布一致）。 */
    function regionRank(id) {
      if (id.startsWith('cn:')) return 0;
      if (id.startsWith('global:')) return 1;
      return 2;
    }

    /** 面板的展示顺序：区域（cn → global → 其它），区域内保持后端返回顺序。 */
    function sortRows(rows) {
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => regionRank(a.row.id) - regionRank(b.row.id) || a.index - b.index)
        .map((entry) => entry.row);
    }

    /**
     * 保存用的白名单：按面板展示顺序排，而不是勾选的先后。
     *
     * 白名单的顺序就是 DSH 模型选择器里的展示顺序（见 models.js 的 planModelEntries）；
     * 用 Set 的插入顺序会让"取消再勾上"的模型跑到最后，每改一次顺序就漂一次。
     */
    function orderedSelection(rows, picked) {
      const visible = new Set(rows.map((row) => row.id));
      return sortRows(rows)
        .filter((row) => picked.has(row.id))
        .map((row) => row.id)
        // 网络故障时不可见的已选模型仍属于用户白名单，恢复后要能自动回到 DSH。
        .concat([...picked].filter((id) => !visible.has(id)));
    }

    function formatTokens(value) {
      if (!value) return undefined;
      if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`;
      if (value >= 1000) return `${Math.round(value / 1000)}K`;
      return String(value);
    }

    function sameSet(a, b) {
      if (a.size !== b.size) return false;
      for (const item of a) if (!b.has(item)) return false;
      return true;
    }

    /**
     * 卸载 / 清除数据的二次确认。优先用宿主的 Modal（真弹窗，走 portal）；拿不到宿主组件就退回
     * 卡片内的行内确认——两种形态都保证"再点一次才真的删"。
     *
     * kind 决定文案前缀（uninstall* / purge*），params 给文案插值（如 {root}）。
     */
    /** 模型区失败原因的显示文本：已知状态码翻成本地化提示，其余原样显示宿主给的原因。 */
    function errorReasonText(reason, meta, t) {
      if (reason === BACKEND_NOT_INSTALLED) return t('modelsNotInstalled');
      if (reason === BACKEND_NO_ACCOUNTS) return t('modelsNoAccounts', { total: meta?.accounts ?? 0 });
      return reason;
    }

    /**
     * 切换网关后等新网关接管：后端快照的 gateway 变成目标（插件已按新配置重启、路由换成新一轮的），
     * 并且模型区能答（拉到目录，或明确报"账号池为空"——网关本身已经在跑）。
     * 新网关没装就不必等了。重启期间路由会短暂 404 / 连不上，都按"还没好"继续等。
     * @returns {Promise<'ready' | 'not-installed' | 'timeout'>}
     */
    async function waitForGateway(gateway, { waitMs = GATEWAY_WAIT_MS, pollMs = GATEWAY_POLL_MS, sleep } = {}) {
      const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        try {
          const snapshot = (await request(BACKEND_PATH, 'GET')).backend ?? {};
          if (snapshot.gateway === gateway) {
            if (snapshot.exeExists === false) return 'not-installed';
            const models = await request(MODELS_PATH, 'GET');
            if (models.ok || models.state === BACKEND_NO_ACCOUNTS) return 'ready';
          }
        } catch {
          /* 重启中：下一轮再看 */
        }
        await pause(pollMs);
      }
      return 'timeout';
    }

    function renderUninstallConfirm({ t, Modal, h, onCancel, onConfirm, kind: action = 'uninstall', textKind, params }) {
      const kind = textKind ?? action;
      const cancel = h(
        'button',
        { key: 'cancel', type: 'button', className: 'dsm-wb-btn dsm-wb-btn-outline', onClick: onCancel },
        t('cancel'),
      );
      const confirm = h(
        'button',
        { key: 'confirm', type: 'button', className: 'dsm-wb-btn dsm-wb-btn-danger', onClick: onConfirm },
        t(`${kind}Confirm`, params),
      );
      const detail = h(
        'div',
        { className: 'dsm-wb-confirm-body' },
        h('p', { className: 'dsm-wb-hint' }, t(`${kind}Desc`, params)),
        h('p', { className: 'dsm-wb-hint' }, t(`${kind}Kept`, params)),
      );

      if (typeof Modal === 'function') {
        return h(
          Modal,
          {
            key: 'confirm',
            open: true,
            onClose: onCancel,
            title: t(`${kind}Title`, params),
            description: t(`${kind}Desc`, params),
            footer: [cancel, confirm],
          },
          detail,
        );
      }
      return h(
        'div',
        { key: 'confirm', className: 'dsm-wb-confirm' },
        h('div', { className: 'dsm-wb-confirm-title' }, t(`${kind}Title`, params)),
        detail,
        h('div', { className: 'dsm-wb-toolbar' }, cancel, confirm),
      );
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function wbButton(key, kind, label, onClick, disabled) {
      return h('button', { key, type: 'button', className: `dsm-wb-btn dsm-wb-btn-${kind}`, disabled, onClick }, label);
    }

    function wbNotice(key, value) {
      if (!value) return null;
      return h(
        'p',
        { key, className: `dsm-wb-notice ${value.kind === 'error' ? 'dsm-wb-notice-error' : 'dsm-wb-notice-ok'}` },
        value.text,
      );
    }

    /**
     * 调 dshmarket 的 v1 API。与 request() 分开：市场的失败体是 `{ error, failure }` 而不是 `{ reason }`，
     * 409 / 404 这类状态码本身就是要展示的结果，所以这里不抛，原样交回状态码与响应体。
     */
    async function marketRequest(path, method, body) {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      return { status: response.status, body: payload };
    }

    /**
     * dshmarket 只一键更新从 npm / git 装的插件。file:/link: 的本地目录安装（source 'linked'）它会直接拒绝
     * （"locally linked plugins update from their checkout"），桌面端自带的 generation 安装也只报版本、不给更新。
     * 所以先问一次本插件的安装来源，免得按钮点下去才失败。问不到（市场报错、网络抖动）时不拦着，
     * 真点了失败也还有失败提示兜底。
     */
    const MARKET_UNMANAGED_SOURCES = new Set(['linked', 'generation']);

    async function installSourceOf(updatesPath) {
      try {
        const result = await marketRequest(`${updatesPath}?name=${encodeURIComponent(PACKAGE_NAME)}`, 'GET');
        const source = result.status === 200 ? result.body?.package?.source : undefined;
        if (typeof source !== 'string') return {};
        return { source, updatable: !MARKET_UNMANAGED_SOURCES.has(source) };
      } catch {
        return {};
      }
    }

    /** 市场失败体 → 一句可展示的原因。 */
    function marketReason(result) {
      return result.body?.failure?.message ?? result.body?.error ?? `HTTP ${result.status}`;
    }

    /** sessionStorage 读写都可能抛（隐私模式、存储被禁），失败就当没有记录。 */
    function readStoredOperation() {
      try {
        const value = JSON.parse(window.sessionStorage.getItem(OPERATION_STORAGE_KEY) ?? 'null');
        return typeof value?.operationId === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    }

    function storeOperation(value) {
      try {
        if (value) window.sessionStorage.setItem(OPERATION_STORAGE_KEY, JSON.stringify(value));
        else window.sessionStorage.removeItem(OPERATION_STORAGE_KEY);
      } catch {
        /* 存不下只是少了"重挂后接着轮询"，不影响本次更新 */
      }
    }

    /** `x.y.z` 数字段比较（与 lib/update.js 同口径的简化版，用来核对实际安装版本与目标/最新版本）。 */
    function versionBelow(installed, target) {
      const parse = (value) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))?.slice(1, 4).map(Number);
      const left = parse(installed);
      const right = parse(target);
      if (!left || !right) return String(installed ?? '') !== String(target ?? '');
      for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] < right[index];
      }
      return false;
    }

    function isActiveOperation(operation) {
      return operation?.state === 'queued' || operation?.state === 'running';
    }

    /** ISO 时间 → 本地时间文本；解析不了就原样给出。 */
    function localTime(iso) {
      const time = Date.parse(iso ?? '');
      return Number.isFinite(time) ? new Date(time).toLocaleString() : String(iso ?? '');
    }

    /**
     * 「后端版本」区里的自动更新开关与状态（纯渲染）。老宿主的快照没有 autoUpdate 字段，返回空数组。
     *
     * @param {object | undefined} auto 宿主 /backend 快照里的 autoUpdate（见 lib/auto-update.js 的 autoUpdateStatus）
     * @param {string | null} currentTag 当前后端版本
     * @param {{ busy?: boolean, onToggle: (enabled: boolean) => void }} options
     */
    function renderAutoUpdate(auto, currentTag, { busy, onToggle }, t) {
      if (!auto) return [];
      const out = [
        h(
          'label',
          { key: 'autoUpdate', className: 'dsm-wb-sync' },
          h('input', {
            type: 'checkbox',
            checked: auto.enabled === true,
            disabled: Boolean(busy) || auto.available === false,
            onChange: (event) => onToggle(event.target.checked),
          }),
          t('autoUpdateLabel'),
        ),
        h('p', { key: 'autoUpdateHint', className: 'dsm-wb-hint' }, t(auto.available === false ? 'autoUpdateUnavailable' : 'autoUpdateHint', { hours: auto.delayHours ?? 24 })),
      ];
      if (auto.enabled !== true || auto.available === false) return out;

      const line = (key, text) => h('p', { key, className: 'dsm-wb-backend-line' }, text);
      if (auto.last?.to && auto.last.to === currentTag) {
        out.push(line('autoUpdateLast', t('autoUpdateLast', { time: localTime(auto.last.at), from: auto.last.from ?? '?', to: auto.last.to })));
      }
      if (auto.pending?.tag) {
        out.push(line('autoUpdatePending', t('autoUpdatePending', { tag: auto.pending.tag })));
        return out;
      }
      // 手动装上了失败过的那个版本，就不再提它。
      if (auto.failed?.tag && auto.failed.tag !== currentTag) {
        out.push(wbNotice('autoUpdateFailed', { kind: 'error', text: t('autoUpdateFailed', { tag: auto.failed.tag, reason: auto.failed.reason || auto.failed.state || '' }) }));
      }
      const check = auto.lastCheck;
      if (check?.state === 'error') {
        out.push(line('autoUpdateCheck', t('autoUpdateError', { reason: check.reason ?? '' })));
      } else if (check?.state === 'skipped') {
        const key = {
          'rolled-back': 'autoUpdateRolledBack',
          'too-fresh': 'autoUpdateWaiting',
          drifted: 'autoUpdateDrifted',
          'unknown-local': 'autoUpdateUnknown',
        }[check.reason];
        if (key) out.push(line('autoUpdateCheck', t(key, { tag: check.tag ?? '', hours: auto.delayHours ?? 24, time: localTime(check.readyAt) })));
      }
      return out;
    }

    /**
     * 「插件更新」区块的纯渲染（与后端版本区同款排版）。
     * version / market 缺省时按"读取中"处理：首屏和测试替身里 hooks 状态可能还是 undefined。
     *
     * @param {{ version?: object, market?: object, operation?: object, target?: string, notice?: object, busy?: boolean, restart?: object }} update
     */
    function renderUpdateSection(update, actions, t) {
      const version = update.version ?? { phase: 'loading' };
      const market = update.market ?? { phase: 'loading' };
      const operation = update.operation;
      const running = Boolean(update.busy) || isActiveOperation(operation);
      const ready = version.phase === 'ready';

      // 当前运行版本要等重启/刷新才换；仅当实际安装版本覆盖当前查到的最新版时，
      // 才用成功结果覆盖徽章。镜像落后或再查到更高版本时，仍需提供更新入口。
      const latestInstalled = operation?.state === 'succeeded' && !versionBelow(operation.installedVersion, version.latestVersion);
      const head = [h('span', { key: 'title', className: 'dsm-wb-backend-title' }, t('updateTitle'))];
      if (ready) {
        const badge = latestInstalled
          ? operation.outcome?.restartRequired
            ? { tone: 'new', text: t('updatePendingRestart') }
            : operation.outcome?.refreshRequired
              ? { tone: 'new', text: t('updatePendingRefresh') }
              : { tone: 'ok', text: t('updateUpToDate') }
          : version.updateAvailable
            ? { tone: 'new', text: t('updateAvailable') }
            : { tone: 'ok', text: t('updateUpToDate') };
        head.push(h('span', { key: 'badge', className: `dsm-wb-badge dsm-wb-badge-${badge.tone}` }, badge.text));
      }
      head.push(wbButton('check', 'outline', t('updateCheck'), actions.checkUpdate, version.phase === 'loading' || running));
      // 只隐藏已安装版本覆盖的更新，避免重复安装，同时允许补齐或继续升级。
      if (ready && !latestInstalled && version.updateAvailable && market.phase === 'ready' && market.updatable !== false) {
        head.push(
          wbButton('update', 'primary', running ? t('updateRunning') : t('updateNow', { version: version.latestVersion }), () => actions.startUpdate(false), running),
        );
      }

      const section = [h('div', { key: 'head', className: 'dsm-wb-backend-head' }, head)];
      if (version.phase === 'loading') {
        section.push(h('p', { key: 'checking', className: 'dsm-wb-backend-line' }, t('updateChecking')));
      } else if (version.phase === 'error') {
        section.push(wbNotice('checkError', { kind: 'error', text: t('updateCheckFailed', { reason: version.reason }) }));
      }
      if (version.currentVersion) {
        section.push(
          h(
            'p',
            { key: 'versions', className: 'dsm-wb-backend-line' },
            t('updateCurrent'),
            h('strong', null, `v${version.currentVersion}`),
            ready ? '  ·  ' : null,
            ready ? t('updateLatestVersion') : null,
            ready ? h('strong', null, `v${version.latestVersion}`) : null,
          ),
        );
      }
      if (ready && version.updateAvailable && market.phase === 'absent' && !operation) {
        section.push(h('p', { key: 'noMarket', className: 'dsm-wb-hint' }, t('updateNoMarket')));
      }
      if (ready && version.updateAvailable && market.phase === 'ready' && market.updatable === false && !operation) {
        section.push(h('p', { key: 'unmanaged', className: 'dsm-wb-hint' }, t(market.source === 'linked' ? 'updateLinked' : 'updateManaged')));
      }

      if (isActiveOperation(operation)) {
        const percent = operation.progress?.percent;
        section.push(
          h('p', { key: 'progress', className: 'dsm-wb-backend-line' }, typeof percent === 'number' ? t('updateProgress', { percent }) : t('updateRunning')),
        );
        if (operation.progress?.detail) section.push(h('p', { key: 'detail', className: 'dsm-wb-hint' }, operation.progress.detail));
      } else if (operation?.state === 'succeeded') {
        const parts = [t('updateSucceeded', { version: operation.installedVersion })];
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        else if (operation.outcome?.refreshRequired) parts.push(t('updateRefreshHint'));
        section.push(wbNotice('done', { kind: 'ok', text: parts.join(' ') }));
        // 文档要求客户端自己再核对一次：市场回报成功，不等于装上的就是卡片上答应的那个版本
        if (update.target && versionBelow(operation.installedVersion, update.target)) {
          section.push(wbNotice('mismatch', { kind: 'error', text: t('updateMismatch', { installed: operation.installedVersion, target: update.target }) }));
        }
        if (operation.outcome?.restartRequired && market.restartSupported) {
          const restartBusy = update.restart?.phase === 'busy' || update.restart?.phase === 'done';
          section.push(
            h(
              'div',
              { key: 'restart', className: 'dsm-wb-toolbar' },
              wbButton('restart', 'primary', restartBusy ? t('restarting') : t('restartNow'), actions.restart, restartBusy),
            ),
          );
        }
      } else if (operation?.state === 'failed') {
        const code = operation.failure?.code;
        const reason = code === 'RELEASE_TOO_FRESH' ? t('updateTooFresh') : t('updateFailed', { reason: operation.failure?.message ?? code ?? '' });
        section.push(wbNotice('failed', { kind: 'error', text: reason }));
        if (FORCEABLE_FAILURES.has(code)) {
          section.push(
            h('div', { key: 'force', className: 'dsm-wb-toolbar' }, wbButton('force', 'danger', t('updateForce'), () => actions.startUpdate(true), running)),
          );
        }
      } else if (operation?.state === 'cancelled') {
        section.push(wbNotice('cancelled', { kind: 'error', text: t('updateCancelled') }));
      } else if (operation?.state === 'rolled-back') {
        section.push(wbNotice('rolledBack', { kind: 'error', text: t('updateRolledBack', { version: operation.installedVersion }) }));
      }
      if (update.restart?.phase === 'error') {
        section.push(wbNotice('restartError', { kind: 'error', text: t('restartFailed', { reason: update.restart.reason }) }));
      }
      section.push(wbNotice('updateNotice', update.notice));
      return section;
    }

    /**
     * 「插件更新」区块的状态与动作：版本检查走本插件的宿主路由，更新与重启交给 dshmarket，
     * 本插件不碰 pnpm，也不自己改 profile。
     * 读状态处都带 `?.`：测试替身按调用顺序喂 useState，这几个状态在那里可能是 undefined。
     */
    function useUpdater(t) {
      const [version, setVersion] = useState({ phase: 'loading' });
      const [market, setMarket] = useState({ phase: 'loading' });
      const [operation, setOperation] = useState(undefined);
      const [target, setTarget] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(undefined);
      const [restart, setRestart] = useState(undefined);

      const loadVersion = useCallback(async (force) => {
        // 保留上一次的版本号：重新检查时"当前运行版本"那一行不闪
        setVersion((previous) => ({ ...previous, phase: 'loading' }));
        try {
          const payload = await request(force ? `${VERSION_PATH}?force=1` : VERSION_PATH, 'GET');
          setVersion(
            payload.ok
              ? { phase: 'ready', ...payload }
              : { phase: 'error', currentVersion: payload.currentVersion, reason: payload.reason },
          );
        } catch (error) {
          setVersion({ phase: 'error', reason: errorText(error) });
        }
      }, []);

      const probeMarket = useCallback(async () => {
        try {
          const result = await marketRequest(MARKET_CAPABILITIES_PATH, 'GET');
          const body = result.body;
          // 没装 dshmarket 时这条路径由宿主答 404（多半不是 JSON），schema 对不上同样当作不存在
          if (result.status !== 200 || body?.schema !== MARKET_SCHEMA || body.features?.update !== true) {
            setMarket({ phase: 'absent' });
            return;
          }
          const ready = {
            phase: 'ready',
            bootId: typeof body.bootId === 'string' ? body.bootId : undefined,
            // 桌面版的重启归桌面壳管，市场会答 supported:false，此时不显示重启按钮
            restartSupported: body.restart?.supported === true,
            endpoints: { ...MARKET_DEFAULT_ENDPOINTS, ...body.endpoints },
          };
          Object.assign(ready, await installSourceOf(ready.endpoints.updates));
          setMarket(ready);
          // 卡片被卸下再挂上（例如本插件被热重载）时接着轮询原来的任务。
          // 任务 id 以市场进程的 bootId 开头：对不上说明 DSH 已重启，旧记录直接丢弃
          const stored = readStoredOperation();
          if (stored && ready.bootId && !stored.operationId.startsWith(`${ready.bootId}-`)) {
            storeOperation(undefined);
          } else if (stored) {
            setTarget(stored.target);
            setOperation((current) => current ?? { operationId: stored.operationId, state: 'running' });
          }
        } catch {
          setMarket({ phase: 'absent' });
        }
      }, []);

      useEffect(() => {
        loadVersion(false);
        probeMarket();
      }, [loadVersion, probeMarket]);

      // 轮询进行中的任务。用 setTimeout 链而不是 setInterval：慢响应时不会叠出并发请求
      const operationId = operation?.operationId;
      const active = isActiveOperation(operation);
      const operationsPath = market?.endpoints?.operations;
      useEffect(() => {
        if (!operationId || !active || !operationsPath) return undefined;
        let stopped = false;
        let timer;
        const tick = async () => {
          let result;
          try {
            result = await marketRequest(`${operationsPath}?operationId=${encodeURIComponent(operationId)}`, 'GET');
          } catch {
            result = undefined; // 网络抖动或宿主正在重载：下一拍再问
          }
          if (stopped) return;
          if (result?.status === 404) {
            // 任务记录只活在市场当前进程里，查不到说明进程已经换过
            storeOperation(undefined);
            setOperation(undefined);
            setNotice({ kind: 'ok', text: t('updateLost') });
            return;
          }
          const next = result?.body?.operation;
          if (next && typeof next.state === 'string') {
            setOperation(next);
            if (!isActiveOperation(next)) {
              storeOperation(undefined);
              return;
            }
          }
          timer = setTimeout(tick, POLL_MS);
        };
        timer = setTimeout(tick, POLL_MS);
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, [operationId, active, operationsPath, t]);

      const startUpdate = useCallback(
        async (force) => {
          const path = market?.endpoints?.updates;
          if (!path) return;
          const goal = version?.latestVersion;
          setBusy(true);
          setNotice(undefined);
          setRestart(undefined);
          setOperation(undefined);
          try {
            // force 只在市场报了发布冷却期 / 版本未变之后由用户显式选择（文档的约定）
            const result = await marketRequest(path, 'POST', force ? { packageName: PACKAGE_NAME, force: true } : { packageName: PACKAGE_NAME });
            const next = result.body?.operation;
            if (result.status === 202 && typeof next?.operationId === 'string') {
              setTarget(goal);
              setOperation(next);
              storeOperation({ operationId: next.operationId, target: goal });
            } else {
              setNotice({ kind: 'error', text: t('updateStartFailed', { reason: marketReason(result) }) });
            }
          } catch (error) {
            setNotice({ kind: 'error', text: t('updateStartFailed', { reason: errorText(error) }) });
          } finally {
            setBusy(false);
          }
        },
        [market?.endpoints, version?.latestVersion, t],
      );

      const restartHost = useCallback(async () => {
        const path = market?.endpoints?.restart;
        if (!path) return;
        setRestart({ phase: 'busy' });
        try {
          const result = await marketRequest(path, 'POST', {});
          setRestart(result.status >= 200 && result.status < 300 ? { phase: 'done' } : { phase: 'error', reason: marketReason(result) });
        } catch {
          // 宿主可能在答复前就开始退出，连接随之断开——这正说明重启已经开始
          setRestart({ phase: 'done' });
        }
      }, [market?.endpoints]);

      return {
        model: { version, market, operation, target, busy, notice, restart },
        actions: {
          checkUpdate: () => {
            setNotice(undefined);
            loadVersion(true);
            if (market?.phase !== 'ready') probeMarket();
          },
          startUpdate,
          restart: restartHost,
        },
      };
    }

    function ModelsCard({ t, view }) {
      const [phase, setPhase] = useState('loading');
      const [rows, setRows] = useState([]);
      const [meta, setMeta] = useState({});
      const [reason, setReason] = useState('');
      const [picked, setPicked] = useState(() => new Set());
      const [savedPicked, setSavedPicked] = useState(() => new Set());
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(undefined);

      const load = useCallback(async (refresh = true) => {
        setPhase('loading');
        setNotice(undefined);
        try {
          // 保存后只回读；首次打开、刷新及重试则立即对齐 DSH，无需再点保存。
          const payload = refresh === false
            ? await request(MODELS_PATH, 'GET')
            : await request(MODELS_PATH, 'POST', { action: 'refresh' });
          if (!payload.ok) {
            setRows([]);
            setPicked(new Set());
            setSavedPicked(new Set());
            setMeta({ enabled: payload.enabled, savedEnabled: payload.enabled, patchPath: payload.patchPath, accounts: payload.accounts });
            // 已知状态只记状态码，渲染时再翻成本地化提示（load 不依赖 t，避免 t 变化时反复重载）。
            setReason([BACKEND_NOT_INSTALLED, BACKEND_NO_ACCOUNTS].includes(payload.state) ? payload.state : (payload.reason ?? ''));
            setPhase('error');
            return;
          }
          const list = payload.models ?? [];
          const selected = new Set([...(payload.only ?? []), ...list.filter((row) => row.selected).map((row) => row.id)]);
          setRows(list);
          setMeta({ enabled: payload.enabled, savedEnabled: payload.enabled, only: payload.only, patchPath: payload.patchPath, url: payload.url, realm: payload.realm });
          setPicked(selected);
          setSavedPicked(new Set(selected));
          setPhase('ready');
          if (['failed', 'skipped', 'not-ready'].includes(payload.sync?.state)) {
            setNotice({ kind: 'error', text: payload.sync.reason ?? payload.sync.state });
          }
        } catch (error) {
          setMeta({});
          setReason(error instanceof Error ? error.message : String(error));
          setPhase('error');
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const sorted = useMemo(() => sortRows(rows), [rows]);

      const toggle = useCallback((id) => {
        setPicked((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setNotice(undefined);
      }, []);

      const save = useCallback(async () => {
        setSaving(true);
        setNotice(undefined);
        try {
          const payload = await request(MODELS_PATH, 'POST', {
            enabled: meta.enabled === true,
            // 空白名单代表跟随全部上游模型，重复保存不能将它固化为当前可见的子集。
            only: meta.only?.length === 0 && sameSet(picked, savedPicked) ? [] : orderedSelection(rows, picked),
          });
          if (!payload.ok) {
            setNotice({ kind: 'error', text: payload.reason ?? t('saveFailed') });
            return;
          }
          const sync = payload.sync ?? {};
          // 先重载再出提示：load() 开头会清空 notice，反过来写会把结果（尤其是同步失败的原因）立刻抹掉。
          await load(false);
          if (sync.state === 'updated' || sync.state === 'unchanged') {
            setNotice({ kind: 'ok', text: t('savedSync', { count: sync.count ?? 0 }) });
          } else if (sync.state === 'disabled') {
            setNotice({ kind: 'ok', text: t('savedDisabled') });
          } else {
            // failed / skipped 意味着 DSH 的模型清单没跟上白名单，用错误色提示；disabled 是用户自己关的，不算错。
            const kind = sync.state === 'failed' || sync.state === 'skipped' ? 'error' : 'ok';
            setNotice({ kind, text: t('savedNoSync', { state: sync.reason ?? sync.state ?? '' }) });
          }
        } catch (error) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
        } finally {
          setSaving(false);
        }
      }, [rows, picked, savedPicked, meta.enabled, meta.only, load, t]);

      // ---- 后端版本（更新检查 / 安装 / 更新 / 卸载 / 回滚）----
      const [backend, setBackend] = useState(undefined);
      const [check, setCheck] = useState(undefined);
      const [backendBusy, setBackendBusy] = useState(undefined);
      const [backendNotice, setBackendNotice] = useState(undefined);
      /** 正在二次确认的动作：'uninstall' / 'purge'；false 表示没有弹窗。 */
      const [confirming, setConfirming] = useState(false);

      const loadBackend = useCallback(async () => {
        try {
          const payload = await request(BACKEND_PATH, 'GET');
          setBackend(payload.backend ?? {});
        } catch (error) {
          setBackend({ error: error instanceof Error ? error.message : String(error) });
        }
      }, []);

      useEffect(() => {
        loadBackend();
      }, [loadBackend]);

      /** 装好后端后打开同步并同步一次；先 load 再出提示（load 开头会清空 notice）。 */
      const enableSyncAfterInstall = useCallback(async () => {
        let notice;
        try {
          const payload = await request(MODELS_PATH, 'POST', { enabled: true });
          const sync = payload.sync ?? {};
          notice = sync.state === 'updated' || sync.state === 'unchanged'
            ? { kind: 'ok', text: t('savedSync', { count: sync.count ?? 0 }) }
            : { kind: 'error', text: t('savedNoSync', { state: sync.reason ?? sync.state ?? '' }) };
        } catch (error) {
          notice = { kind: 'error', text: errorText(error) };
        }
        await load(false);
        setNotice(notice);
      }, [t, load]);

      const runBackend = useCallback(
        async (action, extra) => {
          setBackendBusy(action);
          setBackendNotice(undefined);
          try {
            const payload = await request(BACKEND_PATH, 'POST', { action, ...(extra ?? {}) });
            if (payload.backend) setBackend(payload.backend);
            if (action === 'check') {
              setCheck(payload.check?.error ? { error: payload.check.error } : payload.check);
            } else if (payload.ok) {
              setCheck(undefined);
              const noticeKey = action === 'uninstall' && payload.backend?.gateway === 'hub' ? 'backendUninstalledHub' : BACKEND_NOTICE[action];
              const done = t(noticeKey ?? 'backendUpdated', {
                tag: payload.latest?.tag ?? payload.local?.tag ?? '',
                root: payload.root ?? '',
              });
              // 刚装好的后端还没登录账号：/healthz 是 503，但进程是好的，提示去面板登录。
              const noAccounts = payload.health?.servable === false ? ` ${t('backendNoAccounts')}` : '';
              setBackendNotice({ kind: 'ok', text: done + noAccounts });
              if (action === 'install') {
                // 刚装好后端：打开「同步到 DSH 模型列表」并立即同步一次，再刷新模型区。
                // 不带 only，沿用已有白名单（重装时不能把用户之前的勾选清空）。
                await enableSyncAfterInstall();
              } else if (action !== 'uninstall' && action !== 'purge') {
                // 后端换过/新起来了，模型区可能还停在"fetch failed"，重读一次。
                load();
              }
            } else {
              setBackendNotice({ kind: 'error', text: payload.reason ?? payload.state ?? '' });
            }
          } catch (error) {
            setBackendNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
          } finally {
            setBackendBusy(undefined);
          }
        },
        [t, load, enableSyncAfterInstall],
      );

      /** 自动更新开关：宿主写 backend.autoUpdate 并就地生效（不重启插件），回来的快照直接换上。 */
      const toggleAutoUpdate = useCallback(async (enabled) => {
        setBackendBusy('autoUpdate');
        setBackendNotice(undefined);
        try {
          const payload = await request(BACKEND_PATH, 'POST', { action: 'autoUpdate', enabled });
          if (payload.backend) setBackend(payload.backend);
        } catch (error) {
          setBackendNotice({ kind: 'error', text: errorText(error) });
        } finally {
          setBackendBusy(undefined);
        }
      }, []);

      // 放在所有既有 useState 之后：hooks 按调用顺序配对，插到前面会打乱上面那些状态
      const updater = useUpdater(t);

      // 同样排在既有 hooks 之后。控制台的密钥只存在用户浏览器的 localStorage 里（按来源隔离），
      // 插件替它填不进去，只能把 config.json 里的 api_key 交给用户粘贴一次。
      const [panelKey, setPanelKey] = useState(undefined);
      const copyPanelKey = useCallback(async () => {
        setPanelKey({ busy: true });
        try {
          const payload = await request(PANEL_KEY_PATH, 'POST', {});
          const hub = payload.gateway === 'hub';
          if (!payload.key) {
            setPanelKey({ kind: 'ok', text: t(hub ? 'panelPasswordChanged' : 'panelKeyNone') });
            return;
          }
          try {
            await navigator.clipboard.writeText(payload.key);
            setPanelKey({ kind: 'ok', text: t(hub ? 'panelPasswordCopied' : 'panelKeyCopied') });
          } catch {
            // 剪贴板 API 可能被宿主/非安全上下文拒绝：退回显示原文，让用户自己选中复制。
            setPanelKey({ kind: 'manual', key: payload.key });
          }
        } catch (error) {
          setPanelKey({ kind: 'error', text: errorText(error) });
        }
      }, [t]);

      // 切换后端网关。宿主写完 config.gateway 会重启本插件（停旧网关、按新网关拉起）；
      // 新网关要几秒才监听（hub 带 Python 冷启动），固定延时去读会读到 fetch failed，
      // 所以轮询到"后端快照已是新网关、模型区能答"为止，再刷新两块（见 waitForGateway）。
      const [gatewaySwitch, setGatewaySwitch] = useState(undefined);
      const switchGateway = useCallback(async (gateway, label) => {
        setGatewaySwitch({ busy: gateway, kind: 'ok', text: t('gatewayWaiting', { name: label }) });
        try {
          const payload = await request(BACKEND_PATH, 'POST', { action: 'gateway', gateway });
          if (!payload.ok) {
            setGatewaySwitch({ kind: 'error', text: payload.reason ?? '' });
            return;
          }
          const outcome = payload.state === 'switched' ? await waitForGateway(gateway) : 'ready';
          await loadBackend();
          await load(false);
          const key = { ready: 'gatewaySwitched', 'not-installed': 'gatewayNotInstalled' }[outcome] ?? 'gatewayTimeout';
          setGatewaySwitch({
            kind: outcome === 'timeout' ? 'error' : 'ok',
            text: t(key, { name: label, seconds: GATEWAY_WAIT_MS / 1000 }),
          });
        } catch (error) {
          setGatewaySwitch({ kind: 'error', text: errorText(error) });
        }
      }, [t, loadBackend, load]);

      const [diagnostic, setDiagnostic] = useState(undefined);
      const runDiagnostic = async () => {
        setDiagnostic({ busy: true });
        try { setDiagnostic({ report: (await request(BACKEND_PATH, 'POST', { action: 'diagnose' })).report }); }
        catch (error) { setDiagnostic({ error: errorText(error) }); }
      };
      const copyDiagnostic = async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(diagnostic.report, null, 2)); setDiagnostic((last) => ({ ...last, copied: true })); }
        catch { setDiagnostic((last) => ({ ...last, manual: true })); }
      };

      // 行详情页在缺少包描述时才用 summary 视图；本包有 description，正常走 page。
      if (view === 'summary') {
        return h('p', { className: 'dsm-wb-desc' }, t('summary'));
      }

      // enabled 是开关草稿，savedEnabled 是上次读取的配置；只切换开关也必须允许保存。
      const dirty = !sameSet(picked, savedPicked) || meta.enabled !== meta.savedEnabled;
      const body = [];
      body.push(h('div', { key: 'diagnose', className: 'dsm-wb-toolbar dsm-wb-diagnostics' },
        wbButton('diagnose', 'outline', t(diagnostic?.busy ? 'diagnoseWorking' : 'diagnose'), runDiagnostic, diagnostic?.busy),
        diagnostic?.report ? wbButton('copyReport', 'outline', t(diagnostic.copied ? 'diagnoseCopied' : 'diagnoseCopy'), copyDiagnostic, false) : null));
      if (diagnostic?.report || diagnostic?.error) body.push(h('pre', { key: 'diagnosticReport', className: 'dsm-wb-hint', style: { whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', userSelect: 'text' } }, diagnostic.error || JSON.stringify(diagnostic.report, null, 2)));

      if (phase === 'loading') {
        body.push(h('div', { key: 'loading', className: 'dsm-wb-empty' }, t('loading')));
      } else if (phase === 'error') {
        body.push(
          h(
            'div',
            { key: 'error', className: 'dsm-wb-empty' },
            h('div', { className: 'dsm-wb-notice dsm-wb-notice-error' }, errorReasonText(reason, meta, t)),
            h('button', { type: 'button', className: 'dsm-wb-btn dsm-wb-btn-outline', onClick: load }, t('retry')),
          ),
        );
      } else {
        body.push(
          h(
            'label',
            { key: 'sync', className: 'dsm-wb-sync' },
            h('input', {
              type: 'checkbox',
              checked: meta.enabled === true,
              disabled: saving,
              onChange: (event) => {
                const enabled = event.target.checked;
                setMeta((previous) => ({ ...previous, enabled }));
                setNotice(undefined);
              },
            }),
            t('syncEnabled'),
          ),
          h('p', { key: 'syncHint', className: 'dsm-wb-hint' }, t(meta.enabled === true ? 'syncHint' : 'disabledHint')),
          // hub 才有出口（应答顶层的 realm）：说明这一页勾的是哪一组。
          meta.realm ? h('p', { key: 'hubRealm', className: 'dsm-wb-hint' }, t('hubRealm', { realm: meta.realm === 'cn' ? 'CN' : 'GL' })) : null,
        );
        body.push(
          h(
            'div',
            { key: 'toolbar', className: 'dsm-wb-toolbar' },
            h('span', { className: 'dsm-wb-count' }, t('count', { total: sorted.length, picked: sorted.filter((row) => picked.has(row.id)).length })),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-wb-btn dsm-wb-btn-outline',
                disabled: saving,
                onClick: () => {
                  setPicked((previous) => new Set([...previous, ...sorted.map((row) => row.id)]));
                  setNotice(undefined);
                },
              },
              t('selectAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-wb-btn dsm-wb-btn-outline',
                disabled: saving,
                onClick: () => {
                  setPicked(new Set());
                  setNotice(undefined);
                },
              },
              t('clearAll'),
            ),
            h('button', { type: 'button', className: 'dsm-wb-btn dsm-wb-btn-outline', disabled: saving, onClick: load }, t('refresh')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-wb-btn dsm-wb-btn-primary',
                // 同步已开启时允许重复保存，修复旧清单或重试上次失败无需先改勾选。
                disabled: saving || (!dirty && meta.enabled !== true),
                onClick: save,
              },
              saving ? t('saving') : t(meta.enabled === true ? 'saveSync' : 'save'),
            ),
          ),
        );

        if (sorted.length === 0) {
          body.push(h('div', { key: 'empty', className: 'dsm-wb-empty' }, t('emptyBackend')));
        } else {
          body.push(
            h(
              'div',
              { key: 'list', className: 'dsm-wb-list' },
              sorted.map((row) =>
                h(
                  'label',
                  { key: row.id, className: 'dsm-wb-row', title: row.id },
                  h('input', {
                    type: 'checkbox',
                    checked: picked.has(row.id),
                    disabled: saving,
                    onChange: () => toggle(row.id),
                  }),
                  h('span', { className: 'dsm-wb-label' }, row.label),
                  h(
                    'span',
                    { className: 'dsm-wb-meta' },
                    row.vision ? h('span', { className: 'dsm-wb-tag' }, t('vision')) : null,
                    formatTokens(row.contextWindow)
                      ? h('span', { className: 'dsm-wb-tag' }, formatTokens(row.contextWindow))
                      : null,
                    h(
                      'span',
                      { className: `dsm-wb-credits${row.credits === 'Free' ? ' dsm-wb-credits-free' : ''}` },
                      `x${row.credits}`,
                    ),
                  ),
                ),
              ),
            ),
          );
        }

        // hub 的勾选按出口分开：另一个出口的勾选不算，这个出口一个没勾就是"全部"。
        const nonePicked = meta.realm ? sorted.every((row) => !picked.has(row.id)) : picked.size === 0;
        if (nonePicked && sorted.length > 0) {
          body.push(h('p', { key: 'emptyHint', className: 'dsm-wb-hint' }, t('emptyHint')));
        }
      }

      if (notice) {
        body.push(
          h(
            'p',
            {
              key: 'notice',
              className: `dsm-wb-notice ${notice.kind === 'error' ? 'dsm-wb-notice-error' : 'dsm-wb-notice-ok'}`,
            },
            notice.text,
          ),
        );
      }
      if (meta.patchPath) {
        body.push(h('p', { key: 'path', className: 'dsm-wb-path' }, t('patchPath', { path: meta.patchPath })));
      }

      // 后端版本区：检查 / 安装 / 更新 / 卸载 / 回滚。数据来自宿主半侧的 /backend 端点，
      // 首屏那次 GET 不联网（快），点"检查更新"才真去查 release。
      if (backend) {
        const version = backend.version ?? {};
        const currentTag =
          version.tag ?? (version.revision ? version.revision.slice(0, 7) : null) ?? t('backendUnmanaged');
        const history = Array.isArray(backend.history) ? backend.history : [];
        const latestTag = check?.latest?.tag ?? '';
        // 老快照没有 exeExists 字段时按"已安装"处理，避免误显示成未安装。
        const installed = backend.exeExists !== false;

        // 老宿主的快照没有 gateways 字段：不显示切换（它也不认 gateway 动作）。
        const gateways = Array.isArray(backend.gateways) ? backend.gateways : [];
        const currentGateway = backend.gateway ?? 'wb2api';
        const gatewayLabel = (id) => t(id === 'hub' ? 'gatewayHub' : 'gatewayWb2api');
        const section = [];
        if (backend.recovery) {
          const recoveryKey = { idle: 'recoveryIdle', waiting: 'recoveryWaiting', restarting: 'recoveryRestarting', recovered: 'recoveryRecovered', exhausted: 'recoveryExhausted' }[backend.recovery.state] ?? 'recoveryIdle';
          section.push(h('p', { key: 'recovery', className: 'dsm-wb-backend-line' }, t('recoveryStatus', { state: t(recoveryKey), attempts: backend.recovery.attempts ?? 0 }),
            wbButton('retryStart', 'outline', t('recoveryRetry'), () => runBackend('start'), Boolean(backendBusy))));
        }
        if (gateways.length > 1) {
          const gatewayBlock = [
            h(
              'div',
              { key: 'gateway', className: 'dsm-wb-backend-head' },
              h('span', { className: 'dsm-wb-backend-title' }, t('gatewayTitle')),
              gateways.map((id) =>
                wbButton(
                  `gateway-${id}`,
                  id === currentGateway ? 'primary' : 'outline',
                  gatewaySwitch?.busy === id ? t('gatewaySwitching') : gatewayLabel(id),
                  () => switchGateway(id, gatewayLabel(id)),
                  id === currentGateway || Boolean(gatewaySwitch?.busy) || Boolean(backendBusy),
                ),
              ),
            ),
          ];
          if (currentGateway === 'hub') {
            gatewayBlock.push(h('p', { key: 'gatewayHint', className: 'dsm-wb-backend-line' }, t('gatewayHubHint')));
          }
          const switched = wbNotice('gatewayNotice', gatewaySwitch);
          if (switched) gatewayBlock.push(switched);
          section.push(h('div', { key: 'gatewayBlock', className: 'dsm-wb-gateway' }, gatewayBlock));
        }
        section.push(
          h(
            'div',
            { key: 'head', className: 'dsm-wb-backend-head' },
            h('span', { className: 'dsm-wb-backend-title' }, t('backendTitle')),
            check && !check.error
              ? h(
                  'span',
                  { className: `dsm-wb-badge ${check.upToDate ? 'dsm-wb-badge-ok' : 'dsm-wb-badge-new'}` },
                  check.upToDate ? t('backendUpToDate') : t('backendAvailable', { tag: latestTag }),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-wb-btn dsm-wb-btn-outline',
                disabled: Boolean(backendBusy),
                onClick: () => runBackend('check'),
              },
              backendBusy === 'check' ? t('backendWorking') : t('backendCheck'),
            ),
            // 安装与卸载互斥：没装才显示"安装"，装了才显示"卸载"。
            // 顺序按使用频率排：更新 → 回滚 → 卸载 → 彻底卸载（删除类放最后，离"检查更新"最远，减少误点）。
            installed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-wb-btn dsm-wb-btn-primary',
                    disabled: Boolean(backendBusy),
                    onClick: () => runBackend('update'),
                  },
                  backendBusy === 'update' ? t('backendWorking') : t('backendUpdate'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-wb-btn dsm-wb-btn-primary',
                    disabled: Boolean(backendBusy),
                    onClick: () => runBackend('install'),
                  },
                  backendBusy === 'install' ? t('backendWorking') : t('backendInstall'),
                ),
            installed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-wb-btn dsm-wb-btn-outline',
                    disabled: Boolean(backendBusy),
                    onClick: () => runBackend('rollback'),
                  },
                  backendBusy === 'rollback' ? t('backendWorking') : t('backendRollback'),
                )
              : null,
            installed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-wb-btn dsm-wb-btn-danger',
                    disabled: Boolean(backendBusy),
                    onClick: () => setConfirming('uninstall'),
                  },
                  t('backendUninstall'),
                )
              : null,
            // 「彻底卸载」紧挨「卸载」：两者都是删除动作，放一起便于对比；它比卸载多删 config.json、
            // data/ 凭证与日志。只看目录在不在，后端没装但还剩凭证 / 日志时也要能清。
            backend.rootExists === true
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-wb-btn dsm-wb-btn-danger',
                    disabled: Boolean(backendBusy),
                    onClick: () => setConfirming('purge'),
                  },
                  backendBusy === 'purge' ? t('backendWorking') : t('backendPurge'),
                )
              : null,
          ),
          h(
            'p',
            { key: 'current', className: 'dsm-wb-backend-line' },
            h('strong', null, t('backendCurrent', { version: currentTag })),
            version.builtAt ? ` · ${t('backendBuilt', { time: version.builtAt })}` : '',
          ),
        );

        if (confirming) {
          // 老状态里可能是 true（改成动作名之前的写法），按卸载处理。
          const kind = confirming === 'purge' ? 'purge' : 'uninstall';
          section.push(renderUninstallConfirm({
            t, Modal, h, kind, params: { root: backend.root ?? '' },
            textKind: kind === 'uninstall' && currentGateway === 'hub' ? 'uninstallHub' : undefined,
            onCancel: () => setConfirming(false),
            onConfirm: () => { setConfirming(false); runBackend(kind, { confirm: true }); },
          }));
        }

        if (check?.error) {
          section.push(h('p', { key: 'checkError', className: 'dsm-wb-backend-line' }, check.error));
        } else if (check) {
          section.push(
            h(
              'p',
              { key: 'latest', className: 'dsm-wb-backend-line' },
              h('strong', null, t('backendLatest', { tag: latestTag })),
            ),
          );
        }

        section.push(
          h(
            'p',
            { key: 'history', className: 'dsm-wb-backend-line' },
            history.length ? t('backendHistory', { list: history.map((item) => item.name).join(', ') }) : t('backendNoHistory'),
          ),
        );

        // 没装就没有可更新的东西：首次安装永远由用户点。
        if (installed) {
          section.push(...renderAutoUpdate(backend.autoUpdate, version.tag ?? null, { busy: backendBusy, onToggle: toggleAutoUpdate }, t));
        }

        // DSH 卸载插件时不通知插件，数据目录只能靠用户在卸载前点「彻底卸载」清掉，这里写明会删哪个目录。
        if (backend.rootExists === true) {
          section.push(
            h(
              'p',
              { key: 'purgeHint', className: 'dsm-wb-backend-line' },
              t('backendPurgeHint', { root: backend.root ?? '' }),
            ),
          );
        }

        if (backendNotice) {
          section.push(
            h(
              'p',
              {
                key: 'backendNotice',
                className: `dsm-wb-notice ${backendNotice.kind === 'error' ? 'dsm-wb-notice-error' : 'dsm-wb-notice-ok'}`,
              },
              backendNotice.text,
            ),
          );
        }

        body.push(h('div', { key: 'backend', className: 'dsm-wb-backend' }, section));
      }

      // 插件自身的更新：放在最底部，与上面管 wb2api 的"后端版本"区分开
      body.push(h('div', { key: 'pluginUpdate', className: 'dsm-wb-backend' }, renderUpdateSection(updater.model, updater.actions, t)));

      // 后端管理面板地址：宿主在 /backend 应答里给（端口可配），拿不到就用兜底值。
      const panelUrl = backend?.panelUrl ?? DEFAULT_PANEL_URL;
      const panelLabel = String(panelUrl).replace(/^https?:\/\//, '');

      return h(
        'div',
        { className: 'dsm-wb-card' },
        h('div', { className: 'dsm-wb-title' }, t('title')),
        h('p', { className: 'dsm-wb-desc' }, t('description')),
        h(
          'p',
          { className: 'dsm-wb-panel' },
          t('panelHint'),
          h(
            'a',
            {
              href: panelUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'dsm-wb-link',
              title: panelUrl,
            },
            panelLabel,
          ),
          wbButton(
            'panelKey',
            'outline dsm-wb-panel-key',
            panelKey?.busy ? t('panelKeyWorking') : t(backend?.gateway === 'hub' ? 'panelPasswordCopy' : 'panelKeyCopy'),
            copyPanelKey,
            Boolean(panelKey?.busy),
          ),
        ),
        panelKey?.kind === 'manual'
          ? h(
              'p',
              { className: 'dsm-wb-notice dsm-wb-notice-error' },
              t('panelKeyManual'),
              h('code', { className: 'dsm-wb-key' }, panelKey.key),
            )
          : wbNotice('panelKeyNotice', panelKey?.busy ? undefined : panelKey),
        body,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), `${name}: locale`);
      const t = ctx.locale.bind(namespace);
      ensureStyle();

      /**
       * 两处注册共用一份组件：组合包页面与"本插件那一行"的配置页。
       * 整段包在 try 里——DSH 的 slot API 还在 rc 阶段（id→key、order→priority 改过名），
       * 注册失败只该少一张卡片，不该把整个客户端模块图带崩。
       */
      const registerCard = (slotName, key) => {
        try {
          ctx.slots.inject(slotName, () =>
            ctx.slots.register(
              {
                name: slotName,
                key,
                priority: 30,
                locale: namespace,
                inject: () => ({ t }),
              },
              ModelsCard,
            ),
          );
        } catch (error) {
          console.error(`[${name}] 卡片注册失败（slot ${slotName}）：`, error);
        }
      };

      // 插件页按"包名"找 bundle 卡片、按"包名#行 id"找行卡片（DSH plugin-manager 的 rowConfigKey）。
      registerCard('plugins.bundle.config', '@zhiqiangme/dsh-autostart-workbuddy');
      registerCard('plugins.row.config', '@zhiqiangme/dsh-autostart-workbuddy#dsh-autostart-workbuddy');
    }

    // 纯函数，导出给测试；宿主只认 name / inject / apply。
    exports.orderedSelection = orderedSelection;
    exports.renderUpdateSection = renderUpdateSection;
    exports.renderAutoUpdate = renderAutoUpdate;
    exports.waitForGateway = waitForGateway;
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
