/* DSH 自带 React 与模块加载器；与仓库其它插件一致，不引入单独构建链。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-magpie',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;
    const namespace = 'settings.dsh-magpie';
    const path = '/plugins/dsh-magpie/models';
    const zh = {
      title: 'Magpie 模型管理', description: '可以手动编辑；从 Magpie 同步会全量覆盖当前清单，并立即保存和更新 DSH。',
      loading: '正在读取配置…', reload: '重新载入', discard: '放弃更改并重新载入', connection: '连接设置',
      url: 'Magpie 网关地址', protocol: 'API 协议', key: '网关 Key', keyHint: '本机可留空；远程网关需要有效 Key。已保存时留空表示沿用。',
      keySaved: '已保存 Key', keyEmpty: '使用本机标识', keyReadonly: 'Key 由环境变量提供，只读',
      check: '检查连接', connected: '已连接 Magpie {version}', catalog: '从 Magpie 同步',
      mirrored: '已按 Magpie 当前目录覆盖保存，DSH 分组现有 {count} 个模型。',
      sync: '同步所选模型到 DSH', syncHint: '关闭同步或取消全部勾选，保存后移除“Magpie · DSH”分组。',
      native: '当前还有 Magpie 原生分组。这里保存到独立的“Magpie · DSH”分组，原分组仍可使用。',
      count: '{selected} / {total} 个模型已勾选', search: '搜索名称或 ID', add: '手动添加模型',
      sortModel: '按模型排序', sortProvider: '按供应商排序',
      sortModelHint: '对当前搜索结果按模型名称升序排列', sortProviderHint: '对当前搜索结果按供应商简称、模型名称升序排列',
      all: '全选', none: '取消全选', empty: '清单为空。添加模型，或从正在运行的 Magpie 同步。',
      noMatch: '没有匹配的模型。', id: '完整模型 ID', modelName: '显示名称', nameHint: '留空使用模型 ID',
      selected: '同步此模型', drag: '拖动调整 {name} 的顺序', remove: '删除', details: '能力与参数',
      expand: '展开 {name} 的详细配置', collapse: '收起 {name} 的详细配置', newModel: '新模型',
      context: '上下文窗口', output: '最大输出 token', vision: '支持图片输入', efforts: '思考档位（逗号分隔）',
      effortHint: '留空表示不声明思考档位', unspecified: '不指定', save: '保存并同步', saving: '处理中…',
      saved: '已保存，DSH 分组现有 {count} 个模型。', saveFailed: '清单已保存，同步未完成：{reason}',
      readOnly: '宿主配置服务尚未就绪，暂时无法保存。', unsaved: '有未保存的更改', savedState: '已保存',
      invalidJson: '服务返回了无效响应',
      backendTitle: 'Magpie 下载与升级', backendMissing: '尚未下载', backendUnknown: '版本未识别',
      backendPath: 'Magpie 程序路径', backendPathHint: '留空使用插件独立目录；也可填写已有 Magpie 的 exe 绝对路径。更改路径后点击保存并同步保存配置。',
      backendDefault: '留空使用插件独立目录', backendCheck: '检查更新', backendDownload: '下载 Magpie', backendUpgrade: '升级 Magpie',
      backendLatest: '最新版本：{version}', backendCurrent: '当前版本：{version}', backendUpToDate: '已是最新版本或更新',
      backendChecking: '正在检查版本…', backendDownloading: '正在下载…', backendVerifying: '正在校验程序…', backendInstalling: '正在替换程序…',
      backendInstalled: 'Magpie {version} 已下载，请从程序路径启动。', backendUpdated: '已升级到 Magpie {version}，可以重新启动 Magpie。',
      backendProgress: '已下载 {received} / {total} MiB', backendFailed: '操作失败：{reason}',
      updateTitle: '插件更新', updateChecking: '正在检查更新…', updateCheck: '检查更新',
      updateCheckFailed: '检查更新失败：{reason}', updateCurrent: '当前运行版本：', updateLatestVersion: 'npm 最新版本：',
      updateUpToDate: '已是最新', updateAvailable: '有新版本', updatePendingRestart: '等待重启', updatePendingRefresh: '等待刷新',
      updateNow: '更新到 v{version}', updateNoMarket: '安装 DSH 插件市场（dshmarket）后可在此更新插件。',
      updateLinked: '本插件从本地目录（file:）安装，请在源码目录更新后重新运行 install-plugins.cmd；从 npm 安装后可在此一键更新。',
      updateManaged: '本插件由 DSH 桌面端统一管理，请通过宿主管理插件版本。',
      updateRunning: '正在更新…', updateProgress: '正在更新… {percent}%', updateStartFailed: '没能开始更新：{reason}',
      updateSucceeded: '已更新到 v{version}。', updateRestartHint: '重启 DSH 后生效。', updateRefreshHint: '刷新页面后生效。',
      updateMismatch: '实际安装版本 v{installed} 低于预期的 v{target}，请重新检查后再更新。',
      updateFailed: '更新失败：{reason}', updateTooFresh: '新版本尚在 pnpm 发布冷却期内，可以稍后重试，或强制更新。',
      updateForce: '强制更新', updateCancelled: '更新已取消。', updateRolledBack: '更新已回滚，插件保持在 v{version}。',
      updateLost: '上次更新任务已结束或 DSH 已重启，请以当前版本为准。',
      updateSaveFirst: '请先保存或放弃模型更改，再更新插件。', updateWait: '请等待当前操作完成后再更新插件。',
      restartNow: '立即重启 DSH', restarting: '正在重启 DSH…', restartFailed: '未能确认重启：{reason}',
    };
    const en = {
      title: 'Magpie models', description: 'Edit manually, or sync from Magpie to replace the entire list, save it and update DSH immediately.',
      loading: 'Loading configuration…', reload: 'Reload', discard: 'Discard edits and reload', connection: 'Connection',
      url: 'Magpie gateway URL', protocol: 'API protocol', key: 'Gateway key', keyHint: 'Optional on this machine; required for a remote gateway. Leave blank to keep the saved key.',
      keySaved: 'Key saved', keyEmpty: 'Using local identity', keyReadonly: 'The environment supplies a read-only key',
      check: 'Check connection', connected: 'Connected to Magpie {version}', catalog: 'Sync from Magpie',
      mirrored: 'Replaced and saved the list from Magpie. The DSH group now has {count} models.',
      sync: 'Sync selected models to DSH', syncHint: 'Turning sync off or deselecting all models removes the “Magpie · DSH” group when saved.',
      native: 'Magpie native groups are also configured. This list uses its own “Magpie · DSH” group; existing groups remain available.',
      count: '{selected} / {total} models selected', search: 'Search names or IDs', add: 'Add a model',
      sortModel: 'Sort by model', sortProvider: 'Sort by provider',
      sortModelHint: 'Sort matching models by name, ascending', sortProviderHint: 'Sort matching models by short provider name, then model name, ascending',
      all: 'Select all', none: 'Deselect all', empty: 'The list is empty. Add models or sync from a running Magpie.',
      noMatch: 'No matching models.', id: 'Full model ID', modelName: 'Display name', nameHint: 'Defaults to model ID',
      selected: 'Sync this model', drag: 'Drag to reorder {name}', remove: 'Delete', details: 'Capabilities and limits',
      expand: 'Expand details for {name}', collapse: 'Collapse details for {name}', newModel: 'New model',
      context: 'Context window', output: 'Max output tokens', vision: 'Image input', efforts: 'Reasoning levels (comma-separated)',
      effortHint: 'Leave blank to declare no reasoning levels', unspecified: 'Unspecified', save: 'Save and sync', saving: 'Working…',
      saved: 'Saved. The DSH group now has {count} models.', saveFailed: 'List saved; sync incomplete: {reason}',
      readOnly: 'Host configuration services are not ready. Saving is unavailable.', unsaved: 'Unsaved edits', savedState: 'Saved',
      invalidJson: 'The server returned an invalid response',
      backendTitle: 'Download and update Magpie', backendMissing: 'Not downloaded', backendUnknown: 'Unrecognized version',
      backendPath: 'Magpie executable path', backendPathHint: 'Leave blank for the plugin directory, or enter an existing Magpie exe absolute path. Save and sync to keep path changes.',
      backendDefault: 'Leave blank for the plugin directory', backendCheck: 'Check for updates', backendDownload: 'Download Magpie', backendUpgrade: 'Update Magpie',
      backendLatest: 'Latest: {version}', backendCurrent: 'Current: {version}', backendUpToDate: 'Up to date or newer',
      backendChecking: 'Checking version…', backendDownloading: 'Downloading…', backendVerifying: 'Verifying executable…', backendInstalling: 'Replacing executable…',
      backendInstalled: 'Magpie {version} downloaded. Launch it from the executable path.', backendUpdated: 'Updated to Magpie {version}. You can restart Magpie.',
      backendProgress: 'Downloaded {received} / {total} MiB', backendFailed: 'Operation failed: {reason}',
      updateTitle: 'Plugin update', updateChecking: 'Checking for updates…', updateCheck: 'Check for updates',
      updateCheckFailed: 'Update check failed: {reason}', updateCurrent: 'Running version: ', updateLatestVersion: 'Latest on npm: ',
      updateUpToDate: 'Up to date', updateAvailable: 'Update available', updatePendingRestart: 'Restart pending', updatePendingRefresh: 'Reload pending',
      updateNow: 'Update to v{version}', updateNoMarket: 'Install the DSH plugin market (dshmarket) to update here.',
      updateLinked: 'This plugin was installed from a local directory (file:). Update its checkout and run install-plugins.cmd again, or install from npm for one-click updates.',
      updateManaged: 'DSH Desktop manages this plugin. Use the host to manage its version.',
      updateRunning: 'Updating…', updateProgress: 'Updating… {percent}%', updateStartFailed: 'Could not start the update: {reason}',
      updateSucceeded: 'Updated to v{version}.', updateRestartHint: 'Restart DSH to apply it.', updateRefreshHint: 'Reload the page to apply it.',
      updateMismatch: 'Installed v{installed} is below the expected v{target}. Check again before updating.',
      updateFailed: 'Update failed: {reason}', updateTooFresh: 'The new version is inside pnpm’s release cool-down. Retry later or force the update.',
      updateForce: 'Force update', updateCancelled: 'Update cancelled.', updateRolledBack: 'Update rolled back; the plugin stays at v{version}.',
      updateLost: 'The previous update task ended or DSH restarted. Use the current version shown here.',
      updateSaveFirst: 'Save or discard model edits before updating the plugin.', updateWait: 'Wait for the current operation before updating the plugin.',
      restartNow: 'Restart DSH now', restarting: 'Restarting DSH…', restartFailed: 'Could not confirm restart: {reason}',
    };
    // 沿用 WB 的 dshmarket 公开 API v1；插件独立发布，保持包内实现，不依赖 WB 安装。
    const PACKAGE_NAME = '@zhiqiangme/dsh-magpie';
    const VERSION_PATH = '/plugins/dsh-magpie/version';
    const MARKET_CAPABILITIES_PATH = '/dsh-market/api/v1/capabilities';
    const MARKET_SCHEMA = 'dsh-market/update-api/v1';
    const MARKET_DEFAULT_ENDPOINTS = {
      updates: '/dsh-market/api/v1/updates', operations: '/dsh-market/api/v1/operations', restart: '/dsh-market/api/v1/restart',
    };
    const POLL_MS = 1000;
    // 自身更新可能重新挂载卡片；记录任务以便恢复进度，bootId 防止串到宿主重启前的任务。
    const OPERATION_STORAGE_KEY = 'dsh-magpie:update-operation';
    const FORCEABLE_FAILURES = new Set(['RELEASE_TOO_FRESH', 'VERSION_UNCHANGED']);

    async function versionRequest(url) {
      const response = await fetch(url, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.reason || `HTTP ${response.status}`);
      return payload;
    }
    const CSS = `
      .dsm-mp{color:var(--dsw-alias-label-primary,#202635);border:1px solid var(--dsw-alias-border-l2,#dce1eb);border-radius:12px;padding:20px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:13px;line-height:1.6;box-sizing:border-box;min-width:0}
      .dsm-mp *{box-sizing:border-box}.dsm-mp h3{font-size:17px;margin:0}.dsm-mp p{margin:6px 0 12px}.dsm-mp .muted{color:var(--dsw-alias-label-secondary,#657084)}
      .dsm-mp .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsm-mp .spread{justify-content:space-between}.dsm-mp .section{margin-top:16px}.dsm-mp .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}
      .dsm-mp label.field{display:flex;flex-direction:column;gap:4px;min-width:0}.dsm-mp input:not([type=checkbox]),.dsm-mp select{width:100%;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#dce1eb);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;font:inherit}
      .dsm-mp button{border:1px solid var(--dsw-alias-border-l2,#dce1eb);border-radius:6px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;font:inherit;cursor:pointer}.dsm-mp button:disabled{color:var(--dsw-alias-label-dimmed,#8a8f99);cursor:default}.dsm-mp button.danger{color:var(--dsw-alias-state-error-primary,#b93645)}
      /* DSH 的 brand-primary 在深色主题接近白色；主按钮使用宿主的反色配色。 */
      .dsm-mp button.primary{background:var(--dsw-alias-label-primary,#202635);border-color:transparent;color:var(--dsw-alias-bg-layer-3,#f2f5fb)}.dsm-mp button.primary:hover:not(:disabled){opacity:.88}.dsm-mp button.primary:disabled{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-dimmed,#8a8f99);border-color:var(--dsw-alias-border-l2,#dce1eb)}
      .dsm-mp .model-list{margin-top:10px;display:flex;flex-direction:column;gap:2px}.dsm-mp .model{border:1px solid transparent;border-radius:8px;min-width:0}.dsm-mp .model:hover,.dsm-mp .model.expanded{background:var(--dsw-alias-bg-layer-3,#f2f5fb)}.dsm-mp .model.expanded{border-color:var(--dsw-alias-border-l2,#dce1eb)}
      .dsm-mp .model-header{display:flex;align-items:center;gap:6px;padding:6px 8px;min-width:0;min-height:42px}.dsm-mp .model-select{display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer}.dsm-mp .model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsm-mp .model input[type=checkbox]{margin:0;flex:none;accent-color:var(--dsw-alias-brand-primary,#4666db)}
      .dsm-mp .model-drag{padding:3px;flex:none;border-color:transparent;background:transparent;cursor:grab;line-height:1;color:var(--dsw-alias-label-secondary,#657084)}.dsm-mp .model-drag:active{cursor:grabbing}.dsm-mp .model-drag svg{display:block;width:16px;height:20px;pointer-events:none}.dsm-mp .model.dragging{opacity:.45}.dsm-mp .model.drop-before{border-top-color:var(--dsw-alias-label-primary,#202635)}.dsm-mp .model.drop-after{border-bottom-color:var(--dsw-alias-label-primary,#202635)}
      .dsm-mp .model-toggle{padding:4px 6px;line-height:1;border-color:transparent;background:transparent;flex:none}.dsm-mp .model-toggle svg{display:block;width:16px;height:16px;transition:transform .15s}.dsm-mp .model-toggle[aria-expanded=true] svg{transform:rotate(90deg)}.dsm-mp .model-badges{display:flex;gap:6px;margin-left:auto;flex:none}.dsm-mp .badge{padding:0 5px;border:1px solid var(--dsw-alias-border-l2,#dce1eb);border-radius:4px;color:var(--dsw-alias-label-secondary,#657084);font-size:12px;white-space:nowrap}
      .dsm-mp .model-actions{display:flex;gap:4px;flex:none;margin-left:auto}.dsm-mp .model-badges+.model-actions{margin-left:4px}.dsm-mp .model-actions button{padding:3px 7px;background:transparent}.dsm-mp .model-details{padding:0 12px 12px;min-width:0}.dsm-mp .model-details[hidden]{display:none}
      .dsm-mp summary{cursor:pointer}.dsm-mp details>summary{color:var(--dsw-alias-label-secondary,#657084)}.dsm-mp .notice{padding:10px 12px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#f2f5fb);overflow-wrap:anywhere}.dsm-mp .error{color:var(--dsw-alias-state-error-primary,#b93645)}
      .dsm-mp .search{flex:1;min-width:160px}.dsm-mp .foot{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#dce1eb)}
      .dsm-mp .backend .bar{margin-top:10px}.dsm-mp .backend-path,.dsm-mp .backend .error{overflow-wrap:anywhere}.dsm-mp .backend progress{display:block;width:100%;height:8px;margin-top:10px;accent-color:var(--dsw-alias-label-primary,#202635)}
      .dsm-mp .plugin-update{margin-top:20px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,#dce1eb)}.dsm-mp .plugin-update p{overflow-wrap:anywhere}.dsm-mp .plugin-update-title{font-weight:600}
      @media(max-width:600px){.dsm-mp{padding:14px}.dsm-mp .fields{grid-template-columns:minmax(0,1fr)}.dsm-mp .search{flex-basis:100%}.dsm-mp .model-badges{display:none}.dsm-mp .model-select{flex:1}.dsm-mp .model-actions{margin-left:auto}}
    `;

    async function request(body) {
      const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      const value = await res.json();
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

    function renderUpdateSection(update, actions, t) {
      const version = update.version ?? { phase: 'loading' };
      const market = update.market ?? { phase: 'loading' };
      const operation = update.operation;
      const running = Boolean(update.busy) || isActiveOperation(operation);
      const ready = version.phase === 'ready';

      // 当前运行版本要等重启/刷新才换；仅当实际安装版本覆盖当前查到的最新版时，
      // 才用成功结果覆盖徽章。镜像落后或再查到更高版本时，仍需提供更新入口。
      let expected = update.target;
      if (operation?.beforeVersion && (!expected || versionBelow(expected, operation.beforeVersion))) expected = operation.beforeVersion;
      const mismatch = operation?.state === 'succeeded' && expected && versionBelow(operation.installedVersion, expected);
      const latestInstalled = operation?.state === 'succeeded' && !mismatch && !versionBelow(operation.installedVersion, version.latestVersion);
      const head = [h('span', { key: 'title', className: 'plugin-update-title' }, t('updateTitle'))];
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
        head.push(h('span', { key: 'badge', className: 'badge' }, badge.text));
      }
      head.push(updateButton('check', 'outline', t('updateCheck'), actions.checkUpdate, version.phase === 'loading' || running));
      // 只隐藏已安装版本覆盖的更新，避免重复安装，同时允许补齐或继续升级。
      if (ready && !latestInstalled && version.updateAvailable && market.phase === 'ready' && market.updatable !== false) {
        head.push(
          updateButton('update', 'primary', running ? t('updateRunning') : t('updateNow', { version: version.latestVersion }), () => actions.startUpdate(false), running || update.blocked),
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
      if (ready && version.updateAvailable && market.phase === 'absent' && !operation) {
        section.push(h('p', { key: 'noMarket', className: 'muted' }, t('updateNoMarket')));
      }
      if (ready && version.updateAvailable && market.phase === 'ready' && market.updatable === false && !operation) {
        section.push(h('p', { key: 'unmanaged', className: 'muted' }, t(market.source === 'linked' ? 'updateLinked' : 'updateManaged')));
      }

      if (isActiveOperation(operation)) {
        const percent = operation.progress?.percent;
        section.push(
          h('p', { key: 'progress', className: 'muted' }, typeof percent === 'number' ? t('updateProgress', { percent }) : t('updateRunning')),
        );
        if (operation.progress?.detail) section.push(h('p', { key: 'detail', className: 'muted' }, operation.progress.detail));
      } else if (operation?.state === 'succeeded') {
        const parts = [t('updateSucceeded', { version: operation.installedVersion })];
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        else if (operation.outcome?.refreshRequired) parts.push(t('updateRefreshHint'));
        section.push(updateNotice('done', { kind: 'ok', text: parts.join(' ') }));
        // 文档要求客户端自己再核对一次：市场回报成功，不等于装上的就是卡片上答应的那个版本
        if (mismatch) {
          section.push(updateNotice('mismatch', { kind: 'error', text: t('updateMismatch', { installed: operation.installedVersion, target: expected }) }));
        }
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
        if (FORCEABLE_FAILURES.has(code) && market.phase === 'ready' && market.updatable !== false) {
          section.push(
            h('div', { key: 'force', className: 'bar' }, updateButton('force', 'danger', t('updateForce'), () => actions.startUpdate(true), running || update.blocked)),
          );
        }
      } else if (operation?.state === 'cancelled') {
        section.push(updateNotice('cancelled', { kind: 'error', text: t('updateCancelled') }));
      } else if (operation?.state === 'rolled-back') {
        section.push(updateNotice('rolledBack', { kind: 'error', text: t('updateRolledBack', { version: operation.installedVersion }) }));
      }
      if (update.restart?.phase === 'error') {
        section.push(updateNotice('restartError', { kind: 'error', text: t('restartFailed', { reason: update.restart.reason }) }));
      }
      section.push(updateNotice('updateNotice', update.notice));
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
          const payload = await versionRequest(force ? `${VERSION_PATH}?force=1` : VERSION_PATH);
          setVersion(
            payload.ok
              ? { phase: 'ready', ...payload }
              : { phase: 'error', currentVersion: payload.currentVersion, reason: payload.reason },
          );
        } catch (error) {
          setVersion((previous) => ({ phase: 'error', currentVersion: previous?.currentVersion, reason: errorText(error) }));
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
        } catch (error) {
          setRestart({ phase: 'error', reason: errorText(error) });
        }
      }, [market?.endpoints]);

      return {
        model: { version, market, operation, target, busy, notice, restart },
        actions: {
          checkUpdate: async () => {
            setNotice(undefined);
            await Promise.all([loadVersion(true), market?.phase !== 'ready' ? probeMarket() : undefined]);
          },
          startUpdate,
          restart: restartHost,
        },
      };
    }

    function ModelsCard({ t }) {
      const [view, setView] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [modelBusy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [key, setKey] = useState('');
      const [search, setSearch] = useState('');
      const [expanded, setExpanded] = useState(new Set());
      const [drag, setDrag] = useState(null);
      const dragSource = useRef(null);
      const updater = useUpdater(t);
      const busy = modelBusy || updater.model.busy || isActiveOperation(updater.model.operation);
      useEffect(() => {
        let active = true;
        request().then((value) => { if (active) setView(value); }).catch((error) => { if (active) setNotice({ error: true, text: error.message }); });
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
          catch (error) { if (active) setNotice({ error: true, text: error.message }); }
          finally { fetching = false; }
        }, 1000);
        return () => { active = false; clearInterval(timer); };
      }, [operation?.id, operation?.running]);
      const perform = async (run) => {
        setBusy(true); setNotice(null);
        try { await run(); } catch (error) { setNotice({ error: true, text: error.message }); }
        finally { setBusy(false); }
      };
      const reload = () => perform(async () => { setView(await request()); setDirty(false); setKey(''); setExpanded(new Set()); });
      const button = (text, click, extra = {}) => h('button', { type: 'button', disabled: busy, onClick: click, ...extra }, text);
      if (!view) return h('section', { className: 'dsm-mp' }, h('h3', null, t('title')), notice ? h('p', { className: 'notice error', role: 'alert' }, notice.text) : h('p', null, t('loading')), button(t('reload'), reload));
      const config = view.config;
      const update = (patch) => { setView((v) => ({ ...v, config: { ...v.config, ...patch } })); setDirty(true); };
      const rows = config.models;
      const labelFor = (row) => displayModelName(row, view.providerNames) || t('newModel');
      const updateRow = (index, patch) => update({ models: rows.map((row, i) => i === index ? { ...row, ...patch } : row) });
      const field = (label, value, change, options = {}) => h('label', { className: 'field' }, label, h('input', { value: value ?? '', disabled: busy, onChange: (e) => change(e.target.value), ...options }));
      const backend = view.backend;
      const backendAction = (action) => perform(async () => {
        const result = await request({ action, magpiePath: config.magpiePath || '' });
        // 程序操作不保存或覆盖模型草稿；程序路径仍由原有保存流程持久化。
        setView((old) => ({ ...old, backend: result.backend }));
      });
      const backendPhase = operation ? ({ checking: t('backendChecking'), downloading: t('backendDownloading'), verifying: t('backendVerifying'), installing: t('backendInstalling'),
        installed: t('backendInstalled', { version: operation.version }), updated: t('backendUpdated', { version: operation.version }), 'up-to-date': t('backendUpToDate'), failed: t('backendFailed', { reason: operation.reason }) })[operation.phase] : '';
      const syncCatalog = () => perform(async () => {
        const result = await request({ action: 'sync-catalog', config, revision: view.revision, apiKey: key || undefined });
        setView(result); setDirty(false); setKey(''); setSearch(''); setExpanded(new Set());
        dragSource.current = null; setDrag(null);
        setNotice({ error: !result.sync.ok, text: result.sync.ok ? t('mirrored', { count: result.sync.count }) : t('saveFailed', { reason: result.sync.reason }) });
      });
      const save = () => perform(async () => {
        const result = await request({ action: 'save', config, revision: view.revision, apiKey: key || undefined });
        setView(result); setDirty(false); setKey('');
        setNotice({ error: !result.sync.ok, text: result.sync.ok ? t('saved', { count: result.sync.count }) : t('saveFailed', { reason: result.sync.reason }) });
      });
      const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => `${row.id} ${labelFor(row)}`.toLowerCase().includes(search.toLowerCase()));
      const visibleIndexes = new Set(visible.map(({ index }) => index));
      const selectVisible = (enabled) => update({ models: rows.map((m, i) => visibleIndexes.has(i) ? { ...m, enabled } : m) });
      const reorder = (order) => {
        if (order.every((index, i) => index === i)) return;
        update({ models: order.map((index) => rows[index]) });
        setExpanded((old) => new Set([...old].map((i) => order.indexOf(i))));
      };
      const move = (index, target) => reorder(moveModel(rows.map((_row, i) => i), index, target));
      const sort = (mode) => {
        if (busy || visible.length < 2) return;
        const order = rows.map((_row, i) => i);
        const sorted = sortModelIndexes(visible.map(({ row }) => row), mode, view.providerNames);
        // 只替换匹配条目所在的位置，隐藏模型原位置不动；展开状态跟随同一个模型。
        visible.forEach(({ index }, i) => { order[index] = visible[sorted[i]].index; });
        reorder(order);
        dragSource.current = null; setDrag(null);
      };
      const endDrag = () => { dragSource.current = null; setDrag(null); };
      const dropPosition = (event, index) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return { index, after: event.clientY >= rect.top + rect.height / 2 };
      };
      // 只接受本卡片手柄发起的拖动；外部文本、另一张卡片及已过期的草稿不能触发排序。
      const canDrop = () => !busy && dragSource.current?.rows === rows;
      const drop = (event, index) => {
        if (!canDrop()) return;
        event.preventDefault();
        const source = dragSource.current.index;
        const { after } = dropPosition(event, index);
        const slot = index + Number(after);
        move(source, slot > source ? slot - 1 : slot);
        endDrag();
      };
      const remove = (index) => {
        update({ models: rows.filter((_m, i) => i !== index) });
        setExpanded((old) => new Set([...old].filter((i) => i !== index).map((i) => i > index ? i - 1 : i)));
      };
      return h('section', { className: 'dsm-mp', 'aria-busy': busy },
        h('div', { className: 'bar spread' }, h('h3', null, t('title')), h('span', { className: 'muted' }, t(dirty ? 'unsaved' : 'savedState'))),
        h('p', { className: 'muted' }, t('description')),
        view.nativeProviders.length ? h('p', { className: 'notice' }, t('native')) : null,
        h('details', { className: 'section backend' }, h('summary', null, t('backendTitle'), ' · ', backend?.version || t(backend?.installed ? 'backendUnknown' : 'backendMissing')),
          h('div', { className: 'fields' }, field(t('backendPath'), config.magpiePath, (magpiePath) => {
            update({ magpiePath }); setView((old) => ({ ...old, backend: { ...old.backend, installed: false, version: null, reason: null } }));
          }, { placeholder: backend?.defaultPath || t('backendDefault'), disabled: busy || operation?.running })),
          h('p', { className: 'muted' }, t('backendPathHint')),
          backend?.path ? h('p', { className: 'muted backend-path' }, backend.path) : null,
          h('div', { className: 'bar' },
            button(t('backendCheck'), () => backendAction('backend-check'), { disabled: busy || operation?.running || backend?.supported === false }),
            button(t(backend?.installed ? 'backendUpgrade' : 'backendDownload'), () => backendAction('backend-install'), { disabled: busy || operation?.running || backend?.supported === false || (backend?.installed && (!backend.version || (backend.latest && !backend.updateAvailable))) }),
            backend?.version ? h('span', { className: 'muted' }, t('backendCurrent', { version: backend.version })) : null,
            backend?.latest ? h('span', { className: 'muted' }, t('backendLatest', { version: backend.latest.version })) : null),
          backend?.reason ? h('p', { className: 'error', role: 'alert' }, backend.reason) : null,
          backendPhase ? h('p', { className: operation.phase === 'failed' ? 'error' : 'muted', role: operation.phase === 'failed' ? 'alert' : 'status' }, backendPhase) : null,
          operation?.running ? h('progress', { value: operation.received, max: operation.total || 1, 'aria-label': t('backendDownloading') }) : null,
          operation?.running && operation.total ? h('p', { className: 'muted' }, t('backendProgress', { received: (operation.received / 1048576).toFixed(1), total: (operation.total / 1048576).toFixed(1) })) : null),
        h('details', { className: 'section' }, h('summary', null, t('connection')),
          h('div', { className: 'fields' },
            field(t('url'), config.baseURL, (baseURL) => update({ baseURL }), { type: 'url', placeholder: 'http://127.0.0.1:3425' }),
            h('label', { className: 'field' }, t('protocol'), h('select', { value: config.api, disabled: busy, onChange: (e) => update({ api: e.target.value }) },
              ...[['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']].map(([value, label]) => h('option', { key: value, value }, label)))),
            field(t('key'), key, (value) => { setKey(value); setDirty(true); }, { type: 'password', autoComplete: 'new-password', disabled: busy || !view.keyWritable, placeholder: t(view.keyConfigured ? 'keySaved' : 'keyEmpty') })),
          h('p', { className: 'muted' }, t(view.keyWritable ? 'keyHint' : 'keyReadonly')),
          button(t('check'), () => perform(async () => { const result = await request({ action: 'check', baseURL: config.baseURL, apiKey: key || undefined }); setNotice({ text: t('connected', { version: result.version }) }); }))),
        h('div', { className: 'section' }, h('label', null, h('input', { type: 'checkbox', checked: config.syncEnabled, disabled: busy, onChange: (e) => update({ syncEnabled: e.target.checked }) }), ' ', t('sync')), h('p', { className: 'muted' }, t('syncHint'))),
        h('div', { className: 'bar spread section' }, h('strong', null, t('count', { selected: rows.filter((m) => m.enabled).length, total: rows.length })), h('div', { className: 'bar' },
          button(t('add'), () => { update({ models: [...rows, { id: '', name: '', enabled: true, input: ['text'], reasoningEfforts: [] }] }); setExpanded((old) => new Set([...old, rows.length])); }), button(t('catalog'), syncCatalog, { disabled: busy || !view.editable }))),
        h('div', { className: 'bar section' }, h('input', { className: 'search', type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: search, onChange: (e) => setSearch(e.target.value) }),
          h('div', { className: 'bar' }, button(t('sortModel'), () => sort('model'), { title: t('sortModelHint'), disabled: busy || visible.length < 2 }), button(t('sortProvider'), () => sort('provider'), { title: t('sortProviderHint'), disabled: busy || visible.length < 2 })),
          h('div', { className: 'bar' }, button(t('all'), () => selectVisible(true)), button(t('none'), () => selectVisible(false)))),
        !rows.length ? h('p', { className: 'notice section' }, t('empty')) : !visible.length ? h('p', null, t('noMatch')) : null,
        h('div', { className: 'model-list' }, ...visible.map(({ row, index }) => h('div', {
          className: `model${expanded.has(index) ? ' expanded' : ''}${drag?.source === index ? ' dragging' : ''}${drag?.index === index ? (drag.after ? ' drop-after' : ' drop-before') : ''}`, key: index,
          onDragOver: (event) => { if (!canDrop()) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrag({ source: dragSource.current.index, ...dropPosition(event, index) }); },
          onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDrag((old) => old ? { source: old.source } : null); },
          onDrop: (event) => drop(event, index),
        },
          h('div', { className: 'model-header' },
            button(h('svg', { viewBox: '0 0 16 20', fill: 'currentColor', 'aria-hidden': true }, ...[5, 10, 15].flatMap((cy) => [5, 11].map((cx) => h('circle', { key: `${cx}-${cy}`, cx, cy, r: 1.4 })))), undefined, {
              className: 'model-drag', draggable: !busy && rows.length > 1, disabled: busy || rows.length < 2,
              title: t('drag', { name: labelFor(row) }), 'aria-label': t('drag', { name: labelFor(row) }),
              onDragStart: (event) => {
                if (busy || rows.length < 2) { event.preventDefault(); return; }
                dragSource.current = { index, rows }; setDrag({ source: index });
                event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.id);
                event.dataTransfer.setDragImage?.(event.currentTarget.parentElement, 20, 20);
              }, onDragEnd: endDrag,
            }),
            h('label', { className: 'model-select', title: row.id }, h('input', { type: 'checkbox', checked: row.enabled, disabled: busy, onChange: (e) => updateRow(index, { enabled: e.target.checked }) }), h('span', { className: 'model-name' }, labelFor(row))),
            button(h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }, h('path', { d: 'm6 3 5 5-5 5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })), () => setExpanded((old) => { const next = new Set(old); if (next.has(index)) next.delete(index); else next.add(index); return next; }), { className: 'model-toggle', 'aria-expanded': expanded.has(index), 'aria-controls': `dsm-mp-details-${index}`, 'aria-label': t(expanded.has(index) ? 'collapse' : 'expand', { name: labelFor(row) }) }),
            h('div', { className: 'model-badges' }, row.input.includes('image') ? h('span', { className: 'badge' }, t('vision')) : null, row.contextWindow ? h('span', { className: 'badge' }, formatTokens(row.contextWindow)) : null),
            h('div', { className: 'model-actions' }, button(t('remove'), () => remove(index), { className: 'danger' }))),
          h('div', { className: 'model-details', id: `dsm-mp-details-${index}`, hidden: !expanded.has(index) },
          h('div', { className: 'fields' }, field(t('id'), row.id, (id) => updateRow(index, { id }), { placeholder: 'provider/model-id', spellCheck: false }), field(t('modelName'), row.name, (name) => updateRow(index, { name }), { placeholder: t('nameHint') })),
          h('div', { className: 'fields' },
            field(t('context'), row.contextWindow, (contextWindow) => updateRow(index, { contextWindow }), { type: 'number', min: 1, placeholder: t('unspecified') }),
            field(t('output'), row.maxTokens, (maxTokens) => updateRow(index, { maxTokens }), { type: 'number', min: 1, placeholder: t('unspecified') }),
            field(t('efforts'), row.effortText ?? row.reasoningEfforts.join(', '), (value) => updateRow(index, { effortText: value, reasoningEfforts: value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }), { placeholder: t('effortHint') }),
            h('label', null, h('input', { type: 'checkbox', disabled: busy, checked: row.input.includes('image'), onChange: (e) => updateRow(index, { input: e.target.checked ? ['text', 'image'] : ['text'] }) }), t('vision'))))))),
        notice ? h('p', { className: `notice section${notice.error ? ' error' : ''}`, role: notice.error ? 'alert' : 'status' }, notice.text) : null,
        !view.editable ? h('p', { className: 'error' }, t('readOnly')) : null,
        h('div', { className: 'bar foot spread' }, button(t(dirty ? 'discard' : 'reload'), reload), button(t(busy ? 'saving' : 'save'), save, { className: 'primary', disabled: busy || !view.editable })),
        h('section', { className: 'plugin-update', 'aria-label': t('updateTitle') }, renderUpdateSection({ ...updater.model,
          blocked: dirty || modelBusy || operation?.running,
          blockedHint: dirty ? t('updateSaveFirst') : t('updateWait'),
        }, updater.actions, t)),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-magpie: locale');
      const t = ctx.locale.bind(namespace);
      let tag = document.querySelector('style[data-plugin-css="dsh-magpie"]');
      if (!tag) { tag = document.createElement('style'); tag.dataset.pluginCss = 'dsh-magpie'; document.head.appendChild(tag); }
      tag.textContent = CSS;
      for (const [slot, key] of [['plugins.bundle.config', '@zhiqiangme/dsh-magpie'], ['plugins.row.config', '@zhiqiangme/dsh-magpie#dsh-magpie']]) {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: 30, locale: namespace, inject: () => ({ t }) }, ModelsCard));
      }
    }
    return { name: 'dsh-magpie-client', inject: ['slots', 'locale'], apply, ModelsCard, moveModel, displayModelName, sortModelIndexes, renderUpdateSection, zh, en };
  },
});
