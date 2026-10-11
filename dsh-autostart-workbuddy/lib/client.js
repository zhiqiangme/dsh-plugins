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
 * 样式：全部自带（data-plugin-css 标记，避免重复注入），类名统一 `dsm-wb-*`，
 * 颜色只取 `--dsw-alias-*` 令牌，跟随主题。刻意不借用其它插件注入的类名
 * （Trae/Qoder 的 `dsm-btn` / `dsm-plugin-card` 是它们自己的 CSS，不是宿主全局类）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-autostart-workbuddy',
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

    /** 后端动作 → 成功后的提示文案 key。 */
    const BACKEND_NOTICE = {
      install: 'backendInstalled',
      update: 'backendUpdated',
      rollback: 'backendRolledBack',
      uninstall: 'backendUninstalled',
    };

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
.dsm-wb-path{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;word-break:break-all}
.dsm-wb-backend{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-wb-backend-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
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
      retry: '重试',
      selectAll: '全部勾选',
      clearAll: '全部取消',
      refresh: '刷新',
      save: '保存',
      saving: '保存中…',
      count: '后端共 {total} 个模型，已勾选 {picked} 个',
      vision: '视觉',
      emptyBackend: '后端没有返回任何模型。',
      emptyHint: '一个都没勾 = 同步后端全部模型（白名单留空的既有语义）。',
      disabledHint: 'profile 里 models.enabled 不是 true：保存只改白名单，不会重新生成模型清单。',
      savedSync: '已保存，并已重新生成模型清单：{count} 个模型。',
      savedNoSync: '已保存白名单；模型清单未更新（{state}）。',
      saveFailed: '保存失败。',
      patchPath: '写入目标：{path}',
      panelHint: '后端面板：',
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
      backendUninstalled: '后端已卸载（config.json 与 data/ 已保留）。',
      cancel: '取消',
      uninstallTitle: '卸载后端？',
      uninstallDesc: '会停止后端，并删除程序文件：wb2api.exe、历史版本、下载缓存。',
      uninstallKept: '账号凭证与状态（data/）以及 config.json 会保留。',
      uninstallConfirm: '确认卸载',
    };

    const en = {
      title: 'WorkBuddy models',
      description: 'Tick the models that should appear in the DSH model list; the multiplier comes from the backend /v1/models.',
      summary: 'This plugin manages the WorkBuddy model list (selection + multiplier).',
      loading: 'Reading models from the backend…',
      retry: 'Retry',
      selectAll: 'Select all',
      clearAll: 'Clear all',
      refresh: 'Refresh',
      save: 'Save',
      saving: 'Saving…',
      count: '{total} models on the backend, {picked} selected',
      vision: 'vision',
      emptyBackend: 'The backend returned no models.',
      emptyHint: 'Selecting nothing means “sync every backend model” (the existing meaning of an empty allow-list).',
      disabledHint: 'profile has models.enabled !== true: saving only rewrites the allow-list, it will not regenerate the model list.',
      savedSync: 'Saved and regenerated the model list: {count} models.',
      savedNoSync: 'Allow-list saved; the model list was not updated ({state}).',
      saveFailed: 'Save failed.',
      patchPath: 'Written to: {path}',
      panelHint: 'Panel: ',
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
      backendUninstalled: 'Backend uninstalled (config.json and data/ kept).',
      cancel: 'Cancel',
      uninstallTitle: 'Uninstall the backend?',
      uninstallDesc: 'Stops the backend and deletes its program files: wb2api.exe, archived versions, download cache.',
      uninstallKept: 'Credentials and state (data/) plus config.json are kept.',
      uninstallConfirm: 'Uninstall',
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
     * 卸载的二次确认。优先用宿主的 Modal（真弹窗，走 portal）；拿不到宿主组件就退回
     * 卡片内的行内确认——两种形态都保证"再点一次才真的删"。
     */
    function renderUninstallConfirm({ t, Modal, h, onCancel, onConfirm }) {
      const cancel = h(
        'button',
        { key: 'cancel', type: 'button', className: 'dsm-wb-btn dsm-wb-btn-outline', onClick: onCancel },
        t('cancel'),
      );
      const confirm = h(
        'button',
        { key: 'confirm', type: 'button', className: 'dsm-wb-btn dsm-wb-btn-danger', onClick: onConfirm },
        t('uninstallConfirm'),
      );
      const detail = h(
        'div',
        { className: 'dsm-wb-confirm-body' },
        h('p', { className: 'dsm-wb-hint' }, t('uninstallDesc')),
        h('p', { className: 'dsm-wb-hint' }, t('uninstallKept')),
      );

      if (typeof Modal === 'function') {
        return h(
          Modal,
          {
            key: 'confirm',
            open: true,
            onClose: onCancel,
            title: t('uninstallTitle'),
            description: t('uninstallDesc'),
            footer: [cancel, confirm],
          },
          detail,
        );
      }
      return h(
        'div',
        { key: 'confirm', className: 'dsm-wb-confirm' },
        h('div', { className: 'dsm-wb-confirm-title' }, t('uninstallTitle')),
        detail,
        h('div', { className: 'dsm-wb-toolbar' }, cancel, confirm),
      );
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

      const load = useCallback(async () => {
        setPhase('loading');
        setNotice(undefined);
        try {
          const payload = await request(MODELS_PATH, 'GET');
          if (!payload.ok) {
            setRows([]);
            setPicked(new Set());
            setSavedPicked(new Set());
            setMeta({ enabled: payload.enabled, patchPath: payload.patchPath });
            setReason(payload.reason ?? '');
            setPhase('error');
            return;
          }
          const list = payload.models ?? [];
          const selected = new Set(list.filter((row) => row.selected).map((row) => row.id));
          setRows(list);
          setMeta({ enabled: payload.enabled, patchPath: payload.patchPath, url: payload.url });
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

      const sorted = useMemo(() => {
        return rows
          .map((row, index) => ({ row, index }))
          .sort((a, b) => regionRank(a.row.id) - regionRank(b.row.id) || a.index - b.index)
          .map((entry) => entry.row);
      }, [rows]);

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
          const payload = await request(MODELS_PATH, 'POST', { only: [...picked] });
          if (!payload.ok) {
            setNotice({ kind: 'error', text: payload.reason ?? t('saveFailed') });
            return;
          }
          const sync = payload.sync ?? {};
          // 先重载再出提示：load() 开头会清空 notice，反过来写会把结果（尤其是同步失败的原因）立刻抹掉。
          await load();
          if (sync.state === 'updated' || sync.state === 'unchanged') {
            setNotice({ kind: 'ok', text: t('savedSync', { count: sync.count ?? 0 }) });
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
      }, [picked, load, t]);

      // ---- 后端版本（更新检查 / 安装 / 更新 / 卸载 / 回滚）----
      const [backend, setBackend] = useState(undefined);
      const [check, setCheck] = useState(undefined);
      const [backendBusy, setBackendBusy] = useState(undefined);
      const [backendNotice, setBackendNotice] = useState(undefined);
      /** 卸载的二次确认弹窗是否打开。 */
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
              setBackendNotice({
                kind: 'ok',
                text: t(BACKEND_NOTICE[action] ?? 'backendUpdated', {
                  tag: payload.latest?.tag ?? payload.local?.tag ?? '',
                }),
              });
            } else {
              setBackendNotice({ kind: 'error', text: payload.reason ?? payload.state ?? '' });
            }
          } catch (error) {
            setBackendNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
          } finally {
            setBackendBusy(undefined);
          }
        },
        [t],
      );

      // 行详情页在缺少包描述时才用 summary 视图；本包有 description，正常走 page。
      if (view === 'summary') {
        return h('p', { className: 'dsm-wb-desc' }, t('summary'));
      }

      const dirty = !sameSet(picked, savedPicked);
      const body = [];

      if (phase === 'loading') {
        body.push(h('div', { key: 'loading', className: 'dsm-wb-empty' }, t('loading')));
      } else if (phase === 'error') {
        body.push(
          h(
            'div',
            { key: 'error', className: 'dsm-wb-empty' },
            h('div', { className: 'dsm-wb-notice dsm-wb-notice-error' }, reason),
            h('button', { type: 'button', className: 'dsm-wb-btn dsm-wb-btn-outline', onClick: load }, t('retry')),
          ),
        );
      } else {
        body.push(
          h(
            'div',
            { key: 'toolbar', className: 'dsm-wb-toolbar' },
            h('span', { className: 'dsm-wb-count' }, t('count', { total: sorted.length, picked: picked.size })),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-wb-btn dsm-wb-btn-outline',
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
                className: 'dsm-wb-btn dsm-wb-btn-outline',
                onClick: () => {
                  setPicked(new Set());
                  setNotice(undefined);
                },
              },
              t('clearAll'),
            ),
            h('button', { type: 'button', className: 'dsm-wb-btn dsm-wb-btn-outline', onClick: load }, t('refresh')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-wb-btn dsm-wb-btn-primary',
                disabled: saving || !dirty,
                onClick: save,
              },
              saving ? t('saving') : t('save'),
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

        if (meta.enabled === false) {
          body.push(h('p', { key: 'disabled', className: 'dsm-wb-hint' }, t('disabledHint')));
        }
        if (picked.size === 0 && sorted.length > 0) {
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

        const section = [
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
            // 顺序按使用频率排：更新 → 回滚 → 卸载（卸载放最后，离"检查更新"最远，减少误点）。
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
                    onClick: () => setConfirming(true),
                  },
                  t('backendUninstall'),
                )
              : null,
          ),
          h(
            'p',
            { key: 'current', className: 'dsm-wb-backend-line' },
            h('strong', null, t('backendCurrent', { version: currentTag })),
            version.builtAt ? ` · ${t('backendBuilt', { time: version.builtAt })}` : '',
          ),
        ];

        if (confirming) {
          section.push(renderUninstallConfirm({ t, Modal, h, onCancel: () => setConfirming(false), onConfirm: () => { setConfirming(false); runBackend('uninstall', { confirm: true }); } }));
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
        ),
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

      registerCard('plugins.bundle.config', 'dsh-autostart-workbuddy');
      registerCard('plugins.row.config', 'dsh-autostart-workbuddy#dsh-autostart-workbuddy');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
