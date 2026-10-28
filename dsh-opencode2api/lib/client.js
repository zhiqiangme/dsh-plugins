/**
 * 浏览器半侧：DSH「插件」页里的 OpenCode 模型卡片。
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
 * 127.0.0.1:8080（跨源 + 无 CORS），也改不了 profile 里的白名单；而 DSH 的
 * configForms 通道要求宿主半侧声明带 .volatile() 的 schemastery Config，
 * 本插件刻意不引这个依赖，所以走自建路由。
 *
 * 插件更新（卡片最底部，与上面"后端版本"那块无关——那块管 opencode2api，这块管本插件自己）：
 * 版本检查走宿主半侧的 version 路由（问 npm）；一键更新只交给官方 pluginManager。
 * 旧宿主缺少官方更新接口时提示升级宿主或按指定版本安装，本插件不自己跑 pnpm。
 *
 * 样式：全部自带（data-plugin-css 标记，避免重复注入），类名统一 `dsm-oc-*`，
 * 颜色只取 `--dsw-alias-*` 令牌，跟随主题。刻意不借用其它插件注入的类名
 * （Trae/Qoder 的 `dsm-btn` / `dsm-plugin-card` 是它们自己的 CSS，不是宿主全局类）。
 */

// 模块 id 必须是 npm 包名：宿主的客户端模块表按包名登记，对不上就加载不到本 bundle。
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-opencode2api',
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

    const name = 'dsh-opencode2api-client';
    const inject = ['slots', 'locale', 'remote'];
    const namespace = 'settings.dsh-opencode2api';
    /** 与 lib/web.js 的两个端点必须一致。 */
    const MODELS_PATH = '/plugins/dsh-opencode2api/models';
    const BACKEND_PATH = '/plugins/dsh-opencode2api/backend';
    /**
     * 后端管理面板地址的兜底值。宿主会在 /backend 的应答里给出真实地址
     * （host/port 可被 profile 覆盖），拿不到时才用这个。
     */
    const DEFAULT_PANEL_URL = 'http://127.0.0.1:8081/';
    /** 宿主半侧的控制台访问密钥路由（lib/web.js）：POST 才给，点「复制访问密钥」时取一次。 */
    const PANEL_KEY_PATH = '/plugins/dsh-opencode2api/panel-key';

    /** 本插件的 npm 包名：官方插件管理器按它定位 profile 中的依赖。 */
    const PACKAGE_NAME = '@zhiqiangme/dsh-opencode2api';
    /** 宿主半侧的版本检查路由（lib/web.js），?force=1 绕过它的 10 分钟缓存。 */
    const VERSION_PATH = '/plugins/dsh-opencode2api/version';
    /**
     * 官方 listVersions 每次要在宿主上跑 1 + 最多 20 次 `pnpm view`（versionListLimit 默认 20），
     * 所以结果按已装版本缓存，时长与 version 路由一致；「检查更新」绕过缓存。
     */
    const VERSION_LIST_TTL_MS = 10 * 60 * 1000;
    /** 官方 updateBundle 经 `plugin-manager/update-state` 报的阶段 → 文案 key。 */
    const UPDATE_STEPS = {
      checking: 'updateCheckingTarget',
      removing: 'updateRemoving',
      installing: 'updateInstalling',
      restoring: 'updateRestoring',
    };
    /** 模型区失败状态（lib/web.js 的 BACKEND_NOT_INSTALLED）：后端没装，提示去点「安装」。 */
    const BACKEND_NOT_INSTALLED = 'backend-not-installed';
    const GATEWAY_WAIT_MS = 240_000;
    const GATEWAY_POLL_MS = 500;

    /** 后端动作 → 成功后的提示文案 key。 */
    const BACKEND_NOTICE = {
      install: 'backendInstalled',
      update: 'backendUpdated',
      rollback: 'backendRolledBack',
      uninstall: 'backendUninstalled',
      purge: 'backendPurged',
    };

    const CSS = `
.dsm-oc-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;padding:14px 16px}
.dsm-oc-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-oc-desc{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-oc-panel{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
/* 外链用 DSH 自己那套：http(s) + target=_blank，宿主主窗口的 setWindowOpenHandler
   会把它交给 shell.openExternal，即默认浏览器打开。 */
.dsm-oc-link{color:var(--dsw-alias-state-business-primary,#5686fe);text-decoration:none;cursor:pointer}
.dsm-oc-link:hover{text-decoration:underline}
.dsm-oc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 8px}
.dsm-oc-count{flex:1;min-width:120px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-oc-sync{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;cursor:pointer}
.dsm-oc-sync input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-oc-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-oc-btn:disabled{cursor:default}
/* 主按钮用"反色"配色，不用 --dsw-alias-brand-primary 当底色：本主题把
   brand-primary 定义成 --dsw-alias-label-primary（深色模式下 #f9fafb，接近纯白），
   拿它当背景再配白字就是白底白字。label-primary 当底 + bg-layer-3 当字，
   明暗两种主题都成立（Trae 的 .dsm-btn-primary 也是这个写法）。 */
.dsm-oc-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-oc-btn-primary:hover:not(:disabled){opacity:.88}
.dsm-oc-btn-outline{background:transparent;border-color:var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-oc-btn-outline:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 禁用态给明确的弱化配色，而不是整体降透明度——降透明度会把文字一起洗掉，
   深色主题下就变成"看不清字"的灰块。 */
.dsm-oc-btn-primary:disabled{background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-dimmed,#8a8f99);border-color:var(--dsw-alias-border-l2,#36373b)}
.dsm-oc-btn-outline:disabled{color:var(--dsw-alias-label-dimmed,#8a8f99)}
.dsm-oc-list{display:flex;flex-direction:column;gap:2px;max-height:340px;overflow:auto;padding:2px 0}
.dsm-oc-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;cursor:pointer}
.dsm-oc-row:hover{background:var(--dsw-alias-bg-layer-2,#25262b)}
.dsm-oc-row input{margin:0;flex:none;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-oc-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-oc-meta{flex:none;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.dsm-oc-credits{flex:none;font-variant-numeric:tabular-nums;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;padding:1px 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-oc-credits-free{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.dsm-oc-tag{flex:none;border-radius:6px;padding:1px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-oc-hint{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
.dsm-oc-notice{margin:8px 0 0;font-size:13px;line-height:1.6}
.dsm-oc-notice-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dsm-oc-notice-error{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-oc-empty{padding:12px 0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px}
.dsm-oc-panel-key{margin-left:8px;padding:1px 10px;font-size:12px}
.dsm-oc-key{display:inline-block;margin-left:4px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#e6e6e6);user-select:all;word-break:break-all}
.dsm-oc-path{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;word-break:break-all}
.dsm-oc-backend{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-oc-gateway{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-oc-backend-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-oc-backend-title{flex:1;min-width:100px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:1.5}
.dsm-oc-backend-line{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6;word-break:break-all}
.dsm-oc-backend-line strong{color:var(--dsw-alias-label-secondary,#c6c9d0);font-weight:500}
.dsm-oc-badge{flex:none;border-radius:6px;padding:1px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-oc-badge-new{color:var(--dsw-alias-state-warning-primary,#d29922);border-color:currentColor}
.dsm-oc-badge-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
/* 危险动作（卸载）用错误色描边；不做成实心红，避免误点。 */
.dsm-oc-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-oc-btn-danger:hover:not(:disabled){background:rgba(217,45,32,.12)}
.dsm-oc-confirm{margin-top:10px;border:1px solid var(--dsw-alias-state-warning-primary,#d29922);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#25262b);padding:12px 14px}
.dsm-oc-confirm-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:1.5}
.dsm-oc-confirm-body{margin-top:4px}
.dsm-oc-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-oc-input{font:inherit;font-size:13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-primary,#e6e6e6);padding:8px 12px}
.dsm-oc-install-spec{box-sizing:border-box;width:100%;margin-top:8px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace)}
`;

    // 字典值必须是**字符串**：DSH 的 t(key, params) 用 `{name}` 占位符插值
    // （见 @deepseek-ai/dsh-client-locale 的 bind）。放函数会让 t() 返回函数本身，
    // React 拿它当 child 直接抛错，整块卡片从页面上消失——这个坑已经踩过一次。
    const zh = {
      title: 'OpenCode 模型列表',
      description: '勾选要同步到 DSH 的模型。价格为每百万 token 的输入 / 输出美元单价；目录可见不代表推理可用。',
      summary: '由插件接管 OpenCode 的模型列表（勾选与能力同步）。',
      loading: '正在读取后端模型…',
      modelsNotInstalled: '后端还没有安装。请点下方「后端版本」里的「安装」，装好后模型列表会自动刷新。',
      retry: '重试',
      selectAll: '全部勾选',
      clearAll: '全部取消',
      refresh: '刷新',
      save: '保存',
      saveSync: '保存并同步',
      syncEnabled: '同步到 DSH 模型列表',
      syncHint: '开启后，保存会立即更新 OpenCode 模型列表，以后启动 DSH 时也会自动同步。',
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
      panelKeyCopy: '复制初始管理密码',
      panelKeyWorking: '读取中…',
      panelKeyCopied: '初始管理密码已复制。请使用 admin 登录；如果已修改密码，请使用新密码。',
      panelKeyManual: '没能写入剪贴板，请手动选中复制：',
      panelKeyNone: '请使用后端已配置的管理员账号和密码。',
      gatewayTitle: '后端网关',
      gatewayJason: 'jasonxu114514（默认）',
      gatewayTiara: 'TiaraBasori',
      gatewaySwitching: '切换中…',
      gatewayWaiting: '正在切换到 {name}，等它启动…',
      gatewaySwitched: '已切换到 {name}。',
      gatewaySynced: '已切换到 {name}，模型、地址和凭据已自动保存并同步。',
      gatewaySyncFailed: '后端已切换，但自动同步未完成：{reason}',
      gatewayNotInstalled: '已切换到 {name}，尚未安装，请在下方点「安装」。',
      gatewayTimeout: '已切换到 {name}，但 {seconds} 秒内未就绪，请查看后端日志后重试。',
      gatewayTiaraHint: '首次安装会下载依赖与独立的 OpenCode 1.x，可能需要几分钟。模型 id 可能与原后端不同，切换后请检查勾选。',
      uninstallTiaraTitle: '卸载 Tiara 后端？',
      uninstallTiaraDesc: '会停止 Tiara 与它的 OpenCode 子进程，删除源码、依赖、运行时、历史版本和安装缓存。',
      uninstallTiaraKept: 'tiara/data/ 中的密钥、配置、会话和日志会保留。',
      panelKeyCopyTiara: '复制面板访问密钥',
      panelKeyCopiedTiara: '已复制访问密钥，在 Tiara 面板中粘贴即可。',
      backendUninstalledTiara: 'Tiara 已卸载（tiara/data/ 与日志保留）。',
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
      backendNotInstalled: '未安装',
      backendAvailableInstall: '可安装 {tag}',
      backendStart: '重试启动',
      backendStarted: '后端已启动。',
      backendProgressHint: '安装在后台进行，可以离开此页面；完成前请保持 DSH 运行。',
      backendElapsed: '已用时 {seconds} 秒',
      backendNoHistory: '历史版本：无',
      backendHistory: '历史版本：{list}',
      backendBuilt: '构建于 {time}',
      backendInstall: '安装',
      backendUninstall: '卸载',
      backendInstalled: '后端已安装 {tag}。',
      backendNoAccounts: '后端进程已启动，模型目录尚未就绪；请打开管理页检查上游配置与连接状态。',
      backendUninstalled: '后端已卸载（config.json 与 data/ 已保留）。',
      cancel: '取消',
      uninstallTitle: '卸载后端？',
      uninstallDesc: '会停止后端，并删除程序文件：opencode2api.exe、历史版本、下载缓存。',
      uninstallKept: '账号凭证与状态（data/）以及 config.json 会保留。',
      uninstallConfirm: '确认卸载',
      backendPurge: '彻底卸载',
      backendPurgeHint: 'DSH 卸载本插件时不会删除 {root}；卸载插件前先点「彻底卸载」即可清干净。',
      backendPurged: '已清除 {root}，现在可以去「插件」页卸载本插件。',
      purgeTitle: '彻底卸载后端？',
      purgeDesc: '会停止后端，并删除 {root} 整个目录：程序、历史版本、config.json、账号凭证与状态（data/）、缓存和日志。',
      purgeKept: '无法撤销。之后想继续用，需要重新安装后端并重新登录账号。',
      purgeConfirm: '确认彻底卸载',
      autoUpdateLabel: '自动更新后端',
      autoUpdateHint: '后台下载发布满 {hours} 小时的正式版，下次启动 DSH 时安装；新版本起不来会自动退回原版本。',
      autoUpdateUnavailable: '后端程序是在配置里自己指定的（或关了版本管理），插件不管它的版本，自动更新不生效。',
      autoUpdateTiara: 'Tiara 没有正式发布版本，插件还要按它的源码打兼容补丁，所以不自动更新；有新提交时请手动点「更新」。',
      autoUpdatePending: '已下载 {tag}，下次启动 DSH 时自动安装。',
      autoUpdateLast: '{time} 已自动从 {from} 更新到 {to}；有问题可点「回滚」。',
      autoUpdateFailed: '自动更新到 {tag} 没成功（{reason}），原版本照常在用；这个版本不再自动安装，需要的话手动点「更新」。',
      autoUpdateRolledBack: '你从 {tag} 回滚过，自动更新会跳过它，等下一个新版本。',
      autoUpdateWaiting: '上游 {tag} 发布未满 {hours} 小时，{time} 之后自动下载。',
      autoUpdateDrifted: '当前后端程序被手动换过，自动更新不会覆盖它。',
      autoUpdateUnknown: '认不出当前后端的版本号，自动更新不生效；可以手动点「更新」。',
      autoUpdateError: '上次自动检查更新失败：{reason}',
      updateTitle: '插件更新',
      updateChecking: '正在检查更新…',
      updateCheck: '检查更新',
      updateCheckFailed: '检查更新失败：{reason}',
      updateCurrent: '当前运行版本：',
      updateLatestVersion: 'npm 最新版本：',
      updateUpToDate: '已是最新',
      updateAvailable: '有新版本',
      updatePendingRestart: '等待重启',
      updateNow: '更新到 v{version}',
      updateLinked: '本插件从本地目录安装，请更新源码后重新运行安装脚本。',
      updateManaged: '此安装由 DSH 统一管理，请通过宿主更新。',
      updateRunning: '正在更新…',
      updateCheckingTarget: '正在核对目标版本…',
      updateManagerFailed: '官方插件管理器检查失败：{reason}',
      updateSucceeded: '已更新到 v{version}。',
      updateRestartHint: '重启 DSH 后生效。',
      updateRestoreFailed: '恢复旧版本失败：{reason}。请在「插件」页检查并重新安装。',
      updateFailed: '更新失败：{reason}',
      updateNoCompatible: '官方插件管理器暂未提供可更新的兼容正式版。',
      updateNotUpdatable: '官方插件管理器不支持更新此安装，请在「插件」页查看安装来源。',
      updatePinnedInstall: '按指定版本安装',
      updatePinnedHint: '先复制下面的包名和版本，再到 DSH「插件」页卸载本插件，并在「添加插件」中粘贴安装。指定版本可避免 latest 因发布观察期选到旧版。卸载前无需清除插件数据，安装后重启 DSH。',
      updateCopySpec: '复制包名和版本',
      updateSpecCopied: '已复制 {spec}。到「插件」页卸载后，添加这个指定版本。',
      updateSpecCopyFailed: '复制失败，请选中包名和版本手动复制。',
      updateCancelled: '更新已取消。',
      updateRolledBack: '更新已回滚，插件保持在 v{version}。',
      updateUnknown: '未能确认更新结果，请检查「插件」页的实际安装版本后重试。',
      updateRemoving: '正在卸载旧版本…',
      updateInstalling: '正在安装新版本…',
      updateRestoring: '正在恢复旧版本…',
      updateLocal: '本地安装',
      updateUnsupported: '当前 DSH 未提供官方插件更新接口，请升级 DSH，或按下面的指定版本重新安装。',
    };

    const en = {
      title: 'OpenCode models',
      description: 'Select models for DSH. Prices are input / output USD per million tokens. A catalog entry does not prove inference availability.',
      summary: 'This plugin manages the OpenCode model list (selection and capabilities).',
      loading: 'Reading models from the backend…',
      modelsNotInstalled: 'The backend is not installed yet. Click "Install" under "Backend version" below; the model list refreshes once it is installed.',
      retry: 'Retry',
      selectAll: 'Select all',
      clearAll: 'Clear all',
      refresh: 'Refresh',
      save: 'Save',
      saveSync: 'Save and sync',
      syncEnabled: 'Sync to the DSH model list',
      syncHint: 'When enabled, saving updates the OpenCode model list immediately and DSH syncs it again on startup.',
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
      panelKeyCopy: 'Copy initial admin password',
      panelKeyWorking: 'Reading…',
      panelKeyCopied: 'Initial admin password copied. Sign in as admin; use your new password if you have changed it.',
      panelKeyManual: 'Could not write to the clipboard; select and copy it manually: ',
      panelKeyNone: 'Use the admin credentials configured for your backend.',
      gatewayTitle: 'Gateway',
      gatewayJason: 'jasonxu114514 (default)',
      gatewayTiara: 'TiaraBasori',
      gatewaySwitching: 'Switching…',
      gatewayWaiting: 'Switching to {name}, waiting for it to start…',
      gatewaySwitched: 'Switched to {name}.',
      gatewaySynced: 'Switched to {name}. Models, URL and credentials were saved and synchronized automatically.',
      gatewaySyncFailed: 'The gateway switched, but automatic synchronization did not finish: {reason}',
      gatewayNotInstalled: 'Switched to {name}; click Install below to install it.',
      gatewayTimeout: '{name} was not ready within {seconds} seconds. Check backend logs and retry.',
      gatewayTiaraHint: 'First install downloads dependencies and a separate OpenCode 1.x runtime and may take a few minutes. Check your model selection after switching; model IDs may differ.',
      uninstallTiaraTitle: 'Uninstall the Tiara backend?',
      uninstallTiaraDesc: 'Stops Tiara and its OpenCode child process, then deletes source, dependencies, runtime, versions and install cache.',
      uninstallTiaraKept: 'Keys, configuration and sessions in tiara/data/ and logs are kept.',
      panelKeyCopyTiara: 'Copy panel access key',
      panelKeyCopiedTiara: 'Access key copied. Paste it in the Tiara panel.',
      backendUninstalledTiara: 'Tiara uninstalled (tiara/data/ and logs kept).',
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
      backendNotInstalled: 'Not installed',
      backendAvailableInstall: 'Available to install: {tag}',
      backendStart: 'Retry start',
      backendStarted: 'Backend started.',
      backendProgressHint: 'Installation continues in the background. You can leave this page; keep DSH running until it finishes.',
      backendElapsed: 'Elapsed: {seconds}s',
      backendNoHistory: 'History: none',
      backendHistory: 'History: {list}',
      backendBuilt: 'built {time}',
      backendInstall: 'Install',
      backendUninstall: 'Uninstall',
      backendInstalled: 'Backend installed: {tag}.',
      backendNoAccounts: 'The backend is running but its catalog is not ready. Check upstream configuration and connectivity in the admin UI.',
      backendUninstalled: 'Backend uninstalled (config.json and data/ kept).',
      cancel: 'Cancel',
      uninstallTitle: 'Uninstall the backend?',
      uninstallDesc: 'Stops the backend and deletes its program files: opencode2api.exe, archived versions, download cache.',
      uninstallKept: 'Credentials and state (data/) plus config.json are kept.',
      uninstallConfirm: 'Uninstall',
      backendPurge: 'Fully uninstall',
      backendPurgeHint: 'Uninstalling this plugin in DSH does not delete {root}; click "Fully uninstall" first to remove it.',
      backendPurged: 'Cleared {root}. You can now uninstall this plugin on the Plugins page.',
      purgeTitle: 'Fully uninstall the backend?',
      purgeDesc: 'Stops the backend and deletes the whole {root} directory: program, archived versions, config.json, credentials and state (data/), cache and logs.',
      purgeKept: 'This cannot be undone. To use it again you will need to reinstall the backend and sign in to your accounts again.',
      purgeConfirm: 'Fully uninstall',
      autoUpdateLabel: 'Update the backend automatically',
      autoUpdateHint: 'Stable releases older than {hours} hours are downloaded in the background and installed the next time DSH starts; if the new version fails to start, the previous one is restored.',
      autoUpdateUnavailable: 'The backend executable is set in your config (or version management is off), so the plugin does not manage its version and automatic updates do not apply.',
      autoUpdateTiara: 'Tiara has no stable releases and the plugin patches its source for compatibility, so it is not updated automatically; click "Update" to install new commits by hand.',
      autoUpdatePending: '{tag} is downloaded and will be installed the next time DSH starts.',
      autoUpdateLast: 'Automatically updated from {from} to {to} at {time}; click "Roll back" if something is wrong.',
      autoUpdateFailed: 'The automatic update to {tag} did not succeed ({reason}); the previous version is still in use. This version will not be installed automatically again; click "Update" to install it by hand.',
      autoUpdateRolledBack: 'You rolled back from {tag}; automatic updates skip it and wait for the next release.',
      autoUpdateWaiting: 'Upstream {tag} is less than {hours} hours old; it will be downloaded after {time}.',
      autoUpdateDrifted: 'The backend executable was replaced by hand; automatic updates will not overwrite it.',
      autoUpdateUnknown: 'The current backend version cannot be identified, so automatic updates do not apply; you can still click "Update".',
      autoUpdateError: 'The last automatic update check failed: {reason}',
      updateTitle: 'Plugin update',
      updateChecking: 'Checking for updates…',
      updateCheck: 'Check for updates',
      updateCheckFailed: 'Update check failed: {reason}',
      updateCurrent: 'Running version: ',
      updateLatestVersion: 'Latest on npm: ',
      updateUpToDate: 'up to date',
      updateAvailable: 'update available',
      updatePendingRestart: 'waiting for restart',
      updateNow: 'Update to v{version}',
      updateLinked: 'This plugin is installed from a local directory. Update its source and run the installer again.',
      updateManaged: 'This installation is managed by DSH. Update it through the host.',
      updateRunning: 'Updating…',
      updateCheckingTarget: 'Checking the target version…',
      updateManagerFailed: 'Official plugin manager check failed: {reason}',
      updateSucceeded: 'Updated to v{version}.',
      updateRestartHint: 'Restart DSH to apply it.',
      updateRestoreFailed: 'Restoring the previous version failed: {reason}. Check and reinstall on the Plugins page.',
      updateFailed: 'Update failed: {reason}',
      updateNoCompatible: 'The official plugin manager offers no compatible stable update.',
      updateNotUpdatable: 'The official plugin manager cannot update this installation. Check its source on the Plugins page.',
      updatePinnedInstall: 'Install a specific version',
      updatePinnedHint: 'Copy the package and version below first, then uninstall this plugin on DSH\'s Plugins page and paste it into Add plugin. An exact version prevents latest from selecting an older release during the release-age wait. Keep the plugin data, then restart DSH after installation.',
      updateCopySpec: 'Copy package and version',
      updateSpecCopied: 'Copied {spec}. Uninstall on the Plugins page, then add this exact version.',
      updateSpecCopyFailed: 'Could not copy. Select the package and version and copy it manually.',
      updateCancelled: 'Update cancelled.',
      updateRolledBack: 'Update rolled back; the plugin stays at v{version}.',
      updateUnknown: 'The update outcome could not be confirmed. Check the installed version on the Plugins page before retrying.',
      updateRemoving: 'Removing the previous version…',
      updateInstalling: 'Installing the new version…',
      updateRestoring: 'Restoring the previous version…',
      updateLocal: 'Local installation',
      updateUnsupported: 'This DSH version has no official plugin update API. Upgrade DSH or reinstall the exact version below.',
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
      return sortRows(rows)
        .filter((row) => picked.has(row.id))
        .map((row) => row.id);
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
    async function waitForGateway(gateway, { waitMs = GATEWAY_WAIT_MS, pollMs = GATEWAY_POLL_MS, sleep } = {}) {
      const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        try {
          const snapshot = (await request(BACKEND_PATH, 'GET')).backend ?? {};
          if (snapshot.gateway === gateway) {
            if (snapshot.exeExists === false) return 'not-installed';
            const models = await request(MODELS_PATH, 'GET');
            if (models.ok) return 'ready';
          }
        } catch {
          /* 重启中：下一轮再看 */
        }
        await pause(pollMs);
      }
      return 'timeout';
    }

    /** 沿用新实例已保存的选择，不把旧页面的勾选草稿或当前目录固化为白名单。 */
    async function syncGatewayModels(gateway) {
      const refreshed = await request(MODELS_PATH, 'GET');
      if (!refreshed.ok) return { state: 'failed', reason: refreshed.reason };
      if (refreshed.enabled !== true) return { state: 'disabled' };
      // 读到目录不代表 DSH 的调用凭据已更新；保存同步会先校验并写入本地 Key，再更新 provider。
      // 只传开关，让宿主现取完整白名单；原本关闭同步时不擅自开启。
      const saved = await request(MODELS_PATH, 'POST', { gateway, enabled: true });
      const sync = saved.sync ?? {};
      if (!saved.ok || !['updated', 'unchanged'].includes(sync.state)) return { state: 'failed', reason: saved.reason ?? sync.reason ?? sync.state };
      return sync;
    }

    function renderUninstallConfirm({ t, Modal, h, onCancel, onConfirm, kind = 'uninstall', params, textKind }) {
      const prefix = textKind || kind;
      const cancel = h(
        'button',
        { key: 'cancel', type: 'button', className: 'dsm-oc-btn dsm-oc-btn-outline', onClick: onCancel },
        t('cancel'),
      );
      const confirm = h(
        'button',
        { key: 'confirm', type: 'button', className: 'dsm-oc-btn dsm-oc-btn-danger', onClick: onConfirm },
        t(`${kind}Confirm`, params),
      );
      const detail = h(
        'div',
        { className: 'dsm-oc-confirm-body' },
        h('p', { className: 'dsm-oc-hint' }, t(`${prefix}Desc`, params)),
        h('p', { className: 'dsm-oc-hint' }, t(`${prefix}Kept`, params)),
      );

      if (typeof Modal === 'function') {
        return h(
          Modal,
          {
            key: 'confirm',
            open: true,
            onClose: onCancel,
            title: t(`${prefix}Title`, params),
            description: t(`${prefix}Desc`, params),
            footer: [cancel, confirm],
          },
          detail,
        );
      }
      return h(
        'div',
        { key: 'confirm', className: 'dsm-oc-confirm' },
        h('div', { className: 'dsm-oc-confirm-title' }, t(`${prefix}Title`, params)),
        detail,
        h('div', { className: 'dsm-oc-toolbar' }, cancel, confirm),
      );
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function wbButton(key, kind, label, onClick, disabled) {
      return h('button', { key, type: 'button', className: `dsm-oc-btn dsm-oc-btn-${kind}`, disabled, onClick }, label);
    }

    function wbNotice(key, value) {
      if (!value) return null;
      return h(
        'p',
        { key, className: `dsm-oc-notice ${value.kind === 'error' ? 'dsm-oc-notice-error' : 'dsm-oc-notice-ok'}` },
        value.text,
      );
    }

    /**
     * remote 调用的结果是 `{ ok, value }` 信封（内置网页搜索页按 response.ok / response.value 读）；
     * 也兼容直接返回值的实现，失败统一抛 Error。
     */
    function unwrap(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok) return response.value;
        const error = response.error;
        throw new Error(error?.message ?? error?.code ?? 'remote call failed');
      }
      return response;
    }

    /** 官方管理结果 → 一句可展示的原因：管理错误的诊断，其次 pnpm 失败分类，最后是应用状态本身。 */
    function managementReason(result) {
      return result?.error?.diagnostic ?? result?.error?.code ?? result?.packageResult?.kind ?? result?.application ?? 'invalid response';
    }

    /**
     * 官方管理结果里算作"已装上"的应用状态：立即生效、等重启生效，
     * 以及 overridden（已写入 profile，只是启用状态被更高优先级的配置层盖住）。
     */
    const APPLIED_STATES = new Set(['applied', 'restart-required', 'overridden']);

    /**
     * 官方 updateBundle 的结果 → 卡片上的任务状态。只有走到安装步骤、宿主报已装上、且装上的正是目标版本
     * 才算成功；带 restore 时再核对装回的是不是原来的版本。
     */
    function officialOutcome(value, target) {
      const result = value?.result;
      const application = result?.application;
      if (value?.restore) {
        const restored = value.restore;
        const restoredOK = APPLIED_STATES.has(restored.application) && restored.version === value.from;
        return {
          channel: 'official',
          state: restoredOK ? 'rolled-back' : 'failed',
          installedVersion: restored.version,
          failure: { message: managementReason(result) },
          restoreFailure: restoredOK ? undefined : managementReason(restored),
          outcome: { restartRequired: restored.application === 'restart-required' },
        };
      }
      if (application === 'cancelled') return { channel: 'official', state: 'cancelled' };
      if (value?.step === 'install' && APPLIED_STATES.has(application) && result.version === target) {
        return {
          channel: 'official',
          state: 'succeeded',
          installedVersion: result.version,
          outcome: { restartRequired: application === 'restart-required' },
        };
      }
      // 宿主明确报 failed 时原因可信；其余情况（版本不符、停在卸载步骤等）说不清实际装了什么，提示去核对
      return { channel: 'official', state: 'failed', failure: { message: managementReason(result) }, unknown: application !== 'failed' };
    }

    /** 官方更新的 requestId：宿主按它把 update-state 进度与安装日志归到本次调用。 */
    function updateRequestId() {
      if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      // Web 版也可通过非本机 HTTP 打开；randomUUID 仅限安全上下文，getRandomValues 不受此限。
      const bytes = window.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    }

    /**
     * 官方插件管理器的 Remote 命名空间。没有声明进 inject（旧宿主也要能加载 OpenCode 卡片）；
     * 宿主没有这个命名空间时 cordis 取值会抛错，这里当作没有。
     */
    function pluginManagerOf(remote) {
      try {
        return remote?.pluginManager;
      } catch {
        return undefined;
      }
    }

    /** 官方更新器随插件生命周期共享；卡片挂卸只增减订阅，不重复提交更新。 */
    function createPluginUpdater(remote) {
      let snapshot = {
        version: { phase: 'loading' },
        manager: { phase: 'loading' },
        busy: false,
      };
      const listeners = new Set();
      let checking;
      let updating;
      /** 最近一次官方版本列表 `{ installed, at, value }`：同一已装版本在 VERSION_LIST_TTL_MS 内复用。 */
      let versionList;
      let disposed = false;

      const patch = (value) => {
        if (disposed) return;
        snapshot = { ...snapshot, ...value };
        for (const listener of listeners) listener();
      };

      const loadVersion = async (force) => {
        try {
          const value = await request(force ? `${VERSION_PATH}?force=1` : VERSION_PATH, 'GET');
          patch({ version: { ...value, phase: value.ok ? 'ready' : 'error' } });
        } catch (error) {
          patch({ version: { ...snapshot.version, phase: 'error', reason: errorText(error) } });
        }
      };

      /** 读宿主的插件列表：安装来源、官方更新资格与实际安装版本。 */
      const readManager = async () => {
        const manager = pluginManagerOf(remote);
        const official = typeof manager?.listVersions === 'function' && typeof manager?.updateBundle === 'function';
        let bundle;
        try {
          if (typeof manager?.listBundles === 'function') {
            const bundles = unwrap(await manager.listBundles());
            if (!Array.isArray(bundles)) throw new Error('Invalid bundle list');
            bundle = bundles.find((item) => item.name === PACKAGE_NAME);
          }
        } catch (error) {
          // 新宿主以插件列表为准，读不到就报错；旧宿主缺少更新接口时保留版本检查和手动安装提示
          if (official) throw error;
        }
        const state = {
          // source 是 pnpm add 认的规格，本地目录安装以 file: / link: 开头
          local: /^(?:file:|link:)/.test(bundle?.source ?? ''),
          // DSH 自带的官方 bundle 或安装包里的副本，跟着 DSH 版本走
          managed: bundle?.official === true || bundle?.availability === 'installation',
          installedVersion: bundle?.version,
        };
        if (!official) return { ...state, phase: 'unsupported' };
        if (state.local || state.managed || !bundle || bundle.updatable !== true) return { ...state, phase: 'blocked' };
        return { ...state, phase: 'ready' };
      };

      /** 官方版本列表 → 可更新的目标版本。 */
      const listCandidate = async (state, force) => {
        const fresh = versionList?.installed === state.installedVersion && Date.now() - versionList.at < VERSION_LIST_TTL_MS;
        if (fresh && !force) return versionList.value;
        // npm 已是最新时不列版本，省下宿主上那串 pnpm view；npm 落后于宿主注册表的少见情况，点「检查更新」即可
        if (!force && snapshot.version.phase === 'ready' && !snapshot.version.updateAvailable) return { candidate: undefined };
        const list = unwrap(await pluginManagerOf(remote).listVersions(PACKAGE_NAME, {}));
        if (list?.status === 'refused') {
          if (list.problem === 'not-updatable') return { phase: 'blocked', reason: list.reason };
          throw new Error(list.reason ?? list.problem);
        }
        if (list?.status !== 'listed' || !Array.isArray(list.versions)) throw new Error('Invalid version list');
        // 宿主只列比已装版本新的、按版本倒序；不自动选预发布、弃用或不兼容版本，npm latest 不代表能装
        const candidate = list.versions.find((item) => item.bundle === true && item.prerelease === false
          && !item.deprecated && !item.incompatible && pinnedInstallSpec(item.version)
          && versionBelow(list.installed, item.version));
        const value = { installedVersion: list.installed, candidate: candidate?.version, registry: list.registry };
        versionList = { installed: state.installedVersion, at: Date.now(), value };
        return value;
      };

      /**
       * 检查版本与更新途径。quiet 给宿主的插件变更广播用：不把区块切成"正在检查"，只静默重读，
       * 避免在插件页上开关别的插件时这块跟着闪。
       */
      const run = (force, quiet) => {
        if (disposed) return Promise.resolve();
        if (updating) return updating;
        if (checking) return checking;
        if (!quiet) {
          // 保留上一次的版本号与安装来源：重新检查时那几行不闪
          patch({
            version: { ...snapshot.version, phase: 'loading' },
            manager: { ...snapshot.manager, phase: 'loading' },
          });
        }
        const failure = (error) => ({ phase: 'error', reason: errorText(error) });
        checking = Promise.all([loadVersion(force), readManager().catch(failure)])
          .then(async ([, state]) => {
            if (disposed) return;
            // 宿主版本路由也能识别本地拷贝；这种安装没有 npm 目标，不能因远程列表缺席而误提供更新。
            let manager = snapshot.version.installSource === 'local' ? { ...state, phase: 'blocked', local: true } : state;
            if (manager.phase === 'ready') {
              try {
                manager = { ...manager, ...(await listCandidate(manager, force)) };
              } catch (error) {
                manager = { ...manager, ...failure(error) };
              }
            }
            // 外部更新 / 重装之后，旧任务的成功版本不能覆盖刚读到的安装事实；读不到安装版本时不下结论
            const { operation } = snapshot;
            const stale = operation?.installedVersion && manager.installedVersion && manager.installedVersion !== operation.installedVersion;
            patch({ manager, operation: stale ? undefined : operation });
          })
          .finally(() => {
            checking = undefined;
          });
        return checking;
      };

      const startOfficial = (target, registry) => {
        const requestId = updateRequestId();
        patch({
          busy: true,
          target,
          operation: { channel: 'official', state: 'running', step: 'checking', requestId },
        });
        // 锁、卸载、安装与失败恢复都交给宿主。只显示本次 requestId 的阶段，不伪造百分比。
        updating = Promise.resolve().then(async () => {
          let off;
          try {
            if (disposed) return;
            off = remote.$on('plugin-manager/update-state', (progress) => {
              if (progress.requestId === requestId && UPDATE_STEPS[progress.step]) {
                patch({ operation: { ...snapshot.operation, step: progress.step } });
              }
            });
            const answer = await pluginManagerOf(remote).updateBundle(PACKAGE_NAME, target, { registry, requestId });
            const operation = officialOutcome(unwrap(answer), target);
            const installedVersion = operation.installedVersion ?? snapshot.manager.installedVersion;
            patch({ operation, manager: { ...snapshot.manager, installedVersion } });
          } catch (error) {
            // 连接断开不等于宿主取消了安装；不冒充成功，也不自动重试写操作
            patch({ operation: { channel: 'official', state: 'failed', failure: { message: errorText(error) }, unknown: true } });
          } finally {
            if (typeof off === 'function') off();
            // 成功后已装版本变了，失败后宿主给的版本事实也可能变了：下次检查重新列版本
            versionList = undefined;
            patch({ busy: false, manager: { ...snapshot.manager, candidate: undefined } });
            updating = undefined;
          }
        });
        return updating;
      };

      const startUpdate = () => {
        if (disposed) return Promise.resolve();
        if (updating) return updating;
        if (checking) return Promise.resolve();
        const { manager } = snapshot;
        if (manager.phase === 'ready' && manager.candidate) return startOfficial(manager.candidate, manager.registry);
        return Promise.resolve();
      };

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        check: (force = false) => run(force, false),
        refresh: () => run(false, true),
        startUpdate,
        dispose: () => {
          disposed = true;
          listeners.clear();
        },
      };
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
      return /-/.test(String(installed).split('+')[0]) && !/-/.test(String(target).split('+')[0]);
    }

    function isActiveOperation(operation) {
      return operation?.state === 'running';
    }

    /** npm 的安装规格用不带 v 的明确版本；拒绝标签、范围和其它安装来源。 */
    function pinnedInstallSpec(version) {
      if (typeof version !== 'string') return undefined;
      const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(version.trim());
      return match ? `${PACKAGE_NAME}@${match[1]}` : undefined;
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
      const hint = auto.available === false
        ? t(auto.unavailable === 'unsupported-gateway' ? 'autoUpdateTiara' : 'autoUpdateUnavailable')
        : t('autoUpdateHint', { hours: auto.delayHours ?? 24 });
      const out = [
        h(
          'label',
          { key: 'autoUpdate', className: 'dsm-oc-sync' },
          h('input', {
            type: 'checkbox',
            checked: auto.enabled === true,
            disabled: Boolean(busy) || auto.available === false,
            onChange: (event) => onToggle(event.target.checked),
          }),
          t('autoUpdateLabel'),
        ),
        h('p', { key: 'autoUpdateHint', className: 'dsm-oc-hint' }, hint),
      ];
      if (auto.enabled !== true || auto.available === false) return out;

      const line = (key, text) => h('p', { key, className: 'dsm-oc-backend-line' }, text);
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

    /** 官方插件更新区；本地安装沿用源码更新，不显示 npm 检查和安装入口。 */
    function renderUpdateSection(update, actions, t) {
      const { version, manager, operation } = update;
      const running = Boolean(update.busy) || isActiveOperation(operation);
      const local = manager.local === true || version.installSource === 'local';
      const managed = manager.managed === true;
      const ready = version.phase === 'ready' && !local;
      // 当前运行代码要等重启才换，按钮与徽章按实际安装版本判断，避免重复安装。
      const installed = operation?.state === 'succeeded' ? operation.installedVersion : manager.installedVersion;
      const latestInstalled = ready && Boolean(installed) && !versionBelow(installed, version.latestVersion);
      const outdated = ready && version.updateAvailable && !latestInstalled;
      // npm latest 只供显示；更新目标必须来自宿主认可的兼容正式版。
      const target = !local && !managed && manager.phase === 'ready' && manager.candidate
        && (!installed || versionBelow(installed, manager.candidate)) ? manager.candidate : undefined;

      const head = [h('span', { key: 'title', className: 'dsm-oc-backend-title' }, t('updateTitle'))];
      if (local) head.push(h('span', { key: 'local', className: 'dsm-oc-badge' }, t('updateLocal')));
      if (ready) {
        const pending = latestInstalled && operation?.state === 'succeeded' && operation.outcome?.restartRequired;
        const label = pending ? 'updatePendingRestart' : target || outdated ? 'updateAvailable' : 'updateUpToDate';
        head.push(h('span', { key: 'badge', className: 'dsm-oc-badge dsm-oc-badge-' + (pending || target || outdated ? 'new' : 'ok') }, t(label)));
      }
      if (!local) {
        head.push(wbButton('check', 'outline', t('updateCheck'), actions.checkUpdate, version.phase === 'loading' || manager.phase === 'loading' || running));
      }
      if (target) {
        head.push(wbButton('update', 'primary', running ? t('updateRunning') : t('updateNow', { version: target }), actions.startUpdate, running));
      }

      const section = [h('div', { key: 'head', className: 'dsm-oc-backend-head' }, head)];
      if (local) {
        section.push(h('p', { key: 'localHint', className: 'dsm-oc-hint' }, t('updateLinked')));
      } else if (version.phase === 'loading') {
        section.push(h('p', { key: 'checking', className: 'dsm-oc-backend-line' }, t('updateChecking')));
      } else if (version.phase === 'error') {
        section.push(wbNotice('checkError', { kind: 'error', text: t('updateCheckFailed', { reason: version.reason }) }));
      }
      if (version.currentVersion) {
        section.push(h('p', { key: 'versions', className: 'dsm-oc-backend-line' },
          t('updateCurrent'), h('span', { className: 'dsm-oc-code' }, 'v' + version.currentVersion),
          ready ? '  ·  ' : null, ready ? t('updateLatestVersion') : null,
          ready ? h('span', { className: 'dsm-oc-code' }, 'v' + version.latestVersion) : null));
      }
      if (!local && manager.phase === 'error') {
        section.push(wbNotice('managerError', { kind: 'error', text: t('updateManagerFailed', { reason: manager.reason }) }));
      }
      if (outdated && !target && !operation) {
        const blocker = managed ? 'updateManaged'
          : { blocked: 'updateNotUpdatable', ready: 'updateNoCompatible', unsupported: 'updateUnsupported' }[manager.phase];
        if (blocker) section.push(h('p', { key: 'unavailable', className: 'dsm-oc-hint' }, t(blocker)));
      }

      if (isActiveOperation(operation)) {
        section.push(h('p', { key: 'progress', className: 'dsm-oc-backend-line' }, t(UPDATE_STEPS[operation.step] ?? 'updateRunning')));
      } else if (operation?.state === 'succeeded') {
        const parts = [t('updateSucceeded', { version: operation.installedVersion })];
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        section.push(wbNotice('done', { kind: 'ok', text: parts.join(' ') }));
      } else if (operation?.state === 'failed') {
        section.push(wbNotice('failed', { kind: 'error', text: t('updateFailed', { reason: operation.failure?.message ?? '' }) }));
        if (operation.restoreFailure) {
          section.push(wbNotice('restoreFailed', { kind: 'error', text: t('updateRestoreFailed', { reason: operation.restoreFailure }) }));
        }
        if (operation.unknown) section.push(wbNotice('unknown', { kind: 'error', text: t('updateUnknown') }));
      } else if (operation?.state === 'cancelled') {
        section.push(wbNotice('cancelled', { kind: 'error', text: t('updateCancelled') }));
      } else if (operation?.state === 'rolled-back') {
        const parts = [];
        if (operation.failure?.message) parts.push(t('updateFailed', { reason: operation.failure.message }));
        parts.push(t('updateRolledBack', { version: operation.installedVersion }));
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        section.push(wbNotice('rolledBack', { kind: 'error', text: parts.join(' ') }));
      }

      // 旧宿主或查询失败时允许手动指定版本；不绕过官方已确认的安装资格或兼容性限制。
      const spec = outdated ? pinnedInstallSpec(version.latestVersion) : undefined;
      if (spec && !running && !local && !managed && ['unsupported', 'error'].includes(manager.phase)) {
        section.push(h('details', { key: 'pinnedInstall', open: manager.phase === 'unsupported' },
          h('summary', { className: 'dsm-oc-backend-line' }, t('updatePinnedInstall')),
          h('p', { className: 'dsm-oc-hint' }, t('updatePinnedHint')),
          h('input', {
            className: 'dsm-oc-input dsm-oc-install-spec', type: 'text', readOnly: true, value: spec,
            'aria-label': t('updatePinnedInstall'), onFocus: (event) => event.currentTarget.select(),
          }),
          h('div', { className: 'dsm-oc-toolbar' }, wbButton('copySpec', 'outline', t('updateCopySpec'), actions.copyInstallSpec, false))));
      }
      section.push(wbNotice('updateNotice', update.notice));
      return section;
    }

    /**
     * 「插件更新」区块接到共享的更新器上（见 createPluginUpdater）：状态与进行中的任务都在 api.updater 里，
     * 卡片挂卸只增减订阅。这里只多管一条复制规格的提示。
     */
    function useUpdater(t, api) {
      const updater = api.updater;
      const [update, setUpdate] = useState(() => updater.getSnapshot());
      const [notice, setNotice] = useState(undefined);
      useEffect(() => {
        const off = updater.subscribe(() => setUpdate(updater.getSnapshot()));
        setUpdate(updater.getSnapshot());
        // 版本路由与官方版本列表都有缓存，挂载时不强制重查
        updater.check();
        return off;
      }, [updater]);
      return {
        model: { ...update, notice },
        actions: {
          checkUpdate: () => {
            setNotice(undefined);
            return updater.check(true);
          },
          startUpdate: () => {
            setNotice(undefined);
            return updater.startUpdate();
          },
          copyInstallSpec: async () => {
            const spec = pinnedInstallSpec(update.version.latestVersion);
            if (!spec) return;
            try {
              await window.navigator.clipboard.writeText(spec);
              setNotice({ kind: 'ok', text: t('updateSpecCopied', { spec }) });
            } catch {
              setNotice({ kind: 'error', text: t('updateSpecCopyFailed') });
            }
          },
        },
      };
    }

    function ModelsCard({ t, view, api }) {
      const [phase, setPhase] = useState('loading');
      const [rows, setRows] = useState([]);
      const [meta, setMeta] = useState({});
      const [reason, setReason] = useState('');
      const [picked, setPicked] = useState(() => new Set());
      const [savedPicked, setSavedPicked] = useState(() => new Set());
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(undefined);

      const load = useCallback(async () => {
        setPhase('loading');
        setNotice(undefined);
        try {
          const payload = await request(MODELS_PATH, 'GET');
          if (!payload.ok) {
            setRows([]);
            setPicked(new Set());
            setSavedPicked(new Set());
            setMeta({ enabled: payload.enabled, savedEnabled: payload.enabled, patchPath: payload.patchPath });
            // 没装后端时只记状态码，渲染时再翻成"去点安装"（load 不依赖 t，避免 t 变化时反复重载）。
            setReason(payload.state === BACKEND_NOT_INSTALLED ? BACKEND_NOT_INSTALLED : (payload.reason ?? ''));
            setPhase('error');
            return;
          }
          const list = payload.models ?? [];
          const selected = new Set(list.filter((row) => row.selected).map((row) => row.id));
          setRows(list);
          setMeta({ enabled: payload.enabled, savedEnabled: payload.enabled, patchPath: payload.patchPath, url: payload.url });
          setPicked(selected);
          setSavedPicked(new Set(selected));
          setPhase('ready');
        } catch (error) {
          setMeta({});
          setReason(error instanceof Error ? error.message : String(error));
          setPhase('error');
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      // 已选项置顶，组内保留原顺序；保存白名单仍沿用原排序规则。
      const sorted = useMemo(() => sortRows(rows)
        .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id))), [rows, picked]);

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
            only: orderedSelection(rows, picked),
          });
          if (!payload.ok) {
            setNotice({ kind: 'error', text: payload.reason ?? t('saveFailed') });
            return;
          }
          const sync = payload.sync ?? {};
          // 先重载再出提示：load() 开头会清空 notice，反过来写会把结果（尤其是同步失败的原因）立刻抹掉。
          await load();
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
      }, [rows, picked, meta.enabled, load, t]);

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
          setBackendOperation(payload.operation);
          setBackendBusy(payload.operation?.state === 'running' ? payload.operation.action : undefined);
          if (payload.backend?.latest) setCheck({ latest: payload.backend.latest,
            upToDate: payload.backend.exeExists && payload.backend.version?.revision === payload.backend.latest.commit });
          return payload;
        } catch (error) {
          // 暂时断线不抹掉已知的安装状态与进度，后续轮询继续恢复。
          setBackendNotice({ kind: 'error', text: errorText(error) });
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
        await load();
        setNotice(notice);
      }, [t, load]);

      const runBackend = useCallback(
        async (action, extra) => {
          setBackendBusy(action);
          setBackendNotice(undefined);
          let accepted = false;
          try {
            const payload = await request(BACKEND_PATH, 'POST', { action, ...(extra ?? {}) });
            if (payload.backend) setBackend(payload.backend);
            if (payload.operation) {
              accepted = true;
              setBackendOperation(payload.operation);
              setBackendBusy(payload.operation.state === 'running' ? payload.operation.action : undefined);
            } else if (action === 'check') {
              setCheck(payload.check?.error ? { error: payload.check.error } : payload.check);
            } else if (payload.ok) {
              setCheck(undefined);
              const done = t(action === 'uninstall' && payload.backend?.gateway === 'tiara' ? 'backendUninstalledTiara' : (BACKEND_NOTICE[action] ?? 'backendUpdated'), {
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
            const recovered = await loadBackend();
            accepted = recovered?.operation?.state === 'running';
          } finally {
            if (!accepted) setBackendBusy(undefined);
          }
        },
        [t, load, loadBackend, enableSyncAfterInstall],
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
      const updater = useUpdater(t, api);

      // 同样排在既有 hooks 之后。控制台的密钥只存在用户浏览器的 localStorage 里（按来源隔离），
      // 插件不代填管理页登录表单，用户显式复制保存在 data/ 中的初始密码。
      const [panelKey, setPanelKey] = useState(undefined);
      const copyPanelKey = useCallback(async () => {
        setPanelKey({ busy: true });
        try {
          const payload = await request(PANEL_KEY_PATH, 'POST', {});
          if (!payload.key) {
            setPanelKey({ kind: 'ok', text: t('panelKeyNone') });
            return;
          }
          try {
            await navigator.clipboard.writeText(payload.key);
            setPanelKey({ kind: 'ok', text: t(payload.gateway === 'tiara' ? 'panelKeyCopiedTiara' : 'panelKeyCopied') });
          } catch {
            // 剪贴板 API 可能被宿主/非安全上下文拒绝：退回显示原文，让用户自己选中复制。
            setPanelKey({ kind: 'manual', key: payload.key });
          }
        } catch (error) {
          setPanelKey({ kind: 'error', text: errorText(error) });
        }
      }, [t]);

      const [gatewaySwitch, setGatewaySwitch] = useState(undefined);
      const [backendOperation, setBackendOperation] = useState(undefined);
      const operationRunning = backendOperation?.state === 'running';
      useEffect(() => {
        if (!operationRunning) return undefined;
        let stopped = false, timer;
        const tick = async () => {
          await loadBackend();
          if (!stopped) timer = setTimeout(tick, POLL_MS);
        };
        timer = setTimeout(tick, POLL_MS);
        return () => { stopped = true; clearTimeout(timer); };
      }, [operationRunning, backendOperation?.id, loadBackend]);
      useEffect(() => {
        if (!backendOperation || operationRunning) return;
        const result = backendOperation.result ?? {};
        const action = backendOperation.action;
        if (result.ok) {
          const key = action === 'start' ? 'backendStarted' : action === 'uninstall' && backendOperation.gateway === 'tiara'
            ? 'backendUninstalledTiara' : BACKEND_NOTICE[action] ?? 'backendUpdated';
          setBackendNotice({ kind: 'ok', text: t(key, { tag: result.latest?.tag ?? result.local?.tag ?? '', root: result.root ?? '' }) });
        } else setBackendNotice({ kind: 'error', text: result.reason ?? result.state ?? '' });
        load().then(() => {
          if (result.sync) setNotice(result.sync.state === 'updated' || result.sync.state === 'unchanged'
            ? { kind: 'ok', text: t('savedSync', { count: result.sync.count ?? 0 }) }
            : { kind: 'error', text: t('savedNoSync', { state: result.sync.reason ?? result.sync.state ?? '' }) });
        });
      }, [backendOperation?.id, backendOperation?.state, operationRunning, t, load]);
      const switchGateway = useCallback(async (gateway, label) => {
        setPanelKey(undefined);
        setCheck(undefined);
        setBackendNotice(undefined);
        setGatewaySwitch({ busy: gateway, kind: 'ok', text: t('gatewayWaiting', { name: label }) });
        try {
          const payload = await request(BACKEND_PATH, 'POST', { action: 'gateway', gateway });
          if (!payload.ok) {
            setGatewaySwitch({ kind: 'error', text: payload.reason ?? '' });
            return;
          }
          const outcome = payload.state === 'switched' ? await waitForGateway(gateway) : 'ready';
          const sync = outcome === 'ready' ? await syncGatewayModels(gateway) : undefined;
          await loadBackend();
          await load(false);
          const syncFailed = sync?.state === 'failed';
          const key = syncFailed ? 'gatewaySyncFailed'
            : ['updated', 'unchanged'].includes(sync?.state) ? 'gatewaySynced'
              : { ready: 'gatewaySwitched', 'not-installed': 'gatewayNotInstalled' }[outcome] ?? 'gatewayTimeout';
          setGatewaySwitch({
            kind: outcome === 'timeout' || syncFailed ? 'error' : 'ok',
            text: t(key, { name: label, seconds: GATEWAY_WAIT_MS / 1000, reason: sync?.reason ?? t('saveFailed') }),
          });
        } catch (error) {
          setGatewaySwitch({ kind: 'error', text: errorText(error) });
        }
      }, [t, loadBackend, load]);


      // 行详情页在缺少包描述时才用 summary 视图；本包有 description，正常走 page。
      if (view === 'summary') {
        return h('p', { className: 'dsm-oc-desc' }, t('summary'));
      }

      // enabled 是开关草稿，savedEnabled 是上次读取的配置；只切换开关也必须允许保存。
      const dirty = !sameSet(picked, savedPicked) || meta.enabled !== meta.savedEnabled;
      const body = [];

      if (operationRunning) {
        body.push(h('div', { key: 'loading', className: 'dsm-oc-empty' }, t('backendProgressHint')));
      } else if (phase === 'loading') {
        body.push(h('div', { key: 'loading', className: 'dsm-oc-empty' }, t('loading')));
      } else if (phase === 'error') {
        body.push(
          h(
            'div',
            { key: 'error', className: 'dsm-oc-empty' },
            h('div', { className: 'dsm-oc-notice dsm-oc-notice-error' }, reason === BACKEND_NOT_INSTALLED ? t('modelsNotInstalled') : reason),
            h('button', { type: 'button', className: 'dsm-oc-btn dsm-oc-btn-outline', onClick: load }, t('retry')),
          ),
        );
      } else {
        body.push(
          h(
            'label',
            { key: 'sync', className: 'dsm-oc-sync' },
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
          h('p', { key: 'syncHint', className: 'dsm-oc-hint' }, t(meta.enabled === true ? 'syncHint' : 'disabledHint')),
        );
        body.push(
          h(
            'div',
            { key: 'toolbar', className: 'dsm-oc-toolbar' },
            h('span', { className: 'dsm-oc-count' }, t('count', { total: sorted.length, picked: picked.size })),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-oc-btn dsm-oc-btn-outline',
                disabled: saving,
                onClick: () => {
                  setPicked(new Set(sorted.map((row) => row.id)));
                  setNotice(undefined);
                },
              },
              t('selectAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-oc-btn dsm-oc-btn-outline',
                disabled: saving,
                onClick: () => {
                  setPicked(new Set());
                  setNotice(undefined);
                },
              },
              t('clearAll'),
            ),
            h('button', { type: 'button', className: 'dsm-oc-btn dsm-oc-btn-outline', disabled: saving, onClick: load }, t('refresh')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-oc-btn dsm-oc-btn-primary',
                // 同步已开启时允许重复保存，修复旧清单或重试上次失败无需先改勾选。
                disabled: saving || (!dirty && meta.enabled !== true),
                onClick: save,
              },
              saving ? t('saving') : t(meta.enabled === true ? 'saveSync' : 'save'),
            ),
          ),
        );

        if (sorted.length === 0) {
          body.push(h('div', { key: 'empty', className: 'dsm-oc-empty' }, t('emptyBackend')));
        } else {
          body.push(
            h(
              'div',
              { key: 'list', className: 'dsm-oc-list' },
              sorted.map((row) =>
                h(
                  'label',
                  { key: row.id, className: 'dsm-oc-row', title: row.id },
                  h('input', {
                    type: 'checkbox',
                    checked: picked.has(row.id),
                    disabled: saving,
                    onChange: () => toggle(row.id),
                  }),
                  h('span', { className: 'dsm-oc-label' }, row.label),
                  h(
                    'span',
                    { className: 'dsm-oc-meta' },
                    row.vision ? h('span', { className: 'dsm-oc-tag' }, t('vision')) : null,
                    formatTokens(row.contextWindow)
                      ? h('span', { className: 'dsm-oc-tag' }, formatTokens(row.contextWindow))
                      : null,
                    h(
                      'span',
                      { className: `dsm-oc-credits${row.credits === 'Free' ? ' dsm-oc-credits-free' : ''}` },
                      row.credits,
                    ),
                  ),
                ),
              ),
            ),
          );
        }

        if (picked.size === 0 && sorted.length > 0) {
          body.push(h('p', { key: 'emptyHint', className: 'dsm-oc-hint' }, t('emptyHint')));
        }
      }

      if (notice) {
        body.push(
          h(
            'p',
            {
              key: 'notice',
              className: `dsm-oc-notice ${notice.kind === 'error' ? 'dsm-oc-notice-error' : 'dsm-oc-notice-ok'}`,
            },
            notice.text,
          ),
        );
      }
      if (meta.patchPath) {
        body.push(h('p', { key: 'path', className: 'dsm-oc-path' }, t('patchPath', { path: meta.patchPath })));
      }

      // 后端版本区：检查 / 安装 / 更新 / 卸载 / 回滚。数据来自宿主半侧的 /backend 端点，
      // 首屏那次 GET 不联网（快），点"检查更新"才真去查 release。
      if (backend) {
        const version = backend.version ?? {};
        const currentTag = version.tag ?? (version.revision ? version.revision.slice(0, 7) : null)
          ?? t(backend.exeExists === false ? 'backendNotInstalled' : 'backendUnmanaged');
        const history = Array.isArray(backend.history) ? backend.history : [];
        const latestTag = check?.latest?.tag ?? '';
        // 老快照没有 exeExists 字段时按"已安装"处理，避免误显示成未安装。
        const installed = backend.exeExists !== false;

        // 老宿主的快照没有 gateways 字段：不显示切换（它也不认 gateway 动作）。
        const gateways = Array.isArray(backend.gateways) ? backend.gateways : [];
        const currentGateway = backend.gateway ?? 'jasonxu';
        const gatewayLabel = (id) => t(id === 'tiara' ? 'gatewayTiara' : 'gatewayJason');
        const section = [];
        if (gateways.length > 1) {
          const gatewayBlock = [
            h(
              'div',
              { key: 'gateway', className: 'dsm-oc-backend-head' },
              h('span', { className: 'dsm-oc-backend-title' }, t('gatewayTitle')),
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
          if (currentGateway === 'tiara') {
            gatewayBlock.push(h('p', { key: 'gatewayHint', className: 'dsm-oc-backend-line' }, t('gatewayTiaraHint')));
          }
          const switched = wbNotice('gatewayNotice', gatewaySwitch);
          if (switched) gatewayBlock.push(switched);
          section.push(h('div', { key: 'gatewayBlock', className: 'dsm-oc-gateway' }, gatewayBlock));
        }
        section.push(
          h(
            'div',
            { key: 'head', className: 'dsm-oc-backend-head' },
            h('span', { className: 'dsm-oc-backend-title' }, t('backendTitle')),
            check && !check.error
              ? h(
                  'span',
                  { className: `dsm-oc-badge ${check.upToDate ? 'dsm-oc-badge-ok' : 'dsm-oc-badge-new'}` },
                  check.upToDate ? t('backendUpToDate') : t(installed ? 'backendAvailable' : 'backendAvailableInstall', { tag: latestTag }),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-oc-btn dsm-oc-btn-outline',
                disabled: Boolean(backendBusy || gatewaySwitch?.busy),
                onClick: () => runBackend('check'),
              },
              backendBusy === 'check' ? t('backendWorking') : t('backendCheck'),
            ),
            // 安装与卸载互斥：没装才显示"安装"，装了才显示"卸载"。
            // 顺序按使用频率排：更新 → 回滚 → 卸载 → 彻底卸载（删除类放最后，离"检查更新"最远，减少误点）。
            installed && currentGateway === 'tiara'
              ? wbButton('start', 'outline', t('backendStart'), () => runBackend('start'), Boolean(backendBusy || gatewaySwitch?.busy))
              : null,
            installed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-oc-btn dsm-oc-btn-primary',
                    disabled: Boolean(backendBusy || gatewaySwitch?.busy),
                    onClick: () => runBackend('update'),
                  },
                  backendBusy === 'update' ? t('backendWorking') : t('backendUpdate'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-oc-btn dsm-oc-btn-primary',
                    disabled: Boolean(backendBusy || gatewaySwitch?.busy),
                    onClick: () => runBackend('install'),
                  },
                  backendBusy === 'install' ? t('backendWorking') : t('backendInstall'),
                ),
            installed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-oc-btn dsm-oc-btn-outline',
                    disabled: Boolean(backendBusy || gatewaySwitch?.busy),
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
                    className: 'dsm-oc-btn dsm-oc-btn-danger',
                    disabled: Boolean(backendBusy || gatewaySwitch?.busy),
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
                    className: 'dsm-oc-btn dsm-oc-btn-danger',
                    disabled: Boolean(backendBusy || gatewaySwitch?.busy),
                    onClick: () => setConfirming('purge'),
                  },
                  backendBusy === 'purge' ? t('backendWorking') : t('backendPurge'),
                )
              : null,
          ),
          h(
            'p',
            { key: 'current', className: 'dsm-oc-backend-line' },
            h('strong', null, t('backendCurrent', { version: currentTag })),
            version.builtAt ? ` · ${t('backendBuilt', { time: version.builtAt })}` : '',
          ),
        );

        if (operationRunning) {
          const progress = backendOperation.progress ?? {};
          const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
          const bytes = typeof progress.received === 'number'
            ? ` · ${mb(progress.received)}${progress.total ? ` / ${mb(progress.total)} (${Math.min(100, Math.floor(progress.received / progress.total * 100))}%)` : ''}` : '';
          section.push(h('div', { key: 'progress', role: 'status', 'aria-live': 'polite', className: 'dsm-oc-backend-line' },
            progress.detail || t('backendWorking'), bytes, ` · ${t('backendElapsed', { seconds: Math.max(0, Math.floor((Date.now() - Date.parse(backendOperation.startedAt)) / 1000)) })}`));
        }

        if (confirming) {
          // 老状态里可能是 true（改成动作名之前的写法），按卸载处理。
          const kind = confirming === 'purge' ? 'purge' : 'uninstall';
          section.push(renderUninstallConfirm({
            t, Modal, h, kind, params: { root: backend.root ?? '' },
            textKind: kind === 'uninstall' && currentGateway === 'tiara' ? 'uninstallTiara' : undefined,
            onCancel: () => setConfirming(false),
            onConfirm: () => { setConfirming(false); runBackend(kind, { confirm: true }); },
          }));
        }

        if (check?.error) {
          section.push(h('p', { key: 'checkError', className: 'dsm-oc-backend-line' }, check.error));
        } else if (check) {
          section.push(
            h(
              'p',
              { key: 'latest', className: 'dsm-oc-backend-line' },
              h('strong', null, t('backendLatest', { tag: latestTag })),
            ),
          );
        }

        section.push(
          h(
            'p',
            { key: 'history', className: 'dsm-oc-backend-line' },
            history.length ? t('backendHistory', { list: history.map((item) => item.name).join(', ') }) : t('backendNoHistory'),
          ),
        );

        // 没装就没有可更新的东西：首次安装永远由用户点。
        if (installed) {
          section.push(...renderAutoUpdate(backend.autoUpdate, version.tag ?? null,
            { busy: backendBusy || gatewaySwitch?.busy, onToggle: toggleAutoUpdate }, t));
        }

        // DSH 卸载插件时不通知插件，数据目录只能靠用户在卸载前点「彻底卸载」清掉，这里写明会删哪个目录。
        if (backend.rootExists === true) {
          section.push(
            h(
              'p',
              { key: 'purgeHint', className: 'dsm-oc-backend-line' },
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
                className: `dsm-oc-notice ${backendNotice.kind === 'error' ? 'dsm-oc-notice-error' : 'dsm-oc-notice-ok'}`,
              },
              backendNotice.text,
            ),
          );
        }

        body.push(h('div', { key: 'backend', className: 'dsm-oc-backend' }, section));
      }

      // 插件自身的更新：放在最底部，与上面管 opencode2api 的"后端版本"区分开
      body.push(h('div', { key: 'pluginUpdate', className: 'dsm-oc-backend' }, renderUpdateSection(updater.model, updater.actions, t)));

      // 后端管理面板地址：宿主在 /backend 应答里给（端口可配），拿不到就用兜底值。
      const panelUrl = backend?.panelUrl ?? DEFAULT_PANEL_URL;
      const panelLabel = String(panelUrl).replace(/^https?:\/\//, '');

      return h(
        'div',
        { className: 'dsm-oc-card' },
        h('div', { className: 'dsm-oc-title' }, t('title')),
        h('p', { className: 'dsm-oc-desc' }, t('description')),
        h(
          'p',
          { className: 'dsm-oc-panel' },
          t('panelHint'),
          h(
            'a',
            {
              href: panelUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'dsm-oc-link',
              title: panelUrl,
            },
            panelLabel,
          ),
          wbButton(
            'panelKey',
            'outline dsm-oc-panel-key',
            panelKey?.busy ? t('panelKeyWorking') : t(backend?.gateway === 'tiara' ? 'panelKeyCopyTiara' : 'panelKeyCopy'),
            copyPanelKey,
            Boolean(panelKey?.busy),
          ),
        ),
        panelKey?.kind === 'manual'
          ? h(
              'p',
              { className: 'dsm-oc-notice dsm-oc-notice-error' },
              t('panelKeyManual'),
              h('code', { className: 'dsm-oc-key' }, panelKey.key),
            )
          : wbNotice('panelKeyNotice', panelKey?.busy ? undefined : panelKey),
        body,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), `${name}: locale`);
      const t = ctx.locale.bind(namespace);
      ensureStyle();

      // 更新器由两处卡片共享；插件卸载后停止向旧卡片发送状态
      const updater = createPluginUpdater(ctx.remote);
      ctx.effect(() => () => updater.dispose(), `${name}: plugin updater`);
      // 插件管理器每完成一次操作就广播 changed（含官方插件页的「更新」），据此静默重读安装状态。
      // 只是锦上添花：宿主没有这个事件时不该连累整张卡片注册失败。
      ctx.effect(() => {
        try {
          return ctx.remote.$on('plugin-manager/changed', () => updater.refresh());
        } catch (error) {
          console.warn(`[${name}] 订阅插件变更失败：`, error);
          return () => {};
        }
      }, `${name}: plugin changes`);

      const api = { updater };

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
                inject: () => ({ t, api }),
              },
              ModelsCard,
            ),
          );
        } catch (error) {
          console.error(`[${name}] 卡片注册失败（slot ${slotName}）：`, error);
        }
      };

      // 插件页按"包名"找 bundle 卡片、按"包名#行 id"找行卡片（DSH plugin-manager 的 rowConfigKey）。
      registerCard('plugins.bundle.config', '@zhiqiangme/dsh-opencode2api');
      registerCard('plugins.row.config', '@zhiqiangme/dsh-opencode2api#dsh-opencode2api');
    }

    // 纯函数，导出给测试；宿主只认 name / inject / apply。
    exports.waitForGateway = waitForGateway;
    exports.syncGatewayModels = syncGatewayModels;
    exports.orderedSelection = orderedSelection;
    exports.createPluginUpdater = createPluginUpdater;
    exports.pinnedInstallSpec = pinnedInstallSpec;
    exports.renderUpdateSection = renderUpdateSection;
    exports.renderAutoUpdate = renderAutoUpdate;
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
