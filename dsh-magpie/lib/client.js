/* DSH 自带 React 与模块加载器；与仓库其它插件一致，不引入单独构建链。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-magpie',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;
    const namespace = 'settings.dsh-magpie';
    const path = '/plugins/dsh-magpie/models';
    const zh = {
      title: 'Magpie 模型管理', description: '清单由此插件独立保存。可以手动添加，也可以从 Magpie 导入后编辑。',
      loading: '正在读取配置…', reload: '重新载入', discard: '放弃更改并重新载入', connection: '连接设置',
      url: 'Magpie 网关地址', protocol: 'API 协议', key: '网关 Key', keyHint: '本机可留空；远程网关需要有效 Key。已保存时留空表示沿用。',
      keySaved: '已保存 Key', keyEmpty: '使用本机标识', keyReadonly: 'Key 由环境变量提供，只读',
      check: '检查连接', connected: '已连接 Magpie {version}', import: '从 Magpie 导入',
      imported: '新增 {count} 个模型，已存在的条目保持原样；请勾选后保存。',
      sync: '同步所选模型到 DSH', syncHint: '关闭同步或取消全部勾选，保存后移除“Magpie · DSH”分组。',
      native: '当前还有 Magpie 原生分组。这里保存到独立的“Magpie · DSH”分组，原分组仍可使用。',
      count: '{selected} / {total} 个模型已勾选', search: '搜索名称或 ID', add: '手动添加模型',
      all: '全选', none: '取消全选', empty: '清单为空。添加模型，或从正在运行的 Magpie 导入。',
      noMatch: '没有匹配的模型。', id: '完整模型 ID', modelName: '显示名称', nameHint: '留空使用模型 ID',
      selected: '同步此模型', up: '上移', down: '下移', remove: '删除', details: '能力与参数',
      expand: '展开 {name} 的详细配置', collapse: '收起 {name} 的详细配置', newModel: '新模型',
      context: '上下文窗口', output: '最大输出 token', vision: '支持图片输入', efforts: '思考档位（逗号分隔）',
      effortHint: '留空表示不声明思考档位', unspecified: '不指定', save: '保存并同步', saving: '处理中…',
      saved: '已保存，DSH 分组现有 {count} 个模型。', saveFailed: '清单已保存，同步未完成：{reason}',
      readOnly: '宿主配置服务尚未就绪，暂时无法保存。', unsaved: '有未保存的更改', savedState: '已保存',
      invalidJson: '服务返回了无效响应',
    };
    const en = {
      title: 'Magpie models', description: 'This plugin keeps its own list. Add models manually or import a snapshot from Magpie and edit it.',
      loading: 'Loading configuration…', reload: 'Reload', discard: 'Discard edits and reload', connection: 'Connection',
      url: 'Magpie gateway URL', protocol: 'API protocol', key: 'Gateway key', keyHint: 'Optional on this machine; required for a remote gateway. Leave blank to keep the saved key.',
      keySaved: 'Key saved', keyEmpty: 'Using local identity', keyReadonly: 'The environment supplies a read-only key',
      check: 'Check connection', connected: 'Connected to Magpie {version}', import: 'Import from Magpie',
      imported: 'Added {count} models. Existing entries were kept. Select models and save.',
      sync: 'Sync selected models to DSH', syncHint: 'Turning sync off or deselecting all models removes the “Magpie · DSH” group when saved.',
      native: 'Magpie native groups are also configured. This list uses its own “Magpie · DSH” group; existing groups remain available.',
      count: '{selected} / {total} models selected', search: 'Search names or IDs', add: 'Add a model',
      all: 'Select all', none: 'Deselect all', empty: 'The list is empty. Add models or import from a running Magpie.',
      noMatch: 'No matching models.', id: 'Full model ID', modelName: 'Display name', nameHint: 'Defaults to model ID',
      selected: 'Sync this model', up: 'Move up', down: 'Move down', remove: 'Delete', details: 'Capabilities and limits',
      expand: 'Expand details for {name}', collapse: 'Collapse details for {name}', newModel: 'New model',
      context: 'Context window', output: 'Max output tokens', vision: 'Image input', efforts: 'Reasoning levels (comma-separated)',
      effortHint: 'Leave blank to declare no reasoning levels', unspecified: 'Unspecified', save: 'Save and sync', saving: 'Working…',
      saved: 'Saved. The DSH group now has {count} models.', saveFailed: 'List saved; sync incomplete: {reason}',
      readOnly: 'Host configuration services are not ready. Saving is unavailable.', unsaved: 'Unsaved edits', savedState: 'Saved',
      invalidJson: 'The server returned an invalid response',
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
      .dsm-mp .model-toggle{padding:4px 6px;line-height:1;border-color:transparent;background:transparent;flex:none}.dsm-mp .model-toggle svg{display:block;width:16px;height:16px;transition:transform .15s}.dsm-mp .model-toggle[aria-expanded=true] svg{transform:rotate(90deg)}.dsm-mp .model-badges{display:flex;gap:6px;margin-left:auto;flex:none}.dsm-mp .badge{padding:0 5px;border:1px solid var(--dsw-alias-border-l2,#dce1eb);border-radius:4px;color:var(--dsw-alias-label-secondary,#657084);font-size:12px;white-space:nowrap}
      .dsm-mp .model-actions{display:flex;gap:4px;flex:none;margin-left:auto}.dsm-mp .model-badges+.model-actions{margin-left:4px}.dsm-mp .model-actions button{padding:3px 7px;background:transparent}.dsm-mp .model-details{padding:0 12px 12px;min-width:0}.dsm-mp .model-details[hidden]{display:none}
      .dsm-mp summary{cursor:pointer}.dsm-mp details>summary{color:var(--dsw-alias-label-secondary,#657084)}.dsm-mp .notice{padding:10px 12px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#f2f5fb);overflow-wrap:anywhere}.dsm-mp .error{color:var(--dsw-alias-state-error-primary,#b93645)}
      .dsm-mp .search{flex:1;min-width:160px}.dsm-mp .foot{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#dce1eb)}
      @media(max-width:600px){.dsm-mp{padding:14px}.dsm-mp .fields{grid-template-columns:minmax(0,1fr)}.dsm-mp .search{flex-basis:100%}.dsm-mp .model-badges{display:none}.dsm-mp .model-select{flex:1}.dsm-mp .model-actions{margin-left:auto}}
    `;

    async function request(body) {
      const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      const value = await res.json();
      if (!res.ok || !value.ok) throw new Error(value.reason || `HTTP ${res.status}`);
      return value;
    }
    // 只补充新 ID；已编辑的名称、能力、勾选和顺序都以插件自己的清单为准。
    function mergeCatalog(current, imported) {
      const seen = new Set(current.map((m) => m.id));
      return [...current, ...imported.filter((m) => !seen.has(m.id) && seen.add(m.id))];
    }
    function moveModel(rows, index, delta) {
      const next = [...rows], target = index + delta;
      if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
      return next;
    }
    function formatTokens(value) {
      if (!value) return '';
      if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
      if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
      return String(value);
    }

    function ModelsCard({ t }) {
      const [view, setView] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [key, setKey] = useState('');
      const [search, setSearch] = useState('');
      const [expanded, setExpanded] = useState(new Set());
      useEffect(() => {
        let active = true;
        request().then((value) => { if (active) setView(value); }).catch((error) => { if (active) setNotice({ error: true, text: error.message }); });
        return () => { active = false; };
      }, []);
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
      const updateRow = (index, patch) => update({ models: rows.map((row, i) => i === index ? { ...row, ...patch } : row) });
      const field = (label, value, change, options = {}) => h('label', { className: 'field' }, label, h('input', { value: value ?? '', disabled: busy, onChange: (e) => change(e.target.value), ...options }));
      const importCatalog = () => perform(async () => {
        const result = await request({ action: 'import', baseURL: config.baseURL, apiKey: key || undefined });
        const models = mergeCatalog(rows, result.models);
        update({ models });
        setNotice({ text: t('imported', { count: models.length - rows.length }) });
      });
      const save = () => perform(async () => {
        const result = await request({ action: 'save', config, revision: view.revision, apiKey: key || undefined });
        setView(result); setDirty(false); setKey('');
        setNotice({ error: !result.sync.ok, text: result.sync.ok ? t('saved', { count: result.sync.count }) : t('saveFailed', { reason: result.sync.reason }) });
      });
      const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => `${row.id} ${row.name}`.toLowerCase().includes(search.toLowerCase()));
      const visibleIndexes = new Set(visible.map(({ index }) => index));
      const selectVisible = (enabled) => update({ models: rows.map((m, i) => visibleIndexes.has(i) ? { ...m, enabled } : m) });
      const move = (index, delta) => {
        update({ models: moveModel(rows, index, delta) });
        setExpanded((old) => new Set([...old].map((i) => i === index ? index + delta : i === index + delta ? index : i)));
      };
      const remove = (index) => {
        update({ models: rows.filter((_m, i) => i !== index) });
        setExpanded((old) => new Set([...old].filter((i) => i !== index).map((i) => i > index ? i - 1 : i)));
      };
      return h('section', { className: 'dsm-mp', 'aria-busy': busy },
        h('div', { className: 'bar spread' }, h('h3', null, t('title')), h('span', { className: 'muted' }, t(dirty ? 'unsaved' : 'savedState'))),
        h('p', { className: 'muted' }, t('description')),
        view.nativeProviders.length ? h('p', { className: 'notice' }, t('native')) : null,
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
          button(t('add'), () => { update({ models: [...rows, { id: '', name: '', enabled: true, input: ['text'], reasoningEfforts: [] }] }); setExpanded((old) => new Set([...old, rows.length])); }), button(t('import'), importCatalog))),
        h('div', { className: 'bar section' }, h('input', { className: 'search', type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: search, onChange: (e) => setSearch(e.target.value) }),
          button(t('all'), () => selectVisible(true)), button(t('none'), () => selectVisible(false))),
        !rows.length ? h('p', { className: 'notice section' }, t('empty')) : !visible.length ? h('p', null, t('noMatch')) : null,
        h('div', { className: 'model-list' }, ...visible.map(({ row, index }) => h('div', { className: `model${expanded.has(index) ? ' expanded' : ''}`, key: index },
          h('div', { className: 'model-header' },
            h('label', { className: 'model-select', title: row.id }, h('input', { type: 'checkbox', checked: row.enabled, disabled: busy, onChange: (e) => updateRow(index, { enabled: e.target.checked }) }), h('span', { className: 'model-name' }, row.name || row.id || t('newModel'))),
            button(h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }, h('path', { d: 'm6 3 5 5-5 5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })), () => setExpanded((old) => { const next = new Set(old); if (next.has(index)) next.delete(index); else next.add(index); return next; }), { className: 'model-toggle', 'aria-expanded': expanded.has(index), 'aria-controls': `dsm-mp-details-${index}`, 'aria-label': t(expanded.has(index) ? 'collapse' : 'expand', { name: row.name || row.id || t('newModel') }) }),
            h('div', { className: 'model-badges' }, row.input.includes('image') ? h('span', { className: 'badge' }, t('vision')) : null, row.contextWindow ? h('span', { className: 'badge' }, formatTokens(row.contextWindow)) : null),
            h('div', { className: 'model-actions' }, button('↑', () => move(index, -1), { 'aria-label': t('up'), title: t('up'), disabled: busy || index === 0 }),
              button('↓', () => move(index, 1), { 'aria-label': t('down'), title: t('down'), disabled: busy || index === rows.length - 1 }),
              button(t('remove'), () => remove(index), { className: 'danger' }))),
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
    return { name: 'dsh-magpie-client', inject: ['slots', 'locale'], apply, ModelsCard, mergeCatalog, moveModel, zh, en };
  },
});
