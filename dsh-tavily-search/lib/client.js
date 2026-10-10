/**
 * 浏览器半侧：DSH「插件」页里的 Tavily 联网搜索卡片。
 *
 * 为什么手写而不是过打包器：本插件是 file: 挂载的私有包，仓库里没有构建链。
 * DSH 的客户端模块加载器只要求这个文件按 `__ModuleLoader__.load({ id, factory })`
 * 注册一个 Cordis 插件（导出 name / inject / apply），React 与宿主组件由 factory 的 require 提供
 * （都在平台的 seed 模块表里），所以直接写一份可读的 JS 即可，改完不用构建。
 *
 * 卡片挂在哪（与 dsh-autostart-workbuddy 同款）：
 *   - `plugins.bundle.config`：key = npm 包名，显示在组合包页面的描述与组件列表之间；
 *   - `plugins.row.config`：key = `<包名>#<行 id>`，给本插件那一行一个"配置"入口。
 * key 必须逐字等于包名，写错不会报错——只是卡片不出现。
 *
 * 三块内容，各走 DSH 既有的通道，本插件不自建存储：
 *   1. API Key —— `remote.credentials`（DSH 凭据库，与内置「网页搜索」页同一条路）。
 *      值只往宿主写、从不读回，卡片只知道"有没有配置、能不能改"；
 *   2. 搜索接口状态与测试 —— 宿主半侧（lib/web.js）的两条 loopback 路由；
 *   3. 网页搜索接入 —— `configForms.get('web-search-deepseek')`，即内置网页搜索页编辑的同一个
 *      设置命名空间：一键把它的接口地址改成本插件的端点，或恢复默认。
 *
 * 样式：全部自带（data-plugin-css 标记，避免重复注入），类名统一 `dsm-tv-*`，
 * 颜色只取 `--dsw-alias-*` 令牌，跟随主题。密钥输入框优先用宿主的 SettingsSecretField，
 * 与内置网页搜索页长得一样；拿不到宿主组件时退回自带的同款输入框。
 */

window.__ModuleLoader__.load({
  id: 'dsh-tavily-search',
  factory: (require) => {
    // ModuleLoader 的 factory 只注入 require；这里自行建立 CommonJS 导出对象，
    // 与 DSH 其它客户端 bundle 的包装约定一致。
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** 宿主 UI 组件是可选依赖：拿不到就用自带的退路，不能让整块卡片加载失败。 */
    let primitives;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = undefined;
    }

    const name = 'dsh-tavily-search-client';
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'];
    const namespace = 'settings.dsh-tavily-search';
    /** 与 lib/web.js 的两个端点必须一致。 */
    const STATUS_PATH = '/plugins/dsh-tavily-search/status';
    const TEST_PATH = '/plugins/dsh-tavily-search/test';
    /** 宿主状态拿不到时的兜底值（与 lib/config.js 的默认一致）。 */
    const DEFAULT_REF = 'TAVILY_API_KEY';
    const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/v1';
    /**
     * 内置搜索提供方的设置命名空间与它的默认凭据引用。写在这里而不是 import：
     * 客户端包不能依赖宿主包（与 dsh-client-ui-settings-web-search 的做法一致）。
     */
    const WEB_SEARCH_NS = 'web-search-deepseek';
    const WEB_SEARCH_DEFAULT_REF = 'DEEPSEEK_API_KEY';
    /** Tavily 控制台：申请 / 查看 key。外链交给宿主用默认浏览器打开。 */
    const TAVILY_CONSOLE_URL = 'https://app.tavily.com/home';

    /** 搜索接口状态 → 徽标配色与文案 key。 */
    const SERVER_BADGE = {
      listening: ['ok', 'serverListening'],
      external: ['warn', 'serverExternal'],
      conflict: ['error', 'serverConflict'],
      failed: ['error', 'serverFailed'],
      starting: ['quiet', 'serverStarting'],
      stopped: ['quiet', 'serverStopped'],
      disabled: ['quiet', 'serverDisabled'],
    };

    const CSS = `
.dsm-tv-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;padding:14px 16px}
.dsm-tv-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-tv-desc{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-tv-section{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-tv-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-tv-section-title{flex:1;min-width:100px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:1.5}
.dsm-tv-line{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6;word-break:break-all}
.dsm-tv-line strong{color:var(--dsw-alias-label-secondary,#c6c9d0);font-weight:500}
.dsm-tv-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-tv-hint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
.dsm-tv-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px}
.dsm-tv-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-tv-btn:disabled{cursor:default}
/* 主按钮用"反色"：brand-primary 在深色主题下接近纯白，拿它当底再配白字就看不见字
   （dsh-autostart-workbuddy 踩过这个坑）。label-primary 当底 + bg-layer-3 当字，明暗主题都成立。 */
.dsm-tv-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-tv-btn-primary:hover:not(:disabled){opacity:.88}
.dsm-tv-btn-outline{background:transparent;border-color:var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-tv-btn-outline:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 禁用态给明确的弱化配色，而不是整体降透明度（会把字一起洗掉）。 */
.dsm-tv-btn-primary:disabled{background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-dimmed,#8a8f99);border-color:var(--dsw-alias-border-l2,#36373b)}
.dsm-tv-btn-outline:disabled{color:var(--dsw-alias-label-dimmed,#8a8f99)}
.dsm-tv-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-tv-btn-danger:hover:not(:disabled){background:rgba(217,45,32,.12)}
.dsm-tv-badge{flex:none;border-radius:6px;padding:1px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-tv-badge-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.dsm-tv-badge-warn{color:var(--dsw-alias-state-warning-primary,#d29922);border-color:currentColor}
.dsm-tv-badge-error{color:var(--dsw-alias-state-error-primary,#d92d20);border-color:currentColor}
.dsm-tv-notice{margin:8px 0 0;font-size:13px;line-height:1.6;word-break:break-all}
.dsm-tv-notice-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dsm-tv-notice-error{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-tv-confirm{margin-top:10px;border:1px solid var(--dsw-alias-state-warning-primary,#d29922);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#25262b);padding:10px 12px}
.dsm-tv-link{color:var(--dsw-alias-state-business-primary,#5686fe);text-decoration:none;cursor:pointer}
.dsm-tv-link:hover{text-decoration:underline}
.dsm-tv-key{margin-top:4px}
/* 自带退路输入框：只在宿主没有 SettingsSecretField 时使用，外观尽量贴近它。 */
.dsm-tv-field{display:flex;flex-direction:column;gap:6px}
.dsm-tv-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-tv-field-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600}
.dsm-tv-input{font:inherit;font-size:13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-primary,#e6e6e6);padding:8px 12px}
.dsm-tv-list{margin:4px 0 0;padding-left:18px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
`;

    // 字典值必须是**字符串**：DSH 的 t(key, params) 用 `{name}` 占位符插值
    // （见 @deepseek-ai/dsh-client-locale 的 bind）。放函数会让 t() 返回函数本身，
    // React 拿它当 child 直接抛错，整块卡片从页面上消失。
    const zh = {
      title: 'Tavily 联网搜索',
      description: '用 Tavily 给 DSH 的「网页搜索」供数：本插件在 DSH 进程内提供搜索接口，网页搜索的接口地址指向它即可。',
      summary: '用 Tavily 给 DSH 的网页搜索供数。',
      keyTitle: 'API Key',
      keyLabel: 'Tavily API Key',
      keyHint: '存入 DSH 凭据库（{ref}），不写入设置文件。留空表示保持当前密钥。',
      keyReadOnly: '{ref} 由启动环境变量提供，这里无法修改；要换 key 请先在启动环境里去掉它。',
      keySet: '已配置密钥',
      keyUnset: '未配置密钥',
      keyLoading: '读取中…',
      keyGet: '没有 key？到 Tavily 控制台申请：',
      save: '保存',
      saving: '保存中…',
      clear: '清除密钥',
      clearTitle: '清除后网页搜索会因缺少 key 而失败，确定清除？',
      clearConfirm: '确认清除',
      cancel: '取消',
      keySaved: '已保存，下一次搜索立即使用新密钥。',
      keyCleared: '已清除密钥。',
      serverTitle: '搜索接口',
      serverEndpoint: '地址：',
      serverListening: '运行中',
      serverExternal: '由外部实例提供',
      serverConflict: '端口被占用',
      serverFailed: '启动失败',
      serverStarting: '启动中',
      serverStopped: '已停止',
      serverDisabled: '已禁用',
      statusLoading: '正在读取插件状态…',
      statusError: '读取插件状态失败：{reason}',
      refresh: '刷新',
      test: '测试搜索',
      testing: '搜索中…',
      testOk: '搜索成功：「{query}」返回 {count} 条结果，用时 {ms} ms。',
      testFailed: '搜索失败：{reason}',
      webTitle: '网页搜索接入',
      webLoading: '正在读取网页搜索设置…',
      webUnavailable: '内置的网页搜索插件当前未加载，无法接入。',
      webCurrent: '网页搜索接口地址：',
      webDefault: '默认（DeepSeek 官方接口）',
      webWired: '已接入',
      webNotWired: '未接入',
      wire: '接入网页搜索',
      wiring: '处理中…',
      wireHint: '会把「网页搜索」的接口地址改为 {endpoint}。',
      unwire: '恢复默认',
      unwireHint: '恢复后网页搜索改回 DeepSeek 官方接口。',
      wired: '已接入：网页搜索现在使用本插件的接口。',
      unwired: '已恢复网页搜索的默认接口地址。',
      webKeyMissing: '「网页搜索」页的 API Key 目前为空：DSH 只在它非空时才发起搜索（DeepSeek 账号模型除外）。本插件不校验这个值，填任意非空字符串即可。',
      webReadOnly: '本部署的设置为只读。',
      writeRejected: '宿主没有接受这次修改。',
    };

    const en = {
      title: 'Tavily web search',
      description: 'Feeds DSH web search with Tavily: this plugin serves a search endpoint inside DSH; point the web-search endpoint at it.',
      summary: 'Feeds DSH web search with Tavily.',
      keyTitle: 'API key',
      keyLabel: 'Tavily API key',
      keyHint: 'Stored in the DSH credential store ({ref}), never in a settings file. Leave blank to keep the current key.',
      keyReadOnly: '{ref} comes from the launch environment and cannot be changed here; remove it there first.',
      keySet: 'Key configured',
      keyUnset: 'No key',
      keyLoading: 'Reading…',
      keyGet: 'No key yet? Get one from the Tavily console: ',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Clear key',
      clearTitle: 'Web search will fail without a key. Clear it?',
      clearConfirm: 'Clear',
      cancel: 'Cancel',
      keySaved: 'Saved; the next search uses the new key.',
      keyCleared: 'Key cleared.',
      serverTitle: 'Search endpoint',
      serverEndpoint: 'Address: ',
      serverListening: 'running',
      serverExternal: 'served by another instance',
      serverConflict: 'port in use',
      serverFailed: 'failed',
      serverStarting: 'starting',
      serverStopped: 'stopped',
      serverDisabled: 'disabled',
      statusLoading: 'Reading plugin status…',
      statusError: 'Could not read plugin status: {reason}',
      refresh: 'Refresh',
      test: 'Test search',
      testing: 'Searching…',
      testOk: 'Search OK: "{query}" returned {count} results in {ms} ms.',
      testFailed: 'Search failed: {reason}',
      webTitle: 'Web search wiring',
      webLoading: 'Reading web-search settings…',
      webUnavailable: 'The built-in web-search plugin is not loaded, so it cannot be wired.',
      webCurrent: 'Web-search endpoint: ',
      webDefault: 'default (DeepSeek official)',
      webWired: 'wired',
      webNotWired: 'not wired',
      wire: 'Wire web search',
      wiring: 'Working…',
      wireHint: 'Sets the web-search endpoint to {endpoint}.',
      unwire: 'Reset to default',
      unwireHint: 'Web search goes back to the DeepSeek official endpoint.',
      wired: 'Wired: web search now uses this plugin.',
      unwired: 'Web-search endpoint reset to default.',
      webKeyMissing: 'The web-search page has no API key, and DSH only searches when it is non-empty (DeepSeek Account models aside). This plugin does not check it; any non-empty value works.',
      webReadOnly: 'This deployment stores settings read-only.',
      writeRejected: 'The host did not accept the change.',
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

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
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

    /** 比较接口地址时忽略末尾斜杠与大小写（主机名不区分大小写，路径这里只有 /v1）。 */
    function sameEndpoint(a, b) {
      const norm = (value) => String(value ?? '').trim().replace(/\/+$/, '').toLowerCase();
      return norm(a) !== '' && norm(a) === norm(b);
    }

    /** 自带的密钥输入框：只在宿主没有 SettingsSecretField 时使用，props 与它一致。 */
    function FallbackSecretField(props) {
      return h(
        'div',
        { className: 'dsm-tv-field' },
        h(
          'div',
          { className: 'dsm-tv-field-head' },
          h('label', { className: 'dsm-tv-field-label', htmlFor: props.id }, props.label),
          h('span', { className: `dsm-tv-badge${props.configured ? ' dsm-tv-badge-ok' : ''}` }, props.stateLabel),
        ),
        h('input', {
          id: props.id,
          className: 'dsm-tv-input',
          type: 'password',
          // 防止浏览器把保存的登录密码自动填进来
          autoComplete: 'new-password',
          value: props.text,
          disabled: props.disabled,
          onChange: (event) => props.onEdit(event.target.value),
        }),
        h('p', { className: 'dsm-tv-hint' }, props.hint),
      );
    }

    const SecretField =
      typeof primitives?.SettingsSecretField === 'function' ? primitives.SettingsSecretField : FallbackSecretField;

    function button(key, kind, label, onClick, disabled) {
      return h('button', { key, type: 'button', className: `dsm-tv-btn dsm-tv-btn-${kind}`, disabled, onClick }, label);
    }

    function notice(key, value) {
      if (!value) return null;
      return h(
        'p',
        { key, className: `dsm-tv-notice ${value.kind === 'error' ? 'dsm-tv-notice-error' : 'dsm-tv-notice-ok'}` },
        value.text,
      );
    }

    function badge(key, tone, label) {
      return h('span', { key, className: `dsm-tv-badge${tone && tone !== 'quiet' ? ` dsm-tv-badge-${tone}` : ''}` }, label);
    }

    function externalLink(url) {
      // DSH 自己那套：http(s) + target=_blank，宿主主窗口会把它交给默认浏览器打开
      return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', className: 'dsm-tv-link', title: url }, url.replace(/^https?:\/\//, ''));
    }

    /**
     * 纯渲染：view model + 动作 → 元素树。与 hooks 分开，测试可以直接喂各种状态断言输出。
     *
     * @param {object} model 见 TavilyCard 里的组装
     * @param {Record<string, Function>} actions
     * @param {(key: string, params?: object) => string} t
     */
    function renderCard(model, actions, t) {
      const { status, key, web, test } = model;
      const ref = status.apiKeyRef ?? DEFAULT_REF;
      const endpoint = status.endpoint ?? DEFAULT_ENDPOINT;

      // ---- API Key ----
      const keyWritable = key.writable !== false;
      const keyBusy = Boolean(model.keyBusy);
      const keySection = [
        h('div', { key: 'head', className: 'dsm-tv-section-head' }, h('span', { className: 'dsm-tv-section-title' }, t('keyTitle'))),
        h(
          'div',
          { key: 'field', className: 'dsm-tv-key' },
          h(SecretField, {
            id: 'dsh-tavily-search-key',
            label: t('keyLabel'),
            hint: keyWritable ? t('keyHint', { ref }) : t('keyReadOnly', { ref }),
            disabled: !keyWritable || keyBusy || key.phase === 'loading',
            text: model.draft,
            configured: key.configured === true,
            stateLabel: key.phase === 'loading' ? t('keyLoading') : key.configured ? t('keySet') : t('keyUnset'),
            onEdit: actions.editDraft,
          }),
        ),
        h(
          'div',
          { key: 'toolbar', className: 'dsm-tv-toolbar' },
          button('save', 'primary', model.keyBusy === 'save' ? t('saving') : t('save'), actions.saveKey, !model.draft.trim() || keyBusy || !keyWritable),
          key.configured && keyWritable
            ? button('clear', 'danger', t('clear'), actions.askClear, keyBusy || model.confirmClear)
            : null,
        ),
      ];
      if (model.confirmClear) {
        keySection.push(
          h(
            'div',
            { key: 'confirm', className: 'dsm-tv-confirm' },
            h('div', { className: 'dsm-tv-line' }, h('strong', null, t('clearTitle'))),
            h(
              'div',
              { className: 'dsm-tv-toolbar' },
              button('cancel', 'outline', t('cancel'), actions.cancelClear, keyBusy),
              button('confirm', 'danger', t('clearConfirm'), actions.clearKey, keyBusy),
            ),
          ),
        );
      }
      if (key.phase === 'error') keySection.push(notice('keyError', { kind: 'error', text: key.reason }));
      keySection.push(notice('keyNotice', model.keyNotice));
      if (!key.configured) {
        keySection.push(h('p', { key: 'get', className: 'dsm-tv-hint' }, t('keyGet'), externalLink(TAVILY_CONSOLE_URL)));
      }

      // ---- 搜索接口 ----
      const serverSection = [];
      if (status.phase === 'loading') {
        serverSection.push(h('p', { key: 'loading', className: 'dsm-tv-line' }, t('statusLoading')));
      } else if (status.phase === 'error') {
        serverSection.push(notice('statusError', { kind: 'error', text: t('statusError', { reason: status.reason }) }));
      }
      const state = status.server?.state;
      const [tone, label] = SERVER_BADGE[state] ?? [];
      const canTest = state === 'listening' || state === 'external';
      serverSection.unshift(
        h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t('serverTitle')),
          label ? badge('badge', tone, t(label)) : null,
          button('refresh', 'outline', t('refresh'), actions.reload, status.phase === 'loading'),
          button('test', 'primary', test.busy ? t('testing') : t('test'), actions.runTest, test.busy || !canTest),
        ),
        h('p', { key: 'endpoint', className: 'dsm-tv-line' }, t('serverEndpoint'), h('span', { className: 'dsm-tv-code' }, endpoint)),
      );
      if (status.server?.reason) {
        serverSection.push(h('p', { key: 'reason', className: 'dsm-tv-line' }, status.server.reason));
      }
      if (test.result) {
        const result = test.result;
        serverSection.push(
          notice(
            'test',
            result.ok
              ? { kind: 'ok', text: t('testOk', { query: result.query, count: result.count, ms: result.elapsedMs }) }
              : { kind: 'error', text: t('testFailed', { reason: result.reason }) },
          ),
        );
        if (result.ok && Array.isArray(result.titles) && result.titles.length > 0) {
          serverSection.push(
            h('ul', { key: 'titles', className: 'dsm-tv-list' }, result.titles.map((title, index) => h('li', { key: String(index) }, title))),
          );
        }
      }

      // ---- 网页搜索接入 ----
      const webSection = [h('div', { key: 'head', className: 'dsm-tv-section-head' }, h('span', { className: 'dsm-tv-section-title' }, t('webTitle')))];
      if (web.phase === 'unavailable') {
        webSection.push(h('p', { key: 'unavailable', className: 'dsm-tv-line' }, t('webUnavailable')));
      } else if (web.phase !== 'ready') {
        webSection.push(h('p', { key: 'loading', className: 'dsm-tv-line' }, t('webLoading')));
      } else {
        const wired = sameEndpoint(web.baseURL, endpoint);
        const webBusy = Boolean(model.webBusy);
        webSection[0] = h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t('webTitle')),
          badge('badge', wired ? 'ok' : 'warn', wired ? t('webWired') : t('webNotWired')),
          wired
            ? web.overridden
              ? button('unwire', 'outline', webBusy ? t('wiring') : t('unwire'), actions.unwire, webBusy || !web.writable)
              : null
            : button('wire', 'primary', webBusy ? t('wiring') : t('wire'), actions.wire, webBusy || !web.writable),
        );
        webSection.push(
          h(
            'p',
            { key: 'current', className: 'dsm-tv-line' },
            t('webCurrent'),
            web.baseURL ? h('span', { className: 'dsm-tv-code' }, web.baseURL) : t('webDefault'),
          ),
        );
        if (!web.writable) {
          webSection.push(h('p', { key: 'readOnly', className: 'dsm-tv-hint' }, t('webReadOnly')));
        } else if (!wired) {
          webSection.push(h('p', { key: 'wireHint', className: 'dsm-tv-hint' }, t('wireHint', { endpoint })));
        } else if (web.overridden) {
          webSection.push(h('p', { key: 'unwireHint', className: 'dsm-tv-hint' }, t('unwireHint')));
        }
        if (wired && web.keyConfigured === false) {
          webSection.push(h('p', { key: 'webKey', className: 'dsm-tv-hint' }, t('webKeyMissing')));
        }
      }
      webSection.push(notice('webNotice', model.webNotice));

      return h(
        'div',
        { className: 'dsm-tv-card' },
        h('div', { className: 'dsm-tv-title' }, t('title')),
        h('p', { className: 'dsm-tv-desc' }, t('description')),
        h('div', { key: 'key', className: 'dsm-tv-section' }, keySection),
        h('div', { key: 'server', className: 'dsm-tv-section' }, serverSection),
        h('div', { key: 'web', className: 'dsm-tv-section' }, webSection),
      );
    }

    /** 把 configForms 的快照翻成卡片关心的几项。 */
    function webModel(snapshot) {
      if (!snapshot || snapshot.status === 'loading') return { phase: 'loading' };
      if (snapshot.status !== 'ready') return { phase: 'unavailable' };
      const user = snapshot.user;
      return {
        phase: 'ready',
        baseURL: typeof snapshot.value?.baseURL === 'string' ? snapshot.value.baseURL : '',
        apiKeyEnv: typeof snapshot.value?.apiKeyEnv === 'string' && snapshot.value.apiKeyEnv ? snapshot.value.apiKeyEnv : WEB_SEARCH_DEFAULT_REF,
        // 与宿主表单同一口径：用户层里"有这个键"才算覆盖，不比较值
        overridden: user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'baseURL'),
        writable: snapshot.writable !== false,
      };
    }

    /**
     * 有状态的外壳：取数、订阅、动作；渲染交给 renderCard。
     *
     * @param {{ t: Function, view?: string, api: object }} props
     */
    function TavilyCard({ t, view, api }) {
      const [status, setStatus] = useState({ phase: 'loading' });
      const [key, setKey] = useState({ phase: 'loading' });
      const [draft, setDraft] = useState('');
      const [keyBusy, setKeyBusy] = useState(undefined);
      const [confirmClear, setConfirmClear] = useState(false);
      const [keyNotice, setKeyNotice] = useState(undefined);
      const [webSnapshot, setWebSnapshot] = useState(() => api.webForm?.getSnapshot?.());
      const [webKeyConfigured, setWebKeyConfigured] = useState(undefined);
      const [webBusy, setWebBusy] = useState(false);
      const [webNotice, setWebNotice] = useState(undefined);
      const [test, setTest] = useState({ busy: false, result: undefined });

      const ref = status.apiKeyRef ?? DEFAULT_REF;
      const web = webModel(webSnapshot);

      const loadStatus = useCallback(async () => {
        setStatus((previous) => ({ ...previous, phase: 'loading' }));
        try {
          const payload = await request(STATUS_PATH, 'GET');
          setStatus({ phase: 'ready', ...payload });
        } catch (error) {
          setStatus({ phase: 'error', reason: errorText(error) });
        }
      }, []);

      const loadKey = useCallback(async () => {
        try {
          const views = unwrap(await api.describe([ref]));
          const info = views?.[ref] ?? {};
          setKey({ phase: 'ready', configured: info.configured === true, writable: info.writable !== false, source: info.source });
        } catch (error) {
          setKey({ phase: 'error', reason: errorText(error) });
        }
      }, [api, ref]);

      const loadWebKey = useCallback(async () => {
        if (web.phase !== 'ready') return;
        try {
          const views = unwrap(await api.describe([web.apiKeyEnv]));
          setWebKeyConfigured(views?.[web.apiKeyEnv]?.configured === true);
        } catch {
          setWebKeyConfigured(undefined);
        }
      }, [api, web.phase, web.apiKeyEnv]);

      useEffect(() => {
        loadStatus();
      }, [loadStatus]);

      useEffect(() => {
        loadKey();
      }, [loadKey]);

      useEffect(() => {
        loadWebKey();
      }, [loadWebKey]);

      // 网页搜索设置可能在别处被改（内置网页搜索页），订阅快照保持同步
      useEffect(() => {
        const form = api.webForm;
        if (typeof form?.subscribe !== 'function') return undefined;
        setWebSnapshot(form.getSnapshot());
        return form.subscribe(() => setWebSnapshot(form.getSnapshot()));
      }, [api]);

      // 凭据在别处被改（内置网页搜索页 / 模型页写同一个引用）时刷新"已配置"徽标
      useEffect(
        () =>
          api.onCredentialUpdated?.((changed) => {
            if (changed === ref) loadKey();
            if (changed === web.apiKeyEnv) loadWebKey();
          }),
        [api, ref, web.apiKeyEnv, loadKey, loadWebKey],
      );

      const saveKey = useCallback(async () => {
        const value = draft.trim();
        if (!value) return;
        setKeyBusy('save');
        setKeyNotice(undefined);
        try {
          unwrap(await api.setKey(ref, value));
          setDraft('');
          setKeyNotice({ kind: 'ok', text: t('keySaved') });
          await loadKey();
        } catch (error) {
          setKeyNotice({ kind: 'error', text: errorText(error) });
        } finally {
          setKeyBusy(undefined);
        }
      }, [api, draft, ref, loadKey, t]);

      const clearKey = useCallback(async () => {
        setConfirmClear(false);
        setKeyBusy('clear');
        setKeyNotice(undefined);
        try {
          unwrap(await api.unsetKey(ref));
          setKeyNotice({ kind: 'ok', text: t('keyCleared') });
          await loadKey();
        } catch (error) {
          setKeyNotice({ kind: 'error', text: errorText(error) });
        } finally {
          setKeyBusy(undefined);
        }
      }, [api, ref, loadKey, t]);

      const writeWeb = useCallback(
        async (op, okText) => {
          const form = api.webForm;
          if (!form) return;
          setWebBusy(true);
          setWebNotice(undefined);
          try {
            const accepted = await (op === 'set' ? form.set('baseURL', status.endpoint ?? DEFAULT_ENDPOINT) : form.unset('baseURL'));
            setWebNotice(accepted === false ? { kind: 'error', text: t('writeRejected') } : { kind: 'ok', text: okText });
          } catch (error) {
            setWebNotice({ kind: 'error', text: errorText(error) });
          } finally {
            setWebBusy(false);
          }
        },
        [api, status.endpoint, t],
      );

      const runTest = useCallback(async () => {
        setTest({ busy: true, result: undefined });
        try {
          setTest({ busy: false, result: await request(TEST_PATH, 'POST', {}) });
        } catch (error) {
          setTest({ busy: false, result: { ok: false, reason: errorText(error) } });
        }
      }, []);

      // 行详情页在缺少包描述时才用 summary 视图；本包有 description，正常走完整卡片。
      if (view === 'summary') return h('p', { className: 'dsm-tv-desc' }, t('summary'));

      return renderCard(
        {
          status,
          key,
          draft,
          keyBusy,
          confirmClear,
          keyNotice,
          web: { ...web, keyConfigured: webKeyConfigured },
          webBusy,
          webNotice,
          test,
        },
        {
          editDraft: (text) => {
            setDraft(text);
            setKeyNotice(undefined);
          },
          saveKey,
          askClear: () => setConfirmClear(true),
          cancelClear: () => setConfirmClear(false),
          clearKey,
          wire: () => writeWeb('set', t('wired')),
          unwire: () => writeWeb('unset', t('unwired')),
          runTest,
          reload: () => {
            loadStatus();
            loadKey();
          },
        },
        t,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), `${name}: locale`);
      const t = ctx.locale.bind(namespace);
      ensureStyle();

      // 凭据变更事件扇出给卡片：卡片实例随页面挂卸，事件订阅跟插件生命周期走
      const listeners = new Set();
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            for (const listener of listeners) listener(ref);
          }),
        `${name}: credential invalidations`,
      );

      /** 卡片拿到的全部能力；凭据值只往宿主写，没有任何读值的路径。 */
      const api = {
        describe: (refs) => ctx.remote.credentials.describe(refs),
        setKey: (ref, value) => ctx.remote.credentials.set(ref, value),
        unsetKey: (ref) => ctx.remote.credentials.unset(ref),
        webForm: ctx.configForms.get(WEB_SEARCH_NS),
        onCredentialUpdated: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      /**
       * 两处注册共用一份组件：组合包页面与"本插件那一行"的配置页。
       * 整段包在 try 里——DSH 的 slot API 还在 rc 阶段，注册失败只该少一张卡片。
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
              TavilyCard,
            ),
          );
        } catch (error) {
          console.error(`[${name}] 卡片注册失败（slot ${slotName}）：`, error);
        }
      };

      registerCard('plugins.bundle.config', 'dsh-tavily-search');
      registerCard('plugins.row.config', 'dsh-tavily-search#dsh-tavily-search');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    // 只给测试用：纯渲染函数与快照映射，宿主不会读这两个导出
    exports.renderCard = renderCard;
    exports.webModel = webModel;
    return module.exports;
  },
});
