/* DSH 自带 React 与模块加载器；与仓库其它插件一致，不引入单独构建链。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-magpie',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;
    const namespace = 'settings.dsh-magpie';
    const path = '/plugins/dsh-magpie/models';
    const zh = {
      title: 'Magpie 模型管理', description: '开关和选项即时生效；连接、程序路径和模型清单改完点击「保存并同步」。',
      loading: '正在读取配置…', reload: '重新载入', discard: '放弃更改并重新载入', connection: '连接设置',
      url: 'Magpie 网关地址', protocol: 'API 协议', key: '网关 Key', keyHint: '本机可留空；远程网关需要有效 Key。已保存时留空表示沿用。',
      keySaved: '已保存 Key', keyEmpty: '使用本机标识', keyReadonly: 'Key 由环境变量提供，只读',
      check: '检查连接', connected: '已连接 Magpie {version}', catalog: '从 Magpie 同步',
      mirrored: '已按 Magpie 当前目录覆盖保存，DSH 分组现有 {count} 个模型。',
      sync: '同步到 DSH', syncHint: '勾选的模型按顺序写入 DSH 的“Magpie”分组；关闭即移除该分组。',
      native: '当前还有 Magpie 原生分组。这里保存到独立的“Magpie”分组（ID 为 dsh-magpie），原分组仍可使用。',
      count: '{selected} / {total} 个模型已勾选', search: '搜索名称或 ID', add: '手动添加模型',
      sortDefault: '默认排序', sortDefaultHint: '按 Magpie 目录的顺序排列（需要 Magpie 正在运行）；对完整清单排序后，从 Magpie 同步也沿用该顺序',
      catalogOrder: '当前为 Magpie 目录顺序：从 Magpie 同步会沿用 Magpie 的顺序。',
      sortModel: '按模型排序', sortProvider: '按供应商排序',
      sortModelHint: '对当前搜索结果按模型名称升序排列；对完整清单排序会恢复同步后自动排序', sortProviderHint: '对当前搜索结果按供应商简称、模型名称升序排列',
      manualOrder: '当前为手动顺序：从 Magpie 同步会保留现有顺序，新模型排在末尾。不搜索时点击「默认排序」或「按模型排序」可恢复自动排序。',
      all: '全选', none: '取消全选', empty: '清单为空。添加模型，或从正在运行的 Magpie 同步。',
      noMatch: '没有匹配的模型。', id: '完整模型 ID', modelName: '显示名称', nameHint: '留空使用模型 ID',
      selected: '同步此模型', drag: '拖动或按 ↑↓ 键调整 {name} 的顺序', remove: '删除', details: '能力与参数',
      expand: '展开 {name} 的详细配置', collapse: '收起 {name} 的详细配置', newModel: '新模型',
      context: '上下文窗口', output: '最大输出 token', vision: '支持图片输入', efforts: '思考档位（逗号分隔）',
      effortHint: '可用 off、minimal、low、medium、high、xhigh、max；留空表示不声明', unspecified: '不指定', save: '保存并同步', saving: '处理中…',
      saved: '已保存，DSH 分组现有 {count} 个模型。', saveFailed: '清单已保存，同步未完成：{reason}',
      readOnly: '宿主配置服务尚未就绪，暂时无法保存。', unsaved: '有未保存的更改', savedState: '已保存',
      invalidJson: '服务返回了无效响应',
      backendTitle: 'Magpie 程序', backendMissing: '尚未下载', backendUnknown: '版本未识别',
      backendPath: 'Magpie 程序路径', backendPathHint: '留空使用插件独立目录；也可填写已有 Magpie 的 exe 绝对路径。更改路径后点击保存并同步保存配置。',
      backendDefault: '留空使用插件独立目录', backendCheck: '检查更新', backendDownload: '下载 Magpie', backendUpgrade: '升级 Magpie',
      backendLatest: '最新版本：{version}', backendCurrent: '当前版本：{version}', backendUpToDate: '已是最新版本或更新',
      backendChecking: '正在检查版本…', backendDownloading: '正在下载…', backendVerifying: '正在校验程序…', backendInstalling: '正在替换程序…',
      backendInstalled: 'Magpie {version} 已下载并打开。', backendUpdated: '已升级到 Magpie {version}，并在后台启动。', backendStarting: '正在启动 Magpie…', backendStopping: '正在退出运行中的 Magpie…',
      backendAlreadyRunning: 'Magpie {version} 已就绪，程序已在运行，未重复启动。', backendLaunchFailed: 'Magpie {version} 已就绪，但启动失败：{reason}。请从程序路径手动启动。',
      backendProgress: '已下载 {received} / {total} MiB', backendFailed: '操作失败：{reason}',
      autoUpdate: '自动更新 Magpie 程序',
      autoUpdateHint: '每 5 分钟检查，正式版发布满 30 分钟后下载校验；所有 DSH 对话空闲后升级并在托盘重启。仅更新已安装的本机程序。',
      backendWaitingIdle: '下载校验完成，等待所有对话空闲后升级…', backendWaitingStatus: '下载校验完成，暂时无法确认对话状态，等待后重试…',
      backendCooling: '新版本发布未满 30 分钟，将在 {time} 后自动下载。', backendInvalidDate: '无法确认版本发布时间，已跳过自动升级。', backendCancelled: '自动升级已取消，现有程序保持不变。',
      autoStart: '启动 DSH 时打开 Magpie',
      autoStartHint: '仅本机地址。没有 Magpie 在运行时在托盘启动，不弹出窗口。',
      autoLightweight: '自动开启轻量模式',
      autoLightweightHint: '插件启动 Magpie 前设为开启：窗口关闭约一分钟后释放界面内存，网关照常运行。',
      keepAwake: '防止休眠', keepAwakeOff: '关闭', keepAwakeOn: '开启', keepAwakeDisplay: '屏幕也常亮',
      keepAwakeHint: 'Magpie 运行任务时让电脑保持唤醒。',
      magpieSettingsMissing: '打开一次 Magpie 后可用。',
      open: '打开 Magpie 界面', opened: '已打开 Magpie 窗口。',
      closeOnExit: '退出 DSH 时关闭 Magpie',
      closeOnExitHint: '结束本机 Magpie 及其托盘；停用或更新插件不会触发。',
      sidebarLabel: 'Magpie', sidebarEntry: '侧边栏入口', sidebarAuto: '自动', sidebarAlways: '显示', sidebarNever: '隐藏',
      sidebarEntryHint: '左上角「插件」一栏的 Magpie 入口。自动：清单为空时显示，保存模型后隐藏。',
      tabModels: '模型', tabConnection: '连接', tabPreferences: '偏好', tabUpdates: '更新',
      gatewayOnline: '网关在线 {version}', gatewayOffline: '网关未连接', gatewayChecking: '正在检查网关…',
      programVersion: 'Magpie {version}', programMissing: '未下载 Magpie', programUpgrade: '可升级到 {version}',
      groupProgram: 'Magpie 程序', groupMagpieSettings: 'Magpie 设置', groupMagpieSettingsHint: '直接写入 Magpie 自己的设置，与其「设置 › 常规」中的同名选项相同。', groupDsh: 'DSH',
      connectionHint: '改完点击「保存并同步」生效。',
      updateTitle: '插件更新', updateChecking: '正在检查更新…', updateCheck: '检查更新',
      updateCheckFailed: '检查更新失败：{reason}', updateCurrent: '当前运行版本：', updateLatestVersion: 'npm 最新版本：',
      updateUpToDate: '已是最新', updateAvailable: '有新版本', updatePendingRestart: '等待重启', updatePendingRefresh: '等待刷新',
      updateNow: '更新到 v{version}', updateNoMarket: '当前 DSH 版本还没有官方插件更新接口；安装 DSH 插件市场（dshmarket）后可在此更新插件。',
      updateLinked: '本插件从本地目录（file:）安装，请在源码目录更新后重新运行 install-plugins.cmd；从 npm 安装后可在此一键更新。',
      updateManaged: '本插件由 DSH 统一管理，请通过宿主管理插件版本。',
      updateNoCompatible: '官方插件管理器暂未提供可更新的兼容正式版。',
      updateNotUpdatable: '官方插件管理器不支持更新此安装，请在「插件」页查看安装来源。',
      updateManagerFailed: '官方插件管理器检查失败：{reason}',
      updateRunning: '正在更新…', updateProgress: '正在更新… {percent}%', updateStartFailed: '没能开始更新：{reason}',
      updateCheckingTarget: '正在核对目标版本…', updateRemoving: '正在卸载旧版本…', updateInstalling: '正在安装新版本…', updateRestoring: '正在恢复旧版本…',
      updateSucceeded: '已更新到 v{version}。', updateRestartHint: '重启 DSH 后生效。', updateRefreshHint: '刷新页面后生效。',
      updateMismatch: '实际安装版本 v{installed} 低于预期的 v{target}，请重新检查后再更新。',
      updateFailed: '更新失败：{reason}', updateTooFresh: '新版本尚在 pnpm 发布冷却期内，可以稍后重试，或强制更新。',
      updateRestoreFailed: '恢复旧版本失败：{reason}。请在「插件」页检查并重新安装。',
      updateUnknown: '未能确认更新结果，请检查「插件」页的实际安装版本后重试。',
      updateForce: '强制更新', updateCancelled: '更新已取消。', updateRolledBack: '更新已回滚，插件保持在 v{version}。',
      updateLost: '上次更新任务已结束或 DSH 已重启，请以当前版本为准。',
      updateSaveFirst: '请先保存或放弃模型更改，再更新插件。', updateWait: '请等待当前操作完成后再更新插件。',
      restartNow: '立即重启 DSH', restarting: '正在重启 DSH…', restartFailed: '未能确认重启：{reason}',
    };
    const en = {
      title: 'Magpie models', description: 'Switches and choices apply at once; click “Save and sync” after editing the connection, executable path or model list.',
      loading: 'Loading configuration…', reload: 'Reload', discard: 'Discard edits and reload', connection: 'Connection',
      url: 'Magpie gateway URL', protocol: 'API protocol', key: 'Gateway key', keyHint: 'Optional on this machine; required for a remote gateway. Leave blank to keep the saved key.',
      keySaved: 'Key saved', keyEmpty: 'Using local identity', keyReadonly: 'The environment supplies a read-only key',
      check: 'Check connection', connected: 'Connected to Magpie {version}', catalog: 'Sync from Magpie',
      mirrored: 'Replaced and saved the list from Magpie. The DSH group now has {count} models.',
      sync: 'Sync to DSH', syncHint: 'Ticked models go into the DSH “Magpie” group in this order; turning this off removes the group.',
      native: 'Magpie native groups are also configured. This list uses its own “Magpie” group (ID dsh-magpie); existing groups remain available.',
      count: '{selected} / {total} models selected', search: 'Search names or IDs', add: 'Add a model',
      sortDefault: 'Default order', sortDefaultHint: 'Order as Magpie lists them (Magpie must be running); after sorting the full list, syncing from Magpie keeps that order',
      catalogOrder: 'Magpie order: syncing from Magpie keeps the order Magpie lists them in.',
      sortModel: 'Sort by model', sortProvider: 'Sort by provider',
      sortModelHint: 'Sort matching models by name, ascending; sorting the full list restores automatic ordering after sync', sortProviderHint: 'Sort matching models by short provider name, then model name, ascending',
      manualOrder: 'Manual order: syncing from Magpie keeps the current order and adds new models at the end. Clear the search and click “Default order” or “Sort by model” to restore automatic ordering.',
      all: 'Select all', none: 'Deselect all', empty: 'The list is empty. Add models or sync from a running Magpie.',
      noMatch: 'No matching models.', id: 'Full model ID', modelName: 'Display name', nameHint: 'Defaults to model ID',
      selected: 'Sync this model', drag: 'Drag, or press ↑ ↓, to reorder {name}', remove: 'Delete', details: 'Capabilities and limits',
      expand: 'Expand details for {name}', collapse: 'Collapse details for {name}', newModel: 'New model',
      context: 'Context window', output: 'Max output tokens', vision: 'Image input', efforts: 'Reasoning levels (comma-separated)',
      effortHint: 'Use off, minimal, low, medium, high, xhigh or max; leave blank to declare none', unspecified: 'Unspecified', save: 'Save and sync', saving: 'Working…',
      saved: 'Saved. The DSH group now has {count} models.', saveFailed: 'List saved; sync incomplete: {reason}',
      readOnly: 'Host configuration services are not ready. Saving is unavailable.', unsaved: 'Unsaved edits', savedState: 'Saved',
      invalidJson: 'The server returned an invalid response',
      backendTitle: 'Magpie program', backendMissing: 'Not downloaded', backendUnknown: 'Unrecognized version',
      backendPath: 'Magpie executable path', backendPathHint: 'Leave blank for the plugin directory, or enter an existing Magpie exe absolute path. Save and sync to keep path changes.',
      backendDefault: 'Leave blank for the plugin directory', backendCheck: 'Check for updates', backendDownload: 'Download Magpie', backendUpgrade: 'Update Magpie',
      backendLatest: 'Latest: {version}', backendCurrent: 'Current: {version}', backendUpToDate: 'Up to date or newer',
      backendChecking: 'Checking version…', backendDownloading: 'Downloading…', backendVerifying: 'Verifying executable…', backendInstalling: 'Replacing executable…',
      backendInstalled: 'Magpie {version} downloaded and opened.', backendUpdated: 'Updated to Magpie {version} and started it in the background.', backendStarting: 'Starting Magpie…', backendStopping: 'Quitting the running Magpie…',
      backendAlreadyRunning: 'Magpie {version} is ready and already running; not started again.', backendLaunchFailed: 'Magpie {version} is ready but could not start: {reason}. Launch it from the executable path.',
      backendProgress: 'Downloaded {received} / {total} MiB', backendFailed: 'Operation failed: {reason}',
      autoUpdate: 'Automatically update Magpie',
      autoUpdateHint: 'Checks every 5 minutes. Downloads and verifies stable releases after 30 minutes, then updates and restarts in the tray when all DSH conversations are idle. Existing local installations only.',
      backendWaitingIdle: 'Download verified. Waiting for all conversations to become idle…', backendWaitingStatus: 'Download verified. Conversation status is unavailable; waiting to retry…',
      backendCooling: 'Release is less than 30 minutes old. Automatic download is eligible after {time}.', backendInvalidDate: 'Release publication time is unavailable; automatic update skipped.', backendCancelled: 'Automatic update cancelled. Existing executable unchanged.',
      autoStart: 'Open Magpie when DSH starts',
      autoStartHint: 'Local addresses only. Starts it in the tray, without a window, when no Magpie is running.',
      autoLightweight: 'Turn on lightweight mode',
      autoLightweightHint: 'Set before the plugin starts Magpie: about a minute after its window closes the page memory is released; the gateway keeps running.',
      keepAwake: 'Keep awake', keepAwakeOff: 'Off', keepAwakeOn: 'On', keepAwakeDisplay: 'Screen on too',
      keepAwakeHint: 'Keeps the computer awake while Magpie runs tasks.',
      magpieSettingsMissing: 'Available once Magpie has been opened.',
      open: 'Open Magpie', opened: 'Opened the Magpie window.',
      closeOnExit: 'Close Magpie when DSH exits',
      closeOnExitHint: 'Ends local Magpie and its tray process; disabling or updating the plugin does not.',
      sidebarLabel: 'Magpie', sidebarEntry: 'Sidebar entry', sidebarAuto: 'Auto', sidebarAlways: 'Show', sidebarNever: 'Hide',
      sidebarEntryHint: 'The Magpie entry next to Plugins in the sidebar. Auto: shown while the list is empty, hidden once models are saved.',
      tabModels: 'Models', tabConnection: 'Connection', tabPreferences: 'Preferences', tabUpdates: 'Updates',
      gatewayOnline: 'Gateway online {version}', gatewayOffline: 'Gateway offline', gatewayChecking: 'Checking gateway…',
      programVersion: 'Magpie {version}', programMissing: 'Magpie not downloaded', programUpgrade: 'Update to {version}',
      groupProgram: 'Magpie program', groupMagpieSettings: 'Magpie settings', groupMagpieSettingsHint: 'Written straight into Magpie’s own settings; the same options as its Settings › General.', groupDsh: 'DSH',
      connectionHint: 'Click “Save and sync” to apply changes here.',
      updateTitle: 'Plugin update', updateChecking: 'Checking for updates…', updateCheck: 'Check for updates',
      updateCheckFailed: 'Update check failed: {reason}', updateCurrent: 'Running version: ', updateLatestVersion: 'Latest on npm: ',
      updateUpToDate: 'Up to date', updateAvailable: 'Update available', updatePendingRestart: 'Restart pending', updatePendingRefresh: 'Reload pending',
      updateNow: 'Update to v{version}', updateNoMarket: 'This DSH version has no official plugin update API yet. Install the DSH plugin market (dshmarket) to update here.',
      updateLinked: 'This plugin was installed from a local directory (file:). Update its checkout and run install-plugins.cmd again, or install from npm for one-click updates.',
      updateManaged: 'DSH manages this plugin. Use the host to manage its version.',
      updateNoCompatible: 'The official plugin manager offers no compatible stable update.',
      updateNotUpdatable: 'The official plugin manager cannot update this installation. Check its source on the Plugins page.',
      updateManagerFailed: 'Official plugin manager check failed: {reason}',
      updateRunning: 'Updating…', updateProgress: 'Updating… {percent}%', updateStartFailed: 'Could not start the update: {reason}',
      updateCheckingTarget: 'Checking the target version…', updateRemoving: 'Removing the previous version…', updateInstalling: 'Installing the new version…', updateRestoring: 'Restoring the previous version…',
      updateSucceeded: 'Updated to v{version}.', updateRestartHint: 'Restart DSH to apply it.', updateRefreshHint: 'Reload the page to apply it.',
      updateMismatch: 'Installed v{installed} is below the expected v{target}. Check again before updating.',
      updateFailed: 'Update failed: {reason}', updateTooFresh: 'The new version is inside pnpm’s release cool-down. Retry later or force the update.',
      updateRestoreFailed: 'Restoring the previous version failed: {reason}. Check and reinstall on the Plugins page.',
      updateUnknown: 'The update outcome could not be confirmed. Check the installed version on the Plugins page before retrying.',
      updateForce: 'Force update', updateCancelled: 'Update cancelled.', updateRolledBack: 'Update rolled back; the plugin stays at v{version}.',
      updateLost: 'The previous update task ended or DSH restarted. Use the current version shown here.',
      updateSaveFirst: 'Save or discard model edits before updating the plugin.', updateWait: 'Wait for the current operation before updating the plugin.',
      restartNow: 'Restart DSH now', restarting: 'Restarting DSH…', restartFailed: 'Could not confirm restart: {reason}',
    };
    // 本插件的 npm 包名：官方插件管理器与 dshmarket 都按它定位 profile 中的依赖。
    const PACKAGE_NAME = '@zhiqiangme/dsh-magpie';
    // 宿主半侧的版本检查路由（lib/web.js），?force=1 绕过它的 10 分钟缓存。
    const VERSION_PATH = '/plugins/dsh-magpie/version';
    // 官方 listVersions 每次要在宿主上跑 1 + 最多 20 次 `pnpm view`（versionListLimit 默认 20），
    // 所以结果按已装版本缓存，时长与 version 路由一致；「检查更新」绕过缓存。
    const VERSION_LIST_TTL_MS = 10 * 60 * 1000;
    // 官方 updateBundle 经 `plugin-manager/update-state` 报的阶段 → 文案 key。
    const UPDATE_STEPS = { checking: 'updateCheckingTarget', removing: 'updateRemoving', installing: 'updateInstalling', restoring: 'updateRestoring' };
    // 交给 updateBundle 的必须是明确的 semver，不接受标签与范围。
    const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    // 沿用 WB 的 dshmarket 公开 API v1，只在宿主没有官方更新接口（DSH 0.2.1-rc.3 及更早）时兜底；
    // 插件独立发布，保持包内实现，不依赖 WB 安装。
    const MARKET_CAPABILITIES_PATH = '/dsh-market/api/v1/capabilities';
    const MARKET_SCHEMA = 'dsh-market/update-api/v1';
    const MARKET_DEFAULT_ENDPOINTS = {
      updates: '/dsh-market/api/v1/updates', operations: '/dsh-market/api/v1/operations', restart: '/dsh-market/api/v1/restart',
    };
    const POLL_MS = 1000;
    // 自身更新可能重新挂载卡片；记录任务以便恢复进度，bootId 防止串到宿主重启前的任务。
    const OPERATION_STORAGE_KEY = 'dsh-magpie:update-operation';
    const FORCEABLE_FAILURES = new Set(['RELEASE_TOO_FRESH', 'VERSION_UNCHANGED']);
    // 与 dshmarket 相同的宿主侧栏契约：sidebar.panellist 提供入口行，keyed main 槽位提供整页。
    const PANEL_ID = 'dsh-magpie';
    // 宿主「插件」为 0、「自动化任务」为 10，dshmarket「插件市场」占 1；Magpie 排在它们之间。
    const PANEL_ORDER = 2;
    const SIDEBAR_MODES = { auto: 'sidebarAuto', always: 'sidebarAlways', never: 'sidebarNever' };
    // 客户端可能先于服务端路由就绪；读取已保存配置失败时短暂重试，仍失败则不显示入口。
    const CONFIG_RETRIES = 5;
    const CONFIG_RETRY_MS = 2000;
    // 标题处的网关状态定时刷新；本机请求很轻，15 秒足够反映 Magpie 被打开或关闭。
    const STATUS_POLL_MS = 15000;
    // 模型行的稳定 key：草稿里同一模型换了对象（编辑、勾选）也沿用原 key，排序动画才能认出是同一行。
    const rowKeys = new WeakMap();
    let nextRowKey = 0;
    const keyOf = (row) => { if (!rowKeys.has(row)) rowKeys.set(row, `m${++nextRowKey}`); return rowKeys.get(row); };
    const keepKey = (previous, next) => { rowKeys.set(next, keyOf(previous)); return next; };
    // 排序后各行滑到新位置的时长；拖动中让位的过渡写在样式里，两者保持一致。
    const REORDER_MS = 200;
    const TABS = [['models', 'tabModels'], ['connection', 'tabConnection'], ['preferences', 'tabPreferences'], ['updates', 'tabUpdates']];
    // 卡片在插件设置和侧栏页面各自挂载；读取或保存后经此通知侧栏按已保存的配置重新判断入口。
    const savedConfig = { value: undefined, listeners: new Set() };
    function publishConfig(config) {
      savedConfig.value = config;
      for (const listener of savedConfig.listeners) listener();
    }
    /** 正在查看的页面不收起入口，避免保存后侧栏没有选中项；离开后再按设置判断。配置未知时不显示。 */
    function sidebarVisible(config, active) {
      if (active) return true;
      if (!config) return false;
      const mode = config.sidebarEntry ?? 'auto';
      return mode === 'always' || (mode === 'auto' && !config.models?.length);
    }

    async function versionRequest(url) {
      const response = await fetch(url, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.reason || `HTTP ${response.status}`);
      return payload;
    }
    const CSS = `
      .dsm-mp{--mp-fg:var(--dsw-alias-label-primary,#0f1115);--mp-muted:var(--dsw-alias-label-secondary,#61666b);--mp-faint:var(--dsw-alias-label-tertiary,#81858c);--mp-dimmed:var(--dsw-alias-label-dimmed,#a0a5ad);
        --mp-border:var(--dsw-alias-border-l2,#0000001a);--mp-border-soft:var(--dsw-alias-border-l1,#0000000a);--mp-bg:var(--dsw-alias-bg-layer-2,#fff);--mp-raised:var(--dsw-alias-button-elevated-fill,#fff);
        --mp-fill:var(--dsw-alias-interactive-bg-hover,#2631480f);--mp-hover:var(--dsw-alias-interactive-bg-active,#2631481a);--mp-accent:var(--dsw-alias-state-business-primary,#4176e6);
        --mp-ok:var(--dsw-alias-state-success-primary,#22c55e);--mp-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--mp-error:var(--dsw-alias-state-error-primary,#dc2626);
        color:var(--mp-fg);border:1px solid var(--mp-border);border-radius:12px;background:var(--mp-bg);font-size:13px;line-height:1.55;box-sizing:border-box;min-width:0}
      .dsm-mp *{box-sizing:border-box}.dsm-mp p{margin:0}.dsm-mp h3,.dsm-mp h4{margin:0}.dsm-mp .muted{color:var(--mp-muted)}.dsm-mp .error{color:var(--mp-error)}
      .dsm-mp .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsm-mp .spread{justify-content:space-between}
      .dsm-mp button{border:1px solid var(--mp-border);border-radius:8px;padding:5px 12px;background:transparent;color:inherit;font:inherit;line-height:20px;cursor:pointer;white-space:nowrap}
      .dsm-mp button:hover:not(:disabled){background:var(--mp-fill)}.dsm-mp button:disabled{color:var(--mp-dimmed);cursor:default}
      .dsm-mp button:focus-visible,.dsm-mp input:focus-visible,.dsm-mp select:focus-visible{outline:2px solid var(--mp-accent);outline-offset:1px}
      /* 沿用 DSH 自家主按钮的配色令牌（深色主题为浅底深字）。宿主的 brand-primary-invert 与 brand-primary 同值，不能当文字色。 */
      .dsm-mp button.primary{background:var(--dsw-alias-button-primary-fill,#0f1115);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
      .dsm-mp button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#43454a)}.dsm-mp button.primary:disabled{background:var(--mp-fill);color:var(--mp-dimmed)}
      .dsm-mp button.ghost{border-color:transparent;padding:3px 8px;color:var(--mp-muted)}.dsm-mp button.ghost:hover:not(:disabled){color:var(--mp-fg)}.dsm-mp button.danger{color:var(--mp-error)}
      .dsm-mp input:not([type=checkbox]),.dsm-mp select{width:100%;min-width:0;padding:6px 10px;border:1px solid var(--mp-border);border-radius:8px;background:transparent;color:inherit;font:inherit;line-height:20px}
      .dsm-mp select option{background:var(--mp-bg);color:var(--mp-fg)}.dsm-mp input::placeholder{color:var(--mp-faint)}
      .dsm-mp input[type=checkbox]{accent-color:var(--mp-accent)}
      .dsm-mp .switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:34px;height:20px;margin:0;border-radius:999px;background:var(--dsw-alias-border-l4,#00000029);cursor:pointer;transition:background .15s}
      .dsm-mp .switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0000004d;transition:transform .15s}
      .dsm-mp .switch:checked{background:var(--mp-accent)}.dsm-mp .switch:checked::after{transform:translateX(14px)}.dsm-mp .switch:disabled{opacity:.45;cursor:default}
      .dsm-mp .segmented{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--mp-fill)}
      .dsm-mp .segmented button{border:0;border-radius:6px;padding:3px 10px;color:var(--mp-muted)}.dsm-mp .segmented button:hover:not(:disabled){background:transparent;color:var(--mp-fg)}
      .dsm-mp .segmented button.active{background:var(--mp-raised);color:var(--mp-fg);box-shadow:0 1px 2px #0000001f}.dsm-mp .segmented button.active:hover:not(:disabled){background:var(--mp-raised)}
      .dsm-mp .head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:18px 20px 14px}
      .dsm-mp .title{display:flex;align-items:center;gap:8px}.dsm-mp .title svg{color:var(--mp-accent)}.dsm-mp h3{font-size:16px;font-weight:600}
      .dsm-mp .head-desc{margin-top:4px;color:var(--mp-muted);font-size:12px}
      .dsm-mp .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
      .dsm-mp .chip{display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border:0;border-radius:999px;background:var(--mp-fill);color:var(--mp-muted);font-size:12px;line-height:20px}
      .dsm-mp .chip .dot{width:6px;height:6px;border-radius:50%;background:var(--mp-faint)}.dsm-mp .chip.ok .dot{background:var(--mp-ok)}.dsm-mp .chip.off .dot{background:var(--mp-error)}
      .dsm-mp button.chip{padding:1px 9px;border:0}.dsm-mp button.chip:hover:not(:disabled){background:var(--mp-hover);color:var(--mp-fg)}.dsm-mp .chip .new{color:var(--mp-accent)}
      .dsm-mp .tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--mp-border);overflow-x:auto;scrollbar-width:none}
      .dsm-mp .tabs button.tab{position:relative;border:0;border-radius:0;padding:8px 10px 9px;background:transparent;color:var(--mp-muted);font-weight:500}
      .dsm-mp .tabs button.tab:hover{background:transparent;color:var(--mp-fg)}
      .dsm-mp .tabs button.tab[aria-selected=true]{color:var(--mp-fg)}.dsm-mp .tabs button.tab[aria-selected=true]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--mp-fg)}
      .dsm-mp .tab .count{margin-left:6px;padding:0 6px;border-radius:999px;background:var(--mp-fill);font-size:11px;font-weight:400}
      .dsm-mp .tab .mark{display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--mp-accent);vertical-align:2px}
      .dsm-mp .panel{padding:16px 20px 20px;min-width:0}
      .dsm-mp .row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--mp-border-soft)}
      .dsm-mp .row:last-child{border-bottom:0}.dsm-mp label.row{cursor:pointer}
      .dsm-mp .row-text{display:flex;flex-direction:column;gap:2px;min-width:0}.dsm-mp .row-title{font-weight:500}.dsm-mp .row-hint{color:var(--mp-muted);font-size:12px}.dsm-mp .row-control{flex:none}
      .dsm-mp .group{display:flex;flex-direction:column;gap:2px;margin:22px 0 2px;font-size:12px;font-weight:600;color:var(--mp-faint)}.dsm-mp .group:first-child{margin-top:0}
      .dsm-mp .group span{font-weight:400}
      .dsm-mp .hint{margin-top:6px;color:var(--mp-muted);font-size:12px}
      .dsm-mp .notice{margin-top:12px;padding:8px 12px;border-radius:8px;background:var(--mp-fill);overflow-wrap:anywhere}
      .dsm-mp .notice.error{color:var(--mp-error);background:color-mix(in srgb,var(--mp-error) 12%,transparent)}
      .dsm-mp .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
      .dsm-mp label.field{display:flex;flex-direction:column;gap:6px;min-width:0;font-weight:500}.dsm-mp label.field input,.dsm-mp label.field select{font-weight:400}
      .dsm-mp .toolbar{display:flex;align-items:center;gap:8px;margin-top:14px}.dsm-mp .toolbar .search{flex:1;min-width:160px}
      .dsm-mp .list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:14px;padding:0 4px 6px;border-bottom:1px solid var(--mp-border-soft)}
      .dsm-mp .list-head .count{font-weight:600}.dsm-mp .list-actions{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
      .dsm-mp .divider{width:1px;height:14px;margin:0 6px;background:var(--mp-border)}
      .dsm-mp .empty{margin-top:12px;padding:28px 16px;border:1px dashed var(--mp-border);border-radius:10px;text-align:center;color:var(--mp-muted)}
      .dsm-mp .model-list{margin-top:6px;display:flex;flex-direction:column;gap:2px}.dsm-mp .model{border:1px solid transparent;border-radius:8px;min-width:0}
      .dsm-mp .model:hover,.dsm-mp .model.expanded{background:var(--mp-fill)}.dsm-mp .model.expanded{border-color:var(--mp-border)}
      .dsm-mp .model-header{display:flex;align-items:center;gap:6px;padding:5px 8px;min-width:0;min-height:40px}.dsm-mp .model-select{display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer}
      .dsm-mp .model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsm-mp .model input[type=checkbox]{margin:0;flex:none}
      .dsm-mp .model-drag{padding:3px;flex:none;border-color:transparent;background:transparent;cursor:grab;line-height:1;color:var(--mp-faint)}.dsm-mp .model-drag:active{cursor:grabbing}.dsm-mp .model-drag svg{display:block;width:16px;height:20px;pointer-events:none}
      .dsm-mp .model-list{position:relative}.dsm-mp .model-list.sorting .model{transition:transform .2s cubic-bezier(.2,.8,.2,1)}
      .dsm-mp .model-list.sorting .model:hover:not(.dragging){background:transparent}
      .dsm-mp .model.dragging{position:relative;z-index:1;border-style:dashed;border-color:var(--mp-accent);background:color-mix(in srgb,var(--mp-accent) 8%,transparent)}
      .dsm-mp .model.dragging>*{opacity:.35}
      @media(prefers-reduced-motion:reduce){.dsm-mp .model-list.sorting .model{transition:none}}
      .dsm-mp .model-toggle{padding:4px 6px;line-height:1;border-color:transparent;background:transparent;flex:none;color:var(--mp-faint)}.dsm-mp .model-toggle svg{display:block;width:16px;height:16px;transition:transform .15s}.dsm-mp .model-toggle[aria-expanded=true] svg{transform:rotate(90deg)}
      .dsm-mp .model-badges{display:flex;gap:6px;margin-left:auto;flex:none}.dsm-mp .badge{padding:0 6px;border-radius:4px;background:var(--mp-fill);color:var(--mp-muted);font-size:11px;line-height:18px;white-space:nowrap}
      .dsm-mp .model-actions{display:flex;gap:4px;flex:none;margin-left:auto}.dsm-mp .model-badges+.model-actions{margin-left:4px}.dsm-mp .model-actions button{padding:2px 8px;border-color:transparent;font-size:12px}
      .dsm-mp .model-details{padding:0 12px 12px;min-width:0}.dsm-mp .model-details[hidden]{display:none}.dsm-mp .model-details label:not(.field){display:flex;align-items:center;gap:8px;align-self:end;padding-bottom:7px}
      .dsm-mp .backend+.plugin-update{margin-top:22px;padding-top:18px;border-top:1px solid var(--mp-border)}.dsm-mp .block h4{font-size:14px;font-weight:600}
      .dsm-mp .versions{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;color:var(--mp-muted)}.dsm-mp .versions strong{color:var(--mp-fg);font-weight:500}
      .dsm-mp .backend .bar{margin-top:12px}.dsm-mp .backend-path{overflow-wrap:anywhere}.dsm-mp .backend progress{display:block;width:100%;height:6px;margin-top:10px;accent-color:var(--mp-accent)}
      .dsm-mp .plugin-update p{margin-top:8px;overflow-wrap:anywhere}.dsm-mp .plugin-update-title{font-size:14px;font-weight:600;margin-right:auto}
      .dsm-mp .foot{position:relative;z-index:1;padding:12px 20px;border-top:1px solid var(--mp-border);border-radius:0 0 12px 12px;background:var(--mp-bg)}
      .dsm-mp .foot[data-docked]{position:fixed;bottom:0;z-index:10;border-radius:0;border-left:1px solid var(--mp-border);border-right:1px solid var(--mp-border)}
      .dsm-mp .foot .notice{margin:0 0 10px}.dsm-mp .foot .error:not(.notice){margin:0 0 10px}
      .dsm-mp .state{display:inline-flex;align-items:center;gap:8px;color:var(--mp-muted)}.dsm-mp .state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mp-ok)}
      .dsm-mp .state.dirty{color:var(--mp-fg);font-weight:500}.dsm-mp .state.dirty::before{background:var(--mp-warn)}
      /* 侧栏整页：顶部留出宿主标题栏，内容最宽 960px 居中，与插件市场页面一致。 */
      .dsm-mp-page{box-sizing:border-box;height:100%;overflow-y:auto;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) max(clamp(16px,4vw,48px),calc((100% - 960px) / 2)) 32px}
      @media(max-width:640px){.dsm-mp .head,.dsm-mp .panel,.dsm-mp .foot{padding-left:14px;padding-right:14px}.dsm-mp .fields{grid-template-columns:minmax(0,1fr)}
        .dsm-mp .row:has(.segmented){flex-wrap:wrap}.dsm-mp .toolbar{flex-wrap:wrap}.dsm-mp .toolbar .search{flex-basis:100%}.dsm-mp .model-badges{display:none}.dsm-mp .model-select{flex:1}}
    `;

    async function request(body) {
      const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      // 路由未注册时宿主返回 HTML；交给调用处换成可读的文案，而不是显示 JSON 解析错误。
      const value = await res.json().catch(() => { throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'INVALID_JSON' }); });
      if (!res.ok || !value.ok) throw new Error(value.reason || `HTTP ${res.status}`);
      return value;
    }
    function moveModel(rows, index, target) {
      const next = [...rows];
      if (index >= 0 && index < next.length && target >= 0 && target < next.length) next.splice(target, 0, ...next.splice(index, 1));
      return next;
    }
    function formatTokens(value) {
      if (!value) return '';
      if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
      if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
      return String(value);
    }
    function normalizeDisplayName(name) {
      // 与服务端保持相同别名规则；仅影响展示及排序，不改写上游名称或完整路由 ID。
      return name.replace(/^deepseek[\s_-]+(?:v4\.1[\s_-]+)?flash(?=$|[\s(_-])/i, 'DeepSeek V4.1 Flash');
    }
    // 简称由服务端统一提供；本地派生名称让编辑 ID / 名称时立即预览，不改写手工输入。
    function displayModelName(row, providers = {}) {
      const name = normalizeDisplayName(row.name || row.id || '');
      const provider = row.id?.includes('/') ? row.id.split('/')[0] : '';
      const supplier = Object.hasOwn(providers, provider) ? providers[provider] : undefined;
      return !supplier || name.toLowerCase() === supplier.toLowerCase() || name.toLowerCase().endsWith(` ${supplier.toLowerCase()}`)
        ? name : `${name} ${supplier}`;
    }
    function sortModelIndexes(rows, mode, providers = {}) {
      const collator = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' });
      const compare = (a, b) => a && b ? collator.compare(a, b) : a ? -1 : b ? 1 : 0;
      const keys = rows.map((row, index) => {
        const slash = row.id.indexOf('/');
        const provider = slash > 0 ? row.id.slice(0, slash) : '';
        const supplier = Object.hasOwn(providers, provider) ? providers[provider] : provider;
        let name = (row.name || row.id).trim();
        if (name === row.id && slash > 0) name = row.id.slice(slash + 1);
        // 展示名称可能已经带供应商后缀；按模型排序时把后缀作为次级键。
        if (supplier && name.toLowerCase().endsWith(` ${supplier.toLowerCase()}`)) name = name.slice(0, -supplier.length - 1).trimEnd();
        return { index, name: normalizeDisplayName(name), supplier };
      });
      return keys.sort((a, b) => mode === 'provider'
        ? compare(a.supplier, b.supplier) || compare(a.name, b.name) || a.index - b.index
        : compare(a.name, b.name) || compare(a.supplier, b.supplier) || a.index - b.index).map(({ index }) => index);
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function updateButton(key, kind, label, onClick, disabled) {
      return h('button', { key, type: 'button', className: kind === 'primary' || kind === 'danger' ? kind : '', disabled, onClick }, label);
    }

    function updateNotice(key, value) {
      if (!value) return null;
      return h(
        'p',
        { key, className: `notice${value.kind === 'error' ? ' error' : ''}` },
        value.text,
      );
    }

    /** remote 调用的结果是 `{ ok, value }` 信封；也兼容直接返回值的实现，失败统一抛 Error。 */
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
     * 官方插件管理器的 Remote 命名空间。inject 只声明 remote、不声明它（旧宿主也要能加载模型卡片）；
     * 宿主没有这个命名空间时 cordis 取值会抛错，这里当作没有。
     */
    function pluginManagerOf(remote) {
      try {
        return remote?.pluginManager;
      } catch {
        return undefined;
      }
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

    /**
     * 「插件更新」的共享状态与动作，随插件生命周期存在：设置页的两处卡片与侧栏页面共用一份，
     * 卡片挂卸只增减订阅，不会打断进行中的更新，也不会重复提交。
     *
     * 两条更新路，按宿主接口在不在选择，不写死 DSH 版本号：
     *   - 官方：pluginManager 有 listVersions / updateBundle 时，资格、目标版本与注册表都由宿主确定，
     *     锁、卸载、安装与失败恢复也归宿主。官方接口没有任务回查，页面重载后只重新读实际安装状态；
     *   - dshmarket：宿主还没有官方接口时的兜底，按其公开 API v1 提交并轮询任务。
     */
    function createPluginUpdater(remote) {
      let snapshot = {
        version: { phase: 'loading' },
        manager: { phase: 'loading' },
        market: { phase: 'idle' },
        busy: false,
      };
      const listeners = new Set();
      let checking;
      let updating;
      /** 最近一次官方版本列表 `{ installed, at, value }`：同一已装版本在 VERSION_LIST_TTL_MS 内复用。 */
      let versionList;
      let pollTimer;
      let disposed = false;

      const patch = (value) => {
        snapshot = { ...snapshot, ...value };
        for (const listener of listeners) listener();
      };

      const loadVersion = async (force) => {
        try {
          const value = await versionRequest(force ? `${VERSION_PATH}?force=1` : VERSION_PATH);
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
          // 新宿主上插件列表是更新资格的唯一来源，读不到就如实报错；旧宿主只是少了安装来源，照样走市场兜底
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
        if (!bundle || bundle.updatable !== true) return { ...state, phase: 'blocked' };
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
          && !item.deprecated && !item.incompatible && EXACT_VERSION.test(item.version ?? ''));
        const value = { installedVersion: list.installed, candidate: candidate?.version, registry: list.registry };
        versionList = { installed: state.installedVersion, at: Date.now(), value };
        return value;
      };

      /**
       * 卡片随本插件热重载重建时接着轮询原来的市场任务。任务 id 以市场进程的 bootId 开头：
       * 对不上说明 DSH 已重启，旧记录直接丢弃。
       */
      const resumeMarketOperation = (market) => {
        const stored = readStoredOperation();
        if (!stored) return;
        if (market.bootId && !stored.operationId.startsWith(`${market.bootId}-`)) {
          storeOperation(undefined);
          return;
        }
        if (snapshot.operation) return;
        patch({ target: stored.target, operation: { channel: 'market', operationId: stored.operationId, state: 'running' } });
        pollMarket();
      };

      /** 探测 dshmarket，已探到时不重复问。只在宿主没有官方更新接口时调用。 */
      const probeMarket = async () => {
        if (snapshot.market.phase === 'ready') return;
        patch({ market: { phase: 'loading' } });
        let market = { phase: 'absent' };
        try {
          const result = await marketRequest(MARKET_CAPABILITIES_PATH, 'GET');
          const body = result.body;
          // 没装 dshmarket 时这条路径由宿主答 404（多半不是 JSON），schema 对不上同样当作不存在
          if (result.status === 200 && body?.schema === MARKET_SCHEMA && body.features?.update === true) {
            market = {
              phase: 'ready',
              bootId: typeof body.bootId === 'string' ? body.bootId : undefined,
              // 桌面版的重启归桌面壳管，市场会答 supported:false，此时不显示重启按钮
              restartSupported: body.restart?.supported === true,
              endpoints: { ...MARKET_DEFAULT_ENDPOINTS, ...body.endpoints },
            };
            Object.assign(market, await installSourceOf(market.endpoints.updates));
          }
        } catch {
          market = { phase: 'absent' };
        }
        if (disposed) return;
        patch({ market });
        if (market.phase === 'ready') resumeMarketOperation(market);
      };

      /** 轮询进行中的市场任务。用 setTimeout 链而不是 setInterval：慢响应时不会叠出并发请求。 */
      const pollMarket = () => {
        clearTimeout(pollTimer);
        const tick = async () => {
          const { operation, market } = snapshot;
          const path = market.endpoints?.operations;
          if (disposed || !path || operation?.channel !== 'market' || !isActiveOperation(operation)) return;
          let result;
          try {
            result = await marketRequest(`${path}?operationId=${encodeURIComponent(operation.operationId)}`, 'GET');
          } catch {
            result = undefined; // 网络抖动或宿主正在重载：下一拍再问
          }
          if (disposed || snapshot.operation?.operationId !== operation.operationId) return;
          if (result?.status === 404) {
            // 任务记录只活在市场当前进程里，查不到说明进程已经换过
            storeOperation(undefined);
            patch({ operation: { channel: 'market', state: 'lost' } });
            return;
          }
          const next = result?.body?.operation;
          if (next && typeof next.state === 'string') {
            // 沿用查询用的 operationId：答复没带它时下一拍也还能接着问同一个任务
            patch({ operation: { ...next, operationId: operation.operationId, channel: 'market' } });
            if (!isActiveOperation(next)) {
              storeOperation(undefined);
              return;
            }
          }
          pollTimer = setTimeout(tick, POLL_MS);
        };
        pollTimer = setTimeout(tick, POLL_MS);
      };

      /**
       * 检查版本与更新途径。quiet 给宿主的插件变更广播用：不把区块切成"正在检查"，只静默重读，
       * 避免在插件页上开关别的插件时这块跟着闪。
       */
      const run = (force, quiet) => {
        if (updating) return updating;
        if (checking) return checking;
        // 市场任务进行中时检查按钮已禁用；这里也不打断它的轮询
        if (isActiveOperation(snapshot.operation)) return Promise.resolve();
        if (!quiet) {
          // 保留上一次的版本号与安装来源：重新检查时那几行不闪
          patch({
            version: { ...snapshot.version, phase: 'loading' },
            manager: { ...snapshot.manager, phase: 'loading' },
            startFailure: undefined,
          });
        }
        const failure = (error) => ({ phase: 'error', reason: errorText(error) });
        checking = Promise.all([loadVersion(force), readManager().catch(failure)])
          .then(async ([, state]) => {
            let manager = state;
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
            if (manager.phase === 'unsupported') await probeMarket();
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
          startFailure: undefined,
          restart: undefined,
          operation: { channel: 'official', state: 'running', step: 'checking', requestId },
        });
        // 锁、卸载、安装与失败恢复都交给宿主。只显示本次 requestId 的阶段，不伪造百分比。
        updating = Promise.resolve().then(async () => {
          let off;
          try {
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

      /** dshmarket：提交更新后轮询任务。force 只在市场报了冷却期 / 版本未变之后由用户显式选择。 */
      const startMarket = (force) => {
        const goal = snapshot.version.latestVersion;
        patch({ busy: true, startFailure: undefined, restart: undefined, operation: undefined });
        updating = Promise.resolve().then(async () => {
          try {
            // 市场的公开 v1 API 只接受纯包名，由市场解析并固定版本，不能往 packageName 后拼 @version
            const body = force ? { packageName: PACKAGE_NAME, force: true } : { packageName: PACKAGE_NAME };
            const result = await marketRequest(snapshot.market.endpoints.updates, 'POST', body);
            const next = result.body?.operation;
            if (result.status === 202 && typeof next?.operationId === 'string') {
              patch({ target: goal, operation: { ...next, channel: 'market' } });
              storeOperation({ operationId: next.operationId, target: goal });
              pollMarket();
            } else {
              patch({ startFailure: marketReason(result) });
            }
          } catch (error) {
            patch({ startFailure: errorText(error) });
          } finally {
            patch({ busy: false });
            updating = undefined;
          }
        });
        return updating;
      };

      const startUpdate = (force = false) => {
        if (updating) return updating;
        if (checking || isActiveOperation(snapshot.operation)) return Promise.resolve();
        const { manager, market, version } = snapshot;
        if (manager.phase === 'ready' && manager.candidate) return startOfficial(manager.candidate, manager.registry);
        // 市场按 npm 最新版解析目标；本地与托管安装它会拒绝，不去提交
        const marketReady = manager.phase === 'unsupported' && market.phase === 'ready' && market.updatable !== false
          && !manager.local && !manager.managed;
        if (marketReady && version.phase === 'ready' && version.updateAvailable) return startMarket(force);
        return Promise.resolve();
      };

      /** dshmarket 的重启：Web 版才支持，桌面版的重启归桌面壳管。 */
      const restart = async () => {
        const path = snapshot.market.endpoints?.restart;
        if (!path) return;
        patch({ restart: { phase: 'busy' } });
        try {
          const result = await marketRequest(path, 'POST', {});
          patch({ restart: result.status >= 200 && result.status < 300 ? { phase: 'done' } : { phase: 'error', reason: marketReason(result) } });
        } catch (error) {
          patch({ restart: { phase: 'error', reason: errorText(error) } });
        }
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
        restart,
        dispose: () => {
          disposed = true;
          clearTimeout(pollTimer);
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
      // 预发布版低于同号正式版（宿主可能装着预发布版）
      return /-/.test(String(installed).split('+')[0]) && !/-/.test(String(target).split('+')[0]);
    }

    function isActiveOperation(operation) {
      return operation?.state === 'queued' || operation?.state === 'running';
    }

    /** 有新版本却没有一键更新时，说明原因的文案 key；还在探测或检查失败时不说。 */
    function updateBlockerKey(manager, market, local, managed) {
      if (local) return 'updateLinked';
      if (managed) return 'updateManaged';
      if (manager.phase === 'blocked') return 'updateNotUpdatable';
      if (manager.phase === 'ready') return 'updateNoCompatible';
      if (manager.phase === 'unsupported' && market.phase === 'absent') return 'updateNoMarket';
      return undefined;
    }

    /**
     * 「插件更新」区块的纯渲染。
     *
     * 宿主有官方更新接口时，按钮只给宿主确认兼容的正式版（manager.candidate）；没有时退回 dshmarket，
     * 由市场按 npm 最新版解析。blocked 由卡片给出：模型草稿未保存或别的操作进行中时不开始更新。
     *
     * @param {{ version: object, manager: object, market: object, operation?: object, target?: string,
     *   busy?: boolean, restart?: object, startFailure?: string, blocked?: boolean, blockedHint?: string }} update
     */
    function renderUpdateSection(update, actions, t) {
      const { version, manager, market, operation } = update;
      const running = Boolean(update.busy) || isActiveOperation(operation);
      const ready = version.phase === 'ready';
      const viaMarket = manager.phase === 'unsupported';
      // 本地目录与 DSH 托管的安装两条更新路都不接，只说明怎么更新
      const local = manager.local === true || market.source === 'linked';
      const managed = manager.managed === true || market.source === 'generation';

      // 市场回报成功不等于装上的就是卡片答应的那个版本，客户端自己再核对一次（官方路径成功前已核对）；
      // 市场报的更新前版本高于目标时以它为准，装上的不能比原来还旧。
      let expected = update.target;
      if (operation?.beforeVersion && (!expected || versionBelow(expected, operation.beforeVersion))) expected = operation.beforeVersion;
      const mismatch = operation?.state === 'succeeded' && expected && versionBelow(operation.installedVersion, expected);
      // 当前运行版本要等重启 / 刷新才换，所以按实际安装版本判断是否已装上最新版；
      // 镜像落后、再查到更高版本或装上的版本不对时，仍需提供更新入口。
      const installed = operation?.state === 'succeeded' ? operation.installedVersion : manager.installedVersion;
      const latestInstalled = ready && Boolean(installed) && !mismatch && !versionBelow(installed, version.latestVersion);
      const outdated = ready && version.updateAvailable && !latestInstalled;

      let target;
      if (manager.phase === 'ready') {
        // 官方路径以宿主列出的兼容正式版为准：npm latest 滞后时不隐藏，已装上的版本不重复给
        if (manager.candidate && (!installed || versionBelow(installed, manager.candidate))) target = manager.candidate;
      } else if (viaMarket && market.phase === 'ready' && market.updatable !== false && !local && !managed && outdated) {
        target = version.latestVersion;
      }

      const head = [h('span', { key: 'title', className: 'plugin-update-title' }, t('updateTitle'))];
      if (ready) {
        const pending = latestInstalled && operation?.state === 'succeeded' ? operation.outcome : undefined;
        const badge = pending?.restartRequired
          ? t('updatePendingRestart')
          : pending?.refreshRequired
            ? t('updatePendingRefresh')
            : target || outdated
              ? t('updateAvailable')
              : t('updateUpToDate');
        head.push(h('span', { key: 'badge', className: 'badge' }, badge));
      }
      const checkBusy = version.phase === 'loading' || manager.phase === 'loading' || market.phase === 'loading';
      head.push(updateButton('check', 'outline', t('updateCheck'), actions.checkUpdate, checkBusy || running));
      if (target) {
        head.push(
          updateButton('update', 'primary', running ? t('updateRunning') : t('updateNow', { version: target }), () => actions.startUpdate(false), running || update.blocked),
        );
      }

      const section = [h('div', { key: 'head', className: 'bar' }, head)];
      if (update.blocked && !running) section.push(h('p', { key: 'blocked', className: 'muted' }, update.blockedHint));
      if (version.phase === 'loading') {
        section.push(h('p', { key: 'checking', className: 'muted' }, t('updateChecking')));
      } else if (version.phase === 'error') {
        section.push(updateNotice('checkError', { kind: 'error', text: t('updateCheckFailed', { reason: version.reason }) }));
      }
      if (version.currentVersion) {
        section.push(
          h(
            'p',
            { key: 'versions', className: 'muted' },
            t('updateCurrent'),
            h('strong', null, `v${version.currentVersion}`),
            ready ? '  ·  ' : null,
            ready ? t('updateLatestVersion') : null,
            ready ? h('strong', null, `v${version.latestVersion}`) : null,
          ),
        );
      }
      if (manager.phase === 'error') {
        section.push(updateNotice('managerError', { kind: 'error', text: t('updateManagerFailed', { reason: manager.reason }) }));
      }
      // 只在确实有新版本时说明为什么没有一键更新；已是最新时不打扰
      const blocker = outdated && !target && !operation ? updateBlockerKey(manager, market, local, managed) : undefined;
      if (blocker) section.push(h('p', { key: 'unavailable', className: 'muted' }, t(blocker)));

      if (isActiveOperation(operation)) {
        // 官方接口只报阶段，不伪造百分比；dshmarket 报百分比与 pnpm 输出摘要
        const percent = operation.progress?.percent;
        const text = operation.channel === 'official'
          ? t(UPDATE_STEPS[operation.step] ?? 'updateRunning')
          : typeof percent === 'number'
            ? t('updateProgress', { percent })
            : t('updateRunning');
        section.push(h('p', { key: 'progress', className: 'muted' }, text));
        if (operation.progress?.detail) section.push(h('p', { key: 'detail', className: 'muted' }, operation.progress.detail));
      } else if (operation?.state === 'succeeded') {
        const parts = [t('updateSucceeded', { version: operation.installedVersion })];
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        else if (operation.outcome?.refreshRequired) parts.push(t('updateRefreshHint'));
        section.push(updateNotice('done', { kind: 'ok', text: parts.join(' ') }));
        if (mismatch) {
          section.push(updateNotice('mismatch', { kind: 'error', text: t('updateMismatch', { installed: operation.installedVersion, target: expected }) }));
        }
        // 只有探测过的 dshmarket 才可能答 restartSupported（Web 版）
        if (operation.outcome?.restartRequired && market.restartSupported) {
          const restartBusy = update.restart?.phase === 'busy' || update.restart?.phase === 'done';
          section.push(
            h(
              'div',
              { key: 'restart', className: 'bar' },
              updateButton('restart', 'primary', restartBusy ? t('restarting') : t('restartNow'), actions.restart, restartBusy || update.blocked || Boolean(mismatch)),
            ),
          );
        }
      } else if (operation?.state === 'failed') {
        const code = operation.failure?.code;
        const reason = code === 'RELEASE_TOO_FRESH' ? t('updateTooFresh') : t('updateFailed', { reason: operation.failure?.message ?? code ?? '' });
        section.push(updateNotice('failed', { kind: 'error', text: reason }));
        if (operation.restoreFailure) {
          section.push(updateNotice('restoreFailed', { kind: 'error', text: t('updateRestoreFailed', { reason: operation.restoreFailure }) }));
        }
        if (operation.unknown) section.push(updateNotice('unknown', { kind: 'error', text: t('updateUnknown') }));
        if (FORCEABLE_FAILURES.has(code) && market.phase === 'ready' && market.updatable !== false) {
          section.push(
            h('div', { key: 'force', className: 'bar' }, updateButton('force', 'danger', t('updateForce'), () => actions.startUpdate(true), running || update.blocked)),
          );
        }
      } else if (operation?.state === 'cancelled') {
        section.push(updateNotice('cancelled', { kind: 'error', text: t('updateCancelled') }));
      } else if (operation?.state === 'rolled-back') {
        // 官方路径带上失败原因与恢复后是否要重启；dshmarket 的回滚只报保持的版本
        const parts = [];
        if (operation.failure?.message) parts.push(t('updateFailed', { reason: operation.failure.message }));
        parts.push(t('updateRolledBack', { version: operation.installedVersion }));
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        section.push(updateNotice('rolledBack', { kind: 'error', text: parts.join(' ') }));
      } else if (operation?.state === 'lost') {
        section.push(updateNotice('lost', { kind: 'ok', text: t('updateLost') }));
      }
      if (update.startFailure) {
        section.push(updateNotice('startFailed', { kind: 'error', text: t('updateStartFailed', { reason: update.startFailure }) }));
      }
      if (update.restart?.phase === 'error') {
        section.push(updateNotice('restartError', { kind: 'error', text: t('restartFailed', { reason: update.restart.reason }) }));
      }
      return section;
    }

    /**
     * 「插件更新」区块接到共享的更新器上（见 createPluginUpdater）：状态与进行中的任务都在更新器里，
     * 卡片挂卸只增减订阅。
     */
    function useUpdater(pluginUpdater) {
      const [model, setModel] = useState(pluginUpdater.getSnapshot());
      useEffect(() => {
        const off = pluginUpdater.subscribe(() => setModel(pluginUpdater.getSnapshot()));
        setModel(pluginUpdater.getSnapshot());
        // 版本路由与官方版本列表都有缓存，挂载时不强制重查
        pluginUpdater.check();
        return off;
      }, [pluginUpdater]);
      return {
        model,
        actions: {
          checkUpdate: () => pluginUpdater.check(true),
          startUpdate: (force) => pluginUpdater.startUpdate(force),
          restart: () => pluginUpdater.restart(),
        },
      };
    }

    function ModelsCard({ t, pluginUpdater }) {
      const [view, setView] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [modelBusy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [key, setKey] = useState('');
      const [search, setSearch] = useState('');
      const [expanded, setExpanded] = useState(new Set());
      const [drag, setDrag] = useState(null);
      const dragSource = useRef(null);
      const updater = useUpdater(pluginUpdater);
      const [tab, setTab] = useState('models');
      const [gateway, setGateway] = useState(null);
      const listRef = useRef(null);
      const positions = useRef(new Map());
      const cardRef = useRef(null);
      const footerSpaceRef = useRef(null);
      // 优先留在卡片末尾；原位置放不下时才贴窗口底边，并保留原位高度供滚动归位。
      useLayoutEffect(() => {
        const card = cardRef.current, space = footerSpaceRef.current, footer = space?.firstElementChild;
        if (!card || !footer) return;
        let frame;
        const align = () => {
          // 先恢复自然布局再测量，避免用悬浮后的坐标判断，或沿用提示换行前的高度。
          delete footer.dataset.docked;
          for (const key of ['left', 'width', 'visibility']) footer.style[key] = '';
          space.style.height = '';
          const rect = card.getBoundingClientRect();
          const natural = footer.getBoundingClientRect();
          if (natural.bottom <= window.innerHeight || rect.width <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return;
          space.style.height = `${natural.height}px`;
          footer.dataset.docked = '';
          footer.style.left = `${rect.left}px`;
          footer.style.width = `${rect.width}px`;
        };
        const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(align); };
        const observer = new ResizeObserver(queue);
        observer.observe(card);
        observer.observe(footer);
        window.addEventListener('resize', queue);
        window.addEventListener('scroll', queue, true);
        align();
        return () => {
          observer.disconnect(); cancelAnimationFrame(frame);
          window.removeEventListener('resize', queue);
          window.removeEventListener('scroll', queue, true);
          delete footer.dataset.docked;
          for (const key of ['left', 'width', 'visibility']) footer.style[key] = '';
          space.style.height = '';
        };
      }, [Boolean(view)]);
      // 排序、增删、展开或筛选后，各行从原来的位置滑到新位置（FLIP）。
      // 位置用 offsetTop 加拖动让位的位移，不受页面滚动影响；拖动进行中由样式过渡负责，不在这里动画。
      useLayoutEffect(() => {
        const list = listRef.current;
        if (!list) { positions.current = new Map(); return; }
        const next = new Map();
        for (const node of list.children) next.set(node.dataset.key, node.offsetTop + Number(node.dataset.shift || 0));
        const still = list.classList.contains('sorting') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (!still) for (const node of list.children) {
          const before = positions.current.get(node.dataset.key);
          const delta = before === undefined ? 0 : before - next.get(node.dataset.key);
          if (Math.abs(delta) >= 1) node.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: REORDER_MS, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
        positions.current = next;
      });
      const busy = modelBusy || updater.model.busy || isActiveOperation(updater.model.operation);
      const failure = (error) => ({ error: true, text: error?.code === 'INVALID_JSON' ? `${t('invalidJson')}（${error.message}）` : error.message });
      useEffect(() => {
        let active = true;
        request().then((value) => { publishConfig(value.config); if (active) setView(value); }).catch((error) => { if (active) setNotice(failure(error)); });
        return () => { active = false; };
      }, []);
      const operation = view?.backend?.operation;
      useEffect(() => {
        if (!operation?.running) return;
        let active = true, fetching = false;
        const timer = setInterval(async () => {
          if (fetching) return;
          fetching = true;
          try { const result = await request({ action: 'backend-status', magpiePath: operation.path }); if (active) setView((old) => ({ ...old, backend: result.backend })); }
          catch (error) { if (active) setNotice(failure(error)); }
          finally { fetching = false; }
        }, 1000);
        return () => { active = false; clearInterval(timer); };
      }, [operation?.id, operation?.running]);
      // Discover background operations even if the card was already open when they started.
      useEffect(() => {
        if (operation?.running) return;
        let active = true, fetching = false;
        const timer = setInterval(async () => {
          if (fetching) return;
          fetching = true;
          try {
            const result = await request({ action: 'backend-status', magpiePath: view?.config?.magpiePath || '' });
            if (active) setView((old) => old ? { ...old, backend: result.backend } : old);
          } catch { /* Next poll retries; model drafts remain intact. */ }
          finally { fetching = false; }
        }, STATUS_POLL_MS);
        return () => { active = false; clearInterval(timer); };
      }, [operation?.running, view?.config?.magpiePath]);
      // 网关状态按已保存的地址检查；保存或程序操作结束后重新检查。
      useEffect(() => {
        let active = true;
        const check = () => request({ action: 'status' }).then((result) => { if (active) setGateway(result.gateway); }, () => { if (active) setGateway({ online: false }); });
        check();
        const timer = setInterval(check, STATUS_POLL_MS);
        return () => { active = false; clearInterval(timer); };
      }, [view?.revision, operation?.running]);
      const perform = async (run) => {
        setBusy(true); setNotice(null);
        try { await run(); } catch (error) { setNotice(failure(error)); }
        finally { setBusy(false); }
      };
      const reload = () => perform(async () => { const value = await request(); publishConfig(value.config); setView(value); setDirty(false); setKey(''); setExpanded(new Set()); });
      const button = (text, click, extra = {}) => h('button', { type: 'button', disabled: busy, onClick: click, ...extra }, text);
      if (!view) return h('section', { className: 'dsm-mp' }, h('header', { className: 'head' }, h('div', { className: 'title' }, h(MagpieGlyph, { size: 20 }), h('h3', null, t('title')))),
        h('div', { className: 'panel' }, notice ? h('p', { className: 'notice error', role: 'alert' }, notice.text) : h('p', { className: 'muted' }, t('loading')), h('div', { className: 'bar', style: { marginTop: 12 } }, button(t('reload'), reload))));
      const config = view.config;
      const update = (patch) => { setView((v) => ({ ...v, config: { ...v.config, ...patch } })); setDirty(true); };
      const rows = config.models;
      const labelFor = (row) => displayModelName(row, view.providerNames) || t('newModel');
      const updateRow = (index, patch) => update({ models: rows.map((row, i) => i === index ? keepKey(row, { ...row, ...patch }) : row) });
      const field = (label, value, change, options = {}) => h('label', { className: 'field' }, label, h('input', { value: value ?? '', disabled: busy, onChange: (e) => change(e.target.value), ...options }));
      const backend = view.backend;
      const backendAction = (action) => perform(async () => {
        const result = await request({ action, magpiePath: config.magpiePath || '' });
        // 程序操作不保存或覆盖模型草稿；程序路径仍由原有保存流程持久化。
        setView((old) => ({ ...old, backend: result.backend }));
      });
      // 安装成功后按启动结果给出提示；启动失败不影响安装结果。
      const finished = (key) => operation.launchError ? t('backendLaunchFailed', { version: operation.version, reason: operation.launchError })
        : operation.alreadyRunning ? t('backendAlreadyRunning', { version: operation.version }) : t(key, { version: operation.version });
      const backendPhase = operation ? ({ checking: t('backendChecking'), stopping: t('backendStopping'), downloading: t('backendDownloading'), verifying: t('backendVerifying'), installing: t('backendInstalling'), starting: t('backendStarting'),
        'waiting-idle': t('backendWaitingIdle'), 'waiting-status': t('backendWaitingStatus'), 'cooling-down': t('backendCooling', { time: new Date(operation.eligibleAt).toLocaleString() }), 'invalid-release-date': t('backendInvalidDate'), cancelled: t('backendCancelled'),
        installed: finished('backendInstalled'), updated: finished('backendUpdated'), 'up-to-date': t('backendUpToDate'), failed: t('backendFailed', { reason: operation.reason }) })[operation.phase] : '';
      // 开关和下拉立即保存，只采纳这几项与新的版本号；卡片里未保存的连接设置和模型草稿保留。
      const applyNow = (patch) => perform(async () => {
        const result = await request({ action: 'patch', patch, revision: view.revision });
        publishConfig(result.config);
        setView((old) => ({ ...result, config: { ...old.config, ...patch } }));
        if (result.sync && !result.sync.ok) setNotice({ error: true, text: t('saveFailed', { reason: result.sync.reason }) });
      });
      const setKeepAwake = (keepAwake) => perform(async () => {
        const result = await request({ action: 'magpie-settings', keepAwake });
        setView((old) => ({ ...old, magpieSettings: result.magpieSettings }));
      });
      const openMagpie = () => perform(async () => {
        const result = await request({ action: 'backend-open', magpiePath: config.magpiePath || '' });
        setView((old) => ({ ...old, backend: result.backend, magpieSettings: result.magpieSettings }));
        setNotice({ text: t('opened') });
      });
      const magpieSettings = view.magpieSettings;
      const syncCatalog = () => perform(async () => {
        const result = await request({ action: 'sync-catalog', config, revision: view.revision, apiKey: key || undefined });
        publishConfig(result.config); setView(result); setDirty(false); setKey(''); setSearch(''); setExpanded(new Set());
        dragSource.current = null; setDrag(null);
        setNotice({ error: !result.sync.ok, text: result.sync.ok ? t('mirrored', { count: result.sync.count }) : t('saveFailed', { reason: result.sync.reason }) });
      });
      const save = () => perform(async () => {
        const result = await request({ action: 'save', config, revision: view.revision, apiKey: key || undefined });
        publishConfig(result.config); setView(result); setDirty(false); setKey('');
        setNotice({ error: !result.sync.ok, text: result.sync.ok ? t('saved', { count: result.sync.count }) : t('saveFailed', { reason: result.sync.reason }) });
      });
      const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => `${row.id} ${labelFor(row)}`.toLowerCase().includes(search.toLowerCase()));
      const visibleIndexes = new Set(visible.map(({ index }) => index));
      const selectVisible = (enabled) => update({ models: rows.map((m, i) => visibleIndexes.has(i) ? keepKey(m, { ...m, enabled }) : m) });
      // 排序模式决定「从 Magpie 同步」的顺序：model 按模型名称（默认）、catalog 沿用 Magpie 目录、manual 保留现有顺序。
      // 拖动、按供应商排序、只排部分搜索结果都算手动；对完整清单按模型或默认排序则恢复对应的自动顺序。
      const orderMode = config.manualOrder ? 'manual' : config.catalogOrder ? 'catalog' : 'model';
      const reorder = (order, mode) => {
        const same = order.every((index, i) => index === i);
        // 原位放下不算排序；顺序没变但模式变化时也需要保存。
        if (same && (mode === 'manual' || orderMode === mode)) return;
        update({ ...(same ? {} : { models: order.map((index) => rows[index]) }), manualOrder: mode === 'manual', catalogOrder: mode === 'catalog' });
        if (!same) setExpanded((old) => new Set([...old].map((i) => order.indexOf(i))));
      };
      const move = (index, target) => reorder(moveModel(rows.map((_row, i) => i), index, target), 'manual');
      // 只替换匹配条目所在的位置，隐藏模型原位置不动；sorted 是可见条目的新排列。
      const applySorted = (sorted, mode) => {
        const order = rows.map((_row, i) => i);
        visible.forEach(({ index }, i) => { order[index] = visible[sorted[i]].index; });
        reorder(order, visible.length === rows.length ? mode : 'manual');
        dragSource.current = null; setDrag(null);
      };
      const sort = (mode) => {
        if (busy || visible.length < 2) return;
        applySorted(sortModelIndexes(visible.map(({ row }) => row), mode, view.providerNames), mode === 'model' ? 'model' : 'manual');
      };
      // 默认排序：按 Magpie 当前目录的顺序；目录里没有的（手动添加等）保持原相对顺序排在后面。
      const sortDefault = () => perform(async () => {
        const { ids } = await request({ action: 'catalog-order', baseURL: config.baseURL, apiKey: key || undefined });
        const rank = new Map(ids.map((id, i) => [id, i]));
        const position = (i) => rank.get(visible[i].row.id) ?? ids.length;
        applySorted(visible.map((_v, i) => i).sort((a, b) => position(a) - position(b) || a - b), 'catalog');
      });
      // 拖动：其它行实时让出空位（样式过渡），松手后各行已在目标位置，直接换成新顺序。
      // 落点按列表里各行未位移的布局位置计算，让位的位移不会反过来改变落点。
      const slotAt = (event) => {
        const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
        const slot = [...event.currentTarget.children].findIndex((node) => y < node.offsetTop + node.offsetHeight / 2);
        return slot < 0 ? event.currentTarget.children.length : slot;
      };
      // 正常放下后浏览器仍会触发 dragend，此时已无拖动；取消拖动则先让各行滑回原位再清除状态。
      const endDrag = () => {
        const cancelled = dragSource.current !== null;
        dragSource.current = null;
        if (!cancelled) return setDrag(null);
        setDrag((old) => old ? { ...old, slot: undefined, ending: true } : null);
        setTimeout(() => setDrag((old) => old?.ending ? null : old), REORDER_MS);
      };
      // 只接受本卡片手柄发起的拖动；外部文本、另一张卡片及已过期的草稿不能触发排序。
      const canDrop = () => !busy && dragSource.current?.rows === rows;
      const dropAt = (slot) => {
        const source = dragSource.current.index;
        dragSource.current = null; setDrag(null);
        // 落在自己原来的位置（上下两侧的空隙）不算移动，搜索时也不会挪动夹在中间的隐藏模型。
        const at = visible.findIndex(({ index }) => index === source);
        if (slot === at || slot === at + 1) return;
        const target = visible[Math.min(slot, visible.length - 1)].index + Number(slot >= visible.length);
        move(source, target > source ? target - 1 : target);
      };
      const sourceAt = drag ? visible.findIndex(({ index }) => index === drag.source) : -1;
      // 拖动中每行的位移：被拖的行移到落点，途经的行向反方向让出它的高度。
      const shiftOf = (position) => {
        const slot = drag?.slot, sizes = drag?.sizes ?? [];
        if (sourceAt < 0 || slot === undefined) return 0;
        const span = (from, to) => sizes.slice(from, to).reduce((sum, size) => sum + size, 0);
        if (position === sourceAt) return slot > sourceAt ? span(sourceAt + 1, slot) : -span(slot, sourceAt);
        if (slot > sourceAt + 1 && position > sourceAt && position < slot) return -(sizes[sourceAt] ?? 0);
        if (slot < sourceAt && position >= slot && position < sourceAt) return sizes[sourceAt] ?? 0;
        return 0;
      };
      const remove = (index) => {
        update({ models: rows.filter((_m, i) => i !== index) });
        setExpanded((old) => new Set([...old].filter((i) => i !== index).map((i) => i > index ? i - 1 : i)));
      };
      const selected = rows.filter((m) => m.enabled).length;
      const unsupported = backend?.supported === false;
      // 设置行：左侧标题与一句说明，右侧控件；开关整行可点。
      const row = (title, hint, control, as = 'div') => h(as, { className: 'row' },
        h('span', { className: 'row-text' }, h('span', { className: 'row-title' }, title), hint ? h('span', { className: 'row-hint' }, hint) : null),
        h('span', { className: 'row-control' }, control));
      const toggle = (title, hint, checked, change, disabled) => row(title, hint,
        h('input', { type: 'checkbox', role: 'switch', className: 'switch', 'aria-label': title, checked, disabled, onChange: (e) => change(e.target.checked) }), 'label');
      const choice = (title, hint, value, options, change, disabled) => row(title, hint,
        h('div', { className: 'segmented', role: 'radiogroup', 'aria-label': title }, ...options.map(([option, label]) => h('button', {
          key: option, type: 'button', role: 'radio', 'aria-checked': value === option, className: value === option ? 'active' : '', disabled,
          onClick: () => value === option ? undefined : change(option),
        }, label))));
      const addModel = () => { update({ models: [...rows, { id: '', name: '', enabled: true, input: ['text'], reasoningEfforts: [] }] }); setExpanded((old) => new Set([...old, rows.length])); };
      const checkConnection = () => perform(async () => { const result = await request({ action: 'check', baseURL: config.baseURL, apiKey: key || undefined }); setNotice({ text: t('connected', { version: result.version }) }); });
      const pluginUpdate = updater.model.version?.phase === 'ready' && updater.model.version.updateAvailable;

      const header = h('header', { className: 'head' },
        h('div', null,
          h('div', { className: 'title' }, h(MagpieGlyph, { size: 20 }), h('h3', null, t('title'))),
          h('p', { className: 'head-desc' }, t('description')),
          h('div', { className: 'chips' },
            h('span', { className: `chip${gateway?.online ? ' ok' : gateway ? ' off' : ''}`, role: 'status' }, h('span', { className: 'dot', 'aria-hidden': true }),
              !gateway ? t('gatewayChecking') : gateway.online ? t('gatewayOnline', { version: gateway.version ?? '' }).trim() : t('gatewayOffline')),
            h('button', { type: 'button', className: 'chip', onClick: () => setTab('updates') },
              backend?.version ? t('programVersion', { version: backend.version }) : t(backend?.installed ? 'backendUnknown' : 'programMissing'),
              backend?.updateAvailable ? h('span', { className: 'new' }, ` · ${t('programUpgrade', { version: backend.latest.version })}`) : null))),
        button(t('open'), openMagpie, { disabled: busy || operation?.running || unsupported || !backend?.installed || !backend?.version }));

      const tabs = h('div', { className: 'tabs', role: 'tablist' }, ...TABS.map(([id, label]) => h('button', {
        key: id, type: 'button', role: 'tab', className: 'tab', id: `dsm-mp-tab-${id}`, 'aria-selected': tab === id, 'aria-controls': 'dsm-mp-panel', onClick: () => setTab(id),
      }, t(label),
      id === 'models' ? h('span', { className: 'count' }, rows.length) : null,
      id === 'updates' && (backend?.updateAvailable || pluginUpdate) ? h('span', { className: 'mark', 'aria-hidden': true }) : null)));

      const modelList = h('div', {
        className: `model-list${drag ? ' sorting' : ''}`, ref: listRef,
        onDragOver: (event) => {
          if (!canDrop()) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
          const slot = slotAt(event), { index: source, sizes } = dragSource.current;
          setDrag((old) => old?.slot === slot && !old.ending ? old : { source, sizes, slot });
        },
        onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDrag((old) => old ? { ...old, slot: undefined } : null); },
        onDrop: (event) => { if (!canDrop()) return; event.preventDefault(); dropAt(slotAt(event)); },
      }, ...visible.map(({ row: model, index }, position) => { const shift = shiftOf(position); return h('div', {
        className: `model${expanded.has(index) ? ' expanded' : ''}${drag?.source === index ? ' dragging' : ''}`, key: keyOf(model),
        'data-key': keyOf(model), 'data-shift': shift || undefined, style: shift ? { transform: `translateY(${shift}px)` } : undefined,
      },
        h('div', { className: 'model-header' },
          button(h('svg', { viewBox: '0 0 16 20', fill: 'currentColor', 'aria-hidden': true }, ...[5, 10, 15].flatMap((cy) => [5, 11].map((cx) => h('circle', { key: `${cx}-${cy}`, cx, cy, r: 1.4 })))), undefined, {
            className: 'model-drag', draggable: !busy && rows.length > 1, disabled: busy || rows.length < 2,
            title: t('drag', { name: labelFor(model) }), 'aria-label': t('drag', { name: labelFor(model) }),
            onDragStart: (event) => {
              if (busy || rows.length < 2) { event.preventDefault(); return; }
              // 各可见行连同行距的高度，供让位计算；拖动期间布局不变，开始时量一次即可。
              const items = [...(event.currentTarget.closest?.('.model-list')?.children ?? [])];
              const sizes = items.map((node, i) => items[i + 1] ? items[i + 1].offsetTop - node.offsetTop : node.offsetHeight);
              const current = dragSource.current = { index, rows, sizes };
              event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', model.id);
              event.dataTransfer.setDragImage?.(event.currentTarget.closest?.('.model') ?? event.currentTarget.parentElement, 20, 20);
              // 浏览器在 dragstart 之后才截取拖动图像；占位样式推迟一帧，免得拖出去的图像也是半透明的。
              setTimeout(() => { if (dragSource.current === current) setDrag((old) => old ?? { source: index, sizes }); }, 0);
            }, onDragEnd: endDrag,
            onKeyDown: (event) => {
              if (busy || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
              const neighbor = visible[visible.findIndex((item) => item.index === index) + (event.key === 'ArrowUp' ? -1 : 1)];
              if (!neighbor) return;
              event.preventDefault();
              move(index, neighbor.index);
            },
          }),
          h('label', { className: 'model-select', title: model.id }, h('input', { type: 'checkbox', checked: model.enabled, disabled: busy, onChange: (e) => updateRow(index, { enabled: e.target.checked }) }), h('span', { className: 'model-name' }, labelFor(model))),
          button(h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }, h('path', { d: 'm6 3 5 5-5 5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })), () => setExpanded((old) => { const next = new Set(old); if (next.has(index)) next.delete(index); else next.add(index); return next; }), { className: 'model-toggle', 'aria-expanded': expanded.has(index), 'aria-controls': `dsm-mp-details-${index}`, 'aria-label': t(expanded.has(index) ? 'collapse' : 'expand', { name: labelFor(model) }) }),
          h('div', { className: 'model-badges' }, model.input.includes('image') ? h('span', { className: 'badge' }, t('vision')) : null, model.contextWindow ? h('span', { className: 'badge' }, formatTokens(model.contextWindow)) : null),
          h('div', { className: 'model-actions' }, button(t('remove'), () => remove(index), { className: 'danger' }))),
        h('div', { className: 'model-details', id: `dsm-mp-details-${index}`, hidden: !expanded.has(index) },
          h('div', { className: 'fields' }, field(t('id'), model.id, (id) => updateRow(index, { id }), { placeholder: 'provider/model-id', spellCheck: false }), field(t('modelName'), model.name, (name) => updateRow(index, { name }), { placeholder: t('nameHint') })),
          h('div', { className: 'fields' },
            field(t('context'), model.contextWindow, (contextWindow) => updateRow(index, { contextWindow }), { type: 'number', min: 1, placeholder: t('unspecified') }),
            field(t('output'), model.maxTokens, (maxTokens) => updateRow(index, { maxTokens }), { type: 'number', min: 1, placeholder: t('unspecified') }),
            field(t('efforts'), model.effortText ?? model.reasoningEfforts.join(', '), (value) => updateRow(index, { effortText: value, reasoningEfforts: value.split(/[,，]/).map((x) => x.trim().toLowerCase()).filter(Boolean) }), { placeholder: t('effortHint') }),
            h('label', null, h('input', { type: 'checkbox', disabled: busy, checked: model.input.includes('image'), onChange: (e) => updateRow(index, { input: e.target.checked ? ['text', 'image'] : ['text'] }) }), t('vision'))))); }));

      const panels = {
        models: () => [
          toggle(t('sync'), t('syncHint'), config.syncEnabled, (syncEnabled) => applyNow({ syncEnabled }), busy || !view.editable),
          view.nativeProviders.length ? h('p', { className: 'notice' }, t('native')) : null,
          h('div', { className: 'toolbar' },
            h('input', { className: 'search', type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: search, onChange: (e) => setSearch(e.target.value) }),
            button(t('catalog'), syncCatalog, { disabled: busy || !view.editable }),
            button(t('add'), addModel)),
          h('div', { className: 'list-head' },
            h('span', { className: 'count' }, t('count', { selected, total: rows.length })),
            h('div', { className: 'list-actions' },
              button(t('all'), () => selectVisible(true), { className: 'ghost' }), button(t('none'), () => selectVisible(false), { className: 'ghost' }),
              h('span', { className: 'divider', 'aria-hidden': true }),
              button(t('sortDefault'), sortDefault, { className: 'ghost', title: t('sortDefaultHint'), disabled: busy || visible.length < 2 }),
              button(t('sortModel'), () => sort('model'), { className: 'ghost', title: t('sortModelHint'), disabled: busy || visible.length < 2 }),
              button(t('sortProvider'), () => sort('provider'), { className: 'ghost', title: t('sortProviderHint'), disabled: busy || visible.length < 2 }))),
          rows.length && orderMode !== 'model' ? h('p', { className: 'hint' }, t(orderMode === 'manual' ? 'manualOrder' : 'catalogOrder')) : null,
          !rows.length ? h('p', { className: 'empty' }, t('empty')) : !visible.length ? h('p', { className: 'empty' }, t('noMatch')) : null,
          modelList,
        ],
        connection: () => [
          h('p', { className: 'muted' }, t('connectionHint')),
          h('div', { className: 'fields' },
            field(t('url'), config.baseURL, (baseURL) => update({ baseURL }), { type: 'url', placeholder: 'http://127.0.0.1:3425' }),
            h('label', { className: 'field' }, t('protocol'), h('select', { value: config.api, disabled: busy, onChange: (e) => update({ api: e.target.value }) },
              ...[['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']].map(([value, label]) => h('option', { key: value, value }, label)))),
            field(t('key'), key, (value) => { setKey(value); setDirty(true); }, { type: 'password', autoComplete: 'new-password', disabled: busy || !view.keyWritable, placeholder: t(view.keyConfigured ? 'keySaved' : 'keyEmpty') })),
          h('p', { className: 'hint' }, t(view.keyWritable ? 'keyHint' : 'keyReadonly')),
          h('div', { className: 'bar', style: { marginTop: 14 } }, button(t('check'), checkConnection)),
        ],
        preferences: () => [
          h('h4', { className: 'group' }, t('groupProgram')),
          toggle(t('autoStart'), t('autoStartHint'), config.autoStart !== false, (autoStart) => applyNow({ autoStart }), busy || !view.editable || unsupported),
          toggle(t('closeOnExit'), t('closeOnExitHint'), config.closeOnExit === true, (closeOnExit) => applyNow({ closeOnExit }), busy || !view.editable || unsupported),
          h('h4', { className: 'group' }, t('groupMagpieSettings'), h('span', null, t('groupMagpieSettingsHint'))),
          toggle(t('autoLightweight'), t('autoLightweightHint'), config.autoLightweight !== false, (autoLightweight) => applyNow({ autoLightweight }), busy || !view.editable || unsupported),
          choice(t('keepAwake'), magpieSettings?.available ? t('keepAwakeHint') : t('magpieSettingsMissing'), magpieSettings?.keepAwake ?? 'off',
            [['off', t('keepAwakeOff')], ['on', t('keepAwakeOn')], ['display', t('keepAwakeDisplay')]], setKeepAwake, busy || !magpieSettings?.available),
          h('h4', { className: 'group' }, t('groupDsh')),
          choice(t('sidebarEntry'), t('sidebarEntryHint'), config.sidebarEntry ?? 'auto', Object.entries(SIDEBAR_MODES).map(([value, label]) => [value, t(label)]),
            (sidebarEntry) => applyNow({ sidebarEntry }), busy || !view.editable),
        ],
        updates: () => [
          toggle(t('autoUpdate'), t('autoUpdateHint'), config.autoUpdate !== false, (autoUpdate) => applyNow({ autoUpdate }), busy || !view.editable),
          h('section', { className: 'block backend' },
            h('div', { className: 'bar spread' }, h('h4', null, t('backendTitle')),
              h('div', { className: 'bar' },
                button(t('backendCheck'), () => backendAction('backend-check'), { disabled: busy || operation?.running || unsupported }),
                button(t(backend?.installed ? 'backendUpgrade' : 'backendDownload'), () => backendAction('backend-install'), {
                  className: !backend?.installed || backend?.updateAvailable ? 'primary' : '',
                  disabled: busy || operation?.running || unsupported || (backend?.installed && (!backend.version || (backend.latest && !backend.updateAvailable))),
                }))),
            h('div', { className: 'versions' },
              h('span', null, backend?.version ? t('backendCurrent', { version: backend.version }) : t(backend?.installed ? 'backendUnknown' : 'backendMissing')),
              backend?.latest ? h('span', null, t('backendLatest', { version: backend.latest.version })) : null),
            backend?.reason ? h('p', { className: 'notice error', role: 'alert' }, backend.reason) : null,
            backendPhase ? h('p', { className: `notice${operation.phase === 'failed' || operation.launchError ? ' error' : ''}`, role: operation.phase === 'failed' || operation.launchError ? 'alert' : 'status' }, backendPhase) : null,
            operation?.running ? h('progress', { value: operation.received, max: operation.total || 1, 'aria-label': t('backendDownloading') }) : null,
            operation?.running && operation.total ? h('p', { className: 'hint' }, t('backendProgress', { received: (operation.received / 1048576).toFixed(1), total: (operation.total / 1048576).toFixed(1) })) : null,
            h('div', { className: 'fields' }, field(t('backendPath'), config.magpiePath, (magpiePath) => {
              update({ magpiePath }); setView((old) => ({ ...old, backend: { ...old.backend, installed: false, version: null, reason: null } }));
            }, { placeholder: backend?.defaultPath || t('backendDefault'), disabled: busy || operation?.running })),
            h('p', { className: 'hint' }, t('backendPathHint')),
            backend?.path ? h('p', { className: 'hint backend-path' }, backend.path) : null),
          h('section', { className: 'plugin-update', 'aria-label': t('updateTitle') }, renderUpdateSection({ ...updater.model,
            blocked: dirty || modelBusy || operation?.running,
            blockedHint: dirty ? t('updateSaveFirst') : t('updateWait'),
          }, updater.actions, t)),
        ],
      };

      return h('section', { className: 'dsm-mp', 'aria-busy': busy, ref: cardRef },
        header, tabs,
        h('div', { className: 'panel', role: 'tabpanel', id: 'dsm-mp-panel', 'aria-labelledby': `dsm-mp-tab-${tab}` }, ...panels[tab]()),
        h('div', { className: 'foot-space', ref: footerSpaceRef }, h('footer', { className: 'foot' },
          notice ? h('p', { className: `notice${notice.error ? ' error' : ''}`, role: notice.error ? 'alert' : 'status' }, notice.text) : null,
          !view.editable ? h('p', { className: 'error' }, t('readOnly')) : null,
          h('div', { className: 'bar spread' },
            h('span', { className: `state${dirty ? ' dirty' : ''}` }, t(dirty ? 'unsaved' : 'savedState')),
            h('div', { className: 'bar' }, button(t(dirty ? 'discard' : 'reload'), reload), button(t(busy ? 'saving' : 'save'), save, { className: 'primary', disabled: busy || !view.editable }))))),
      );
    }

    function MagpiePage(props) {
      return h('div', { className: 'dsm-mp-page' }, h(ModelsCard, props));
    }
    // 宿主侧栏图标为单色，按 currentColor 跟随选中和主题；鸟身挖空腹部与眼睛，取自插件图标轮廓。
    function MagpieGlyph({ size = 16 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '8 8 52 52', fill: 'currentColor', 'aria-hidden': true },
        h('path', { fillRule: 'evenodd', d: 'm12 50 12-21c0-9 5-16 13-16 7 0 12 5 12 12l8 5-10 3c-3 9-9 14-18 10L12 54zM28 28c0 7 3 13 9 15 5-2 8-6 10-11-7 3-12 1-19-4zM43 23a2 2 0 1 1-4 0a2 2 0 1 1 4 0z' }));
    }

    /** 侧栏入口行按设置与已保存清单显示；整页随宿主支持侧栏页面时常驻，入口隐藏时只是无法从侧栏进入。 */
    function registerSidebar(ctx, t, pluginUpdater) {
      let supported = false, disposed = false, layout, offRow, offPanel, attempts = 0;
      const off = (dispose) => { if (typeof dispose === 'function') dispose(); };
      const decide = () => {
        if (!supported || disposed) return;
        const show = sidebarVisible(savedConfig.value, layout?.panelInfo.getSnapshot().activePanelId === PANEL_ID);
        if (show && !offRow) {
          offRow = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('sidebarLabel'), locale: namespace }, MagpieGlyph) ?? true;
        } else if (!show && offRow) {
          off(offRow); offRow = undefined;
        }
      };
      const loadConfig = () => request().then((value) => {
        // 卡片已发布过更新的结果时不用这次读取覆盖。
        if (savedConfig.value === undefined) publishConfig(value.config);
      }, () => { if (!disposed && ++attempts < CONFIG_RETRIES) setTimeout(loadConfig, CONFIG_RETRY_MS); });
      // 旧版宿主没有侧栏页面，不会声明该槽位；此时只保留插件设置里的卡片。
      ctx.slots.inject('sidebar.panellist', () => {
        off(offRow); off(offPanel); offRow = undefined;
        supported = true;
        offPanel = ctx.slots.register({ name: 'main', key: PANEL_ID, locale: namespace, inject: () => ({ t, pluginUpdater }) }, MagpiePage);
        decide();
        if (savedConfig.value === undefined && attempts === 0) loadConfig();
      });
      ctx.effect(() => { savedConfig.listeners.add(decide); return () => savedConfig.listeners.delete(decide); }, 'dsh-magpie: sidebar config');
      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], (scoped) => {
          layout = scoped.layout;
          scoped.effect(() => {
            const unsubscribe = layout.panelInfo.subscribe(decide);
            decide();
            return () => { off(unsubscribe); layout = undefined; };
          }, 'dsh-magpie: sidebar active panel');
        });
      }
      ctx.effect(() => () => {
        disposed = true;
        // 先离开本页面再撤下整页，避免主区域停在已不存在的面板上。
        if (layout?.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null);
        off(offRow); off(offPanel); offRow = offPanel = undefined;
      }, 'dsh-magpie: sidebar');
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-magpie: locale');
      const t = ctx.locale.bind(namespace);
      let tag = document.querySelector('style[data-plugin-css="dsh-magpie"]');
      if (!tag) { tag = document.createElement('style'); tag.dataset.pluginCss = 'dsh-magpie'; document.head.appendChild(tag); }
      tag.textContent = CSS;
      // 更新器随插件生命周期存在：设置页的两处卡片与侧栏页面共用；插件卸载时停掉市场任务的轮询
      const pluginUpdater = createPluginUpdater(ctx.remote);
      ctx.effect(() => () => pluginUpdater.dispose(), 'dsh-magpie: plugin updater');
      // 插件管理器每完成一次操作就广播 changed（含官方插件页的「更新」），据此静默重读安装状态。
      // 只是锦上添花：宿主没有这个事件时不该连累卡片注册失败。
      ctx.effect(() => {
        try {
          return ctx.remote.$on('plugin-manager/changed', () => pluginUpdater.refresh());
        } catch (error) {
          console.warn('[dsh-magpie] 订阅插件变更失败：', error);
          return () => {};
        }
      }, 'dsh-magpie: plugin changes');
      for (const [slot, key] of [['plugins.bundle.config', '@zhiqiangme/dsh-magpie'], ['plugins.row.config', '@zhiqiangme/dsh-magpie#dsh-magpie']]) {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: 30, locale: namespace, inject: () => ({ t, pluginUpdater }) }, ModelsCard));
      }
      registerSidebar(ctx, t, pluginUpdater);
    }
    // remote 只为官方插件管理器（pluginManager）与它的事件；pluginManager 本身不声明，旧宿主没有它也能加载。
    return { name: 'dsh-magpie-client', inject: ['slots', 'locale', 'remote'], apply, ModelsCard, MagpiePage, MagpieGlyph, sidebarVisible, moveModel, displayModelName, sortModelIndexes, renderUpdateSection, createPluginUpdater, zh, en };
  },
});
