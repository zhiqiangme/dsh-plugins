/* DSH 自带 React 与模块加载器；与仓库其它插件一致，不引入单独构建链。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-magpie',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
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
    };
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
    // 简称由服务端统一提供；本地派生名称让编辑 ID / 名称时立即预览，不改写手工输入。
    function displayModelName(row, providers = {}) {
      const name = row.name || row.id || '';
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
        return { index, name, supplier };
      });
      return keys.sort((a, b) => mode === 'provider'
        ? compare(a.supplier, b.supplier) || compare(a.name, b.name) || a.index - b.index
        : compare(a.name, b.name) || compare(a.supplier, b.supplier) || a.index - b.index).map(({ index }) => index);
    }

    function ModelsCard({ t }) {
      const [view, setView] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [key, setKey] = useState('');
      const [search, setSearch] = useState('');
      const [expanded, setExpanded] = useState(new Set());
      const [drag, setDrag] = useState(null);
      const dragSource = useRef(null);
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
    return { name: 'dsh-magpie-client', inject: ['slots', 'locale'], apply, ModelsCard, moveModel, displayModelName, sortModelIndexes, zh, en };
  },
});
