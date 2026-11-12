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
 * 四块内容，各走既有的通道，本插件不自建存储：
 *   1. API Key（可以多个）—— 写入 / 删除走 `remote.credentials`（DSH 凭据库，与内置「网页搜索」页
 *      同一条路），值只往宿主写、从不读回；列表走宿主半侧的 keys 路由，只拿到"有没有配置、能不能改"
 *      和末 4 位（用来分辨要删哪个）。第 1 个 key 的引用名是 TAVILY_API_KEY，之后是 _2、_3…；
 *   2. 搜索接口状态与测试 —— 宿主半侧（lib/web.js）的 loopback 路由；
 *   3. 网页搜索接入 —— 新宿主在 `configForms.get('web')` 里直接选择 Tavily。
 *      旧宿主按提供方选择走两套兼容协议之一：
 *      新版开关关闭（`deepseek-official`，或旧版 DSH 没有该命名空间）时操作
 *      `configForms.get('web-search-deepseek')` 的 Messages 接口地址；打开（`deepseek-search-api`）
 *      时操作 `configForms.get('web-deepseek-api')` 的 Search API 基础地址。两套都是把接口地址改成
 *      本插件的端点、凭据引用改成本插件的占位凭据，或恢复默认；新版接入还会把抓取提供方从
 *      `deepseek-fetch-api` 改回本地 HTTP（本插件只提供搜索，不做抓取）。
 *   4. 插件更新 —— 当前运行版本与 npm 最新版本由宿主半侧的 version 路由提供；
 *      更新资格、目标版本和安装都交给 DSH 官方 `remote.pluginManager`。
 *
 * 布局：头部（说明 + 状态）→ 页签。页签依次是 API Key / 网页搜索 / 搜索接口 / 插件（更新与卸载前清除）；
 * 各面板都渲染、只切 hidden，切页签不丢未提交的 key。头部状态可点击，跳到对应页签。
 *
 * 样式：全部自带（data-plugin-css 标记，避免重复注入），类名统一 `dsm-tv-*`，
 * 颜色只取 `--dsw-alias-*` 令牌，跟随主题。密钥输入框优先用宿主的 SettingsSecretField，
 * 与内置网页搜索页长得一样；拿不到宿主组件时退回自带的同款输入框。
 */

// 模块 id 必须是 npm 包名：宿主的客户端模块表按包名登记，对不上就加载不到本 bundle。
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-tavily-search',
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
    const KEYS_PATH = '/plugins/dsh-tavily-search/keys';
    /** 宿主状态拿不到时的兜底值（与 lib/config.js 的默认一致）。 */
    const DEFAULT_REF = 'TAVILY_API_KEY';
    const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/v1';
    /**
     * 内置搜索提供方的设置命名空间与它的默认凭据引用。写在这里而不是 import：
     * 客户端包不能依赖宿主包（与 dsh-client-ui-settings-web-search 的做法一致）。
     */
    const WEB_SEARCH_NS = 'web-search-deepseek';
    /** 新版 Search API 提供方的设置命名空间（DSH 0.2.1-rc.2 起随内置网页搜索页一起下发）。 */
    const WEB_API_NS = 'web-deepseek-api';
    const NATIVE_SEARCH_PROVIDER = 'dsh-tavily-search';
    const WEB_SEARCH_DEFAULT_REF = 'DEEPSEEK_API_KEY';
    /**
     * 接入时让网页搜索改读的专用凭据引用与占位值。
     * 内置网页搜索在 apiKeyEnv 指向的凭据为空时直接报错、不发请求；而默认引用 DEEPSEEK_API_KEY
     * 同时是 DeepSeek 聊天（dsh-llm-deepseek-api-key）的 key——让用户在那栏随便填会覆盖聊天 key，
     * 借用它又会把真 key 发给本机接口。改指向一个只有本插件用的引用，两头都避开。
     * 本机接口默认不校验这个值（配了 shimApiKey 时才校验），所以写一个可辨认的占位串即可。
     */
    const WEB_SEARCH_SHIM_REF = 'DSH_TAVILY_SEARCH_PLACEHOLDER';
    const WEB_SEARCH_SHIM_VALUE = 'dsh-tavily-search';
    /**
     * Web 服务的提供方选择（DSH 0.2.1-rc.2 起，内置网页搜索页的「启用新版 Web 搜索 API」开关写这里）。
     *   - searchProvider = deepseek-official：旧版 Messages 搜索，读 web-search-deepseek.baseURL（即本插件旧接入）；
     *   - searchProvider = deepseek-search-api：新版 Search API，读 web-deepseek-api.baseURL（本插件的新接入，
     *     卡片把它指到 http://127.0.0.1:8787/v1/tools，之后由本插件回答 /search）；
     *   - 其它 id：搜索被别的插件占用。
     * 0.2.1-rc.1 及更早没有这个开关；命名空间不存在时按旧版 Messages 处理。
     */
    const WEB_NS = 'web';
    const MESSAGES_SEARCH_PROVIDER = 'deepseek-official';
    const API_SEARCH_PROVIDER = 'deepseek-search-api';
    const API_FETCH_PROVIDER = 'deepseek-fetch-api';
    /** 开关关上时宿主页写回的抓取提供方（web-fetch-http 的 id）。 */
    const HTTP_FETCH_PROVIDER = 'http';
    /** Tavily 控制台：申请 / 查看 key。外链交给宿主用默认浏览器打开。 */
    const TAVILY_CONSOLE_URL = 'https://app.tavily.com/home';

    /** 本插件的 npm 包名：DSH 插件管理器按它定位 profile 中的依赖。 */
    const PACKAGE_NAME = '@zhiqiangme/dsh-tavily-search';
    /** 宿主半侧的版本检查路由（lib/web.js），?force=1 绕过它的 10 分钟缓存。 */
    const VERSION_PATH = '/plugins/dsh-tavily-search/version';
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

    /** 页签：id → 文案 key，顺序即显示顺序。 */
    const TABS = [['keys', 'tabKeys'], ['web', 'tabWeb'], ['server', 'tabServer'], ['plugin', 'tabPlugin']];

    // 宿主的列表页和详情页共用滚动容器且切换时不归零，从滚动过的列表点进来会停在页面中下部。
    // 面板在每个详情页首次挂载时滚回顶部；WeakSet 避免同一页内重新挂载时打断用户滚动。
    // data-plugin-config 只在配置页上（bundle 页的 section、行页的 detailSections），其他页面直接跳过。
    const openedPages = new WeakSet();
    function showPanelFromTop(element) {
      const page = element?.closest('[data-plugin-config]');
      if (!page || openedPages.has(page)) return;
      openedPages.add(page);
      // 滚动容器的类名由宿主打包生成，不依赖它：对不滚动的祖先赋值没有效果。
      for (let node = page.parentElement; node; node = node.parentElement) node.scrollTop = 0;
    }

    const CSS = `
/* DSH 详情页把 README 排在面板上方，且不提供排序参数；order 把面板提到 README 前。宿主改 DOM 后规则不再命中，面板退回 README 下方。 */
[data-plugin-detail="@zhiqiangme/dsh-tavily-search"] section[data-plugin-config]{order:-1}
.dsm-tv-card{--dsm-tv-ease:cubic-bezier(.2,.8,.2,1);min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.55}
.dsm-tv-card *{box-sizing:border-box}
.dsm-tv-head{padding:18px 20px 14px}
.dsm-tv-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:16px;font-weight:600;line-height:1.4}
.dsm-tv-desc{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:1.5}
.dsm-tv-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.dsm-tv-chip{appearance:none;display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,#ffffff14);color:var(--dsw-alias-label-secondary,#c6c9d0);font:inherit;font-size:12px;line-height:20px;cursor:pointer;transition:color .15s ease}
.dsm-tv-chip:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-tv-chip b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:500}
.dsm-tv-chip-dot{flex:none;width:6px;height:6px;border-radius:50%;color:var(--dsw-alias-label-tertiary,#999);background:currentColor}
.dsm-tv-chip[data-tone=ok] .dsm-tv-chip-dot{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dsm-tv-chip[data-tone=warn] .dsm-tv-chip-dot{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-tv-chip[data-tone=error] .dsm-tv-chip-dot{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-tv-new{color:var(--dsw-alias-state-business-primary,#5686fe)}
/* 横向滚动会连带裁掉纵向溢出：底线不能画在边框上，改用内阴影画分隔线，选中线压在它上面；焦点框也收进按钮内。 */
.dsm-tv-tabs{display:flex;gap:2px;padding:0 10px;box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l2,#36373b);overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.dsm-tv-tab{appearance:none;position:relative;flex:none;display:inline-flex;align-items:center;gap:6px;padding:8px 10px 9px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;transition:color .15s ease}
.dsm-tv-tab:hover,.dsm-tv-tab[aria-selected=true]{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-tv-tab[aria-selected=true]::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;border-radius:2px;background:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-tv-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:-2px}
.dsm-tv-chip:focus-visible,.dsm-tv-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:2px}
.dsm-tv-mark{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-tv-mark[data-tone=error]{background:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-tv-mark[data-tone=accent]{background:var(--dsw-alias-state-business-primary,#5686fe)}
.dsm-tv-panel{min-width:0;padding:16px 20px 20px}
.dsm-tv-section+.dsm-tv-section{margin-top:18px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:16px}
.dsm-tv-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-tv-section-title{flex:1;min-width:100px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:1.5}
.dsm-tv-line{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6;word-break:break-all}
.dsm-tv-line strong{color:var(--dsw-alias-label-secondary,#c6c9d0);font-weight:500}
.dsm-tv-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-tv-hint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
.dsm-tv-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px}
.dsm-tv-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-tv-btn:disabled{cursor:default}
/* 沿用 DSH 自家主按钮的配色令牌（深色主题为浅底深字）。宿主的 brand-primary-invert 与 brand-primary 同值，不能当文字色。 */
.dsm-tv-btn-primary{background:var(--dsw-alias-button-primary-fill,#e6e6e6);color:var(--dsw-alias-label-primary-foreground,#202126)}
.dsm-tv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#c6c9d0)}
.dsm-tv-btn-outline{background:transparent;border-color:var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-tv-btn-outline:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 禁用态给明确的弱化配色，而不是整体降透明度（会把字一起洗掉）。 */
.dsm-tv-btn-primary:disabled{background:var(--dsw-alias-interactive-bg-hover,#ffffff14);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-tv-btn-outline:disabled{color:var(--dsw-alias-label-dimmed,#8a8f99)}
.dsm-tv-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-tv-btn-danger:hover:not(:disabled){background:rgba(217,45,32,.12)}
.dsm-tv-badge{flex:none;border-radius:6px;padding:1px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-tertiary,#999)}
.dsm-tv-badge-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.dsm-tv-badge-warn{color:var(--dsw-alias-state-warn-primary,#d29922);border-color:currentColor}
.dsm-tv-badge-error{color:var(--dsw-alias-state-error-primary,#d92d20);border-color:currentColor}
.dsm-tv-notice{margin:8px 0 0;font-size:13px;line-height:1.6;word-break:break-all}
.dsm-tv-notice-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dsm-tv-notice-error{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-tv-confirm{margin-top:10px;border:1px solid var(--dsw-alias-state-warn-primary,#d29922);border-radius:10px;background:var(--dsw-alias-bg-base,#1b1c20);padding:10px 12px}
.dsm-tv-link{color:var(--dsw-alias-state-business-primary,#5686fe);text-decoration:none;cursor:pointer}
.dsm-tv-link:hover{text-decoration:underline}
.dsm-tv-key{margin-top:10px}
.dsm-tv-keys{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.dsm-tv-keyrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;background:var(--dsw-alias-bg-base,#1b1c20);padding:6px 10px}
.dsm-tv-keyrow-main{flex:1;min-width:120px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px;line-height:1.5}
.dsm-tv-keyrow-index{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-tv-keyrow-ref{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.dsm-tv-keyrow .dsm-tv-btn{padding:2px 10px;font-size:12px}
.dsm-tv-keyrow .dsm-tv-confirm{flex-basis:100%;margin-top:4px}
/* 自带退路输入框：只在宿主没有 SettingsSecretField 时使用，外观尽量贴近它。 */
.dsm-tv-field{display:flex;flex-direction:column;gap:6px}
.dsm-tv-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-tv-field-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600}
.dsm-tv-input{font:inherit;font-size:13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-base,#1b1c20);color:var(--dsw-alias-label-primary,#e6e6e6);padding:8px 12px}
.dsm-tv-install-spec{box-sizing:border-box;width:100%;margin-top:8px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace)}
.dsm-tv-list{margin:4px 0 0;padding-left:18px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}
@media(max-width:640px){.dsm-tv-head,.dsm-tv-panel{padding-left:14px;padding-right:14px}}
/* 换页签时内容从下方轻轻浮现；只动 opacity / transform，错峰延迟期间停在首帧。sibling-index() 不支持时退化为同时出现。 */
@keyframes dsm-tv-rise{from{opacity:0;transform:translateY(6px)}}
.dsm-tv-panel>*{animation:dsm-tv-rise .32s var(--dsm-tv-ease) backwards;animation-delay:calc(min(sibling-index() - 1, 5) * 40ms)}
/* 页签下划线改成滑块：锚定到当前选中项，换页签时滑过去。不支持锚点定位时保留选中项自带的静态下划线。 */
@supports (anchor-name:--a) and (anchor-scope:--a){
.dsm-tv-tabs{position:relative;anchor-scope:--dsm-tv-tab}
.dsm-tv-tabs::before{content:"";position:absolute;position-anchor:--dsm-tv-tab;left:calc(anchor(left) + 10px);right:calc(anchor(right) + 10px);bottom:anchor(bottom);height:2px;border-radius:2px;background:var(--dsw-alias-label-primary,#e6e6e6);transition:left .3s var(--dsm-tv-ease),right .3s var(--dsm-tv-ease)}
.dsm-tv-tab[aria-selected=true]{anchor-name:--dsm-tv-tab}
.dsm-tv-tab[aria-selected=true]::after{content:none}
}
@media (prefers-reduced-motion:reduce){.dsm-tv-card,.dsm-tv-card *,.dsm-tv-card *::before,.dsm-tv-card *::after{animation:none!important;transition:none!important}}
`;

    // 字典值必须是**字符串**：DSH 的 t(key, params) 用 `{name}` 占位符插值
    // （见 @deepseek-ai/dsh-client-locale 的 bind）。放函数会让 t() 返回函数本身，
    // React 拿它当 child 直接抛错，整块卡片从页面上消失。
    const zh = {
      title: 'Tavily 联网搜索',
      description: '让 DSH 的网页搜索使用 Tavily。API Key 由 DSH 凭据库保存。',
      summary: '用 Tavily 给 DSH 的网页搜索供数。',
      tabKeys: 'API Key',
      tabWeb: '网页搜索',
      tabServer: '搜索接口',
      tabPlugin: '插件',
      keyTitle: 'API Key',
      keyCount: '{count} 个',
      keyUnset: '未配置密钥',
      keyLoading: '正在读取密钥列表…',
      keyLoadFailed: '读取密钥列表失败：{reason}',
      keyRotate: '多个 key 轮流使用；某个 key 失效、被限流或额度用尽时，自动换下一个重试。',
      keyReadOnly: '启动环境变量提供，不能在这里删除',
      keyAddLabel: '添加 Tavily API Key',
      keyAddHint: '存入 DSH 凭据库（{ref}），不写入设置文件。',
      keyFull: '已达到上限（{max} 个），删除一个后才能再添加。',
      keyGet: '获取 Tavily API Key：',
      add: '添加',
      adding: '添加中…',
      remove: '删除',
      removing: '删除中…',
      removeTitle: '删除 {name}？',
      removeLastTitle: '{name} 是最后一个 key，删除后网页搜索会因缺少 key 而失败。确定删除？',
      removeConfirm: '确认删除',
      cancel: '取消',
      keyAdded: '已添加，下一次搜索起参与轮换。',
      keyRemoved: '已删除 {name}。',
      serverTitle: '搜索接口',
      nativeTestTitle: 'Tavily 搜索',
      serverEndpoint: 'Messages 地址：',
      serverApiEndpoint: '新版 API 地址：',
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
      nativeHint: '也可在「网页搜索与获取」的「网页搜索提供方」里选择 Tavily 并保存。',
      webLoading: '正在读取网页搜索设置…',
      webUnavailable: '内置的网页搜索插件当前未加载，无法接入。',
      webApiUnavailable: '内置的新版搜索插件（web-deepseek-api）当前未加载，无法接入新版 API；可在「网页搜索」页关掉新版开关后，再用 Messages 搜索接入。',
      webChannel: '搜索通道：',
      channelMessages: 'Messages 搜索（旧版）',
      channelApi: '新版 Web 搜索 API',
      channelOther: '其它提供方（{provider}）',
      webCurrent: '网页搜索接口地址：',
      webCurrentApi: 'Search API 基础地址：',
      webDefault: '默认（DeepSeek 官方接口）',
      webWired: '已接入',
      webNotWired: '未接入',
      webNeedsRepair: '待修复',
      webBypassed: '已被占用',
      webProvider: '搜索提供方：',
      bypassOtherHint: '网页搜索的搜索提供方被设为 {provider}，不再经过本插件。点「{action}」会接回本插件；装新版搜索插件时接新版 API，否则接回 Messages 搜索。',
      wire: '接入网页搜索',
      repair: '修复接入',
      wiring: '处理中…',
      wireHint: '会把「网页搜索」的接口地址改为 {endpoint}，并让它改读本插件的占位凭据 {ref}，不再与 DeepSeek 聊天共用 DEEPSEEK_API_KEY。',
      wireApiHint: '会把「网页搜索」的 Search API 基础地址改为 {endpoint}，并让它改读本插件的占位凭据 {ref}；网页抓取保持本地 HTTP 抓取，不消耗 Tavily 额度。',
      repairRefHint: '网页搜索已指向本插件，但仍读凭据 {ref}：它默认是 DeepSeek 聊天的 key，为空时网页搜索不发请求，有值时会被一起发给本机接口。点「修复接入」改读本插件的占位凭据。',
      repairKeyHint: '本插件的占位凭据 {ref} 是空的，网页搜索只在它非空时才发请求。点「修复接入」重新写入。',
      repairFetchHint: '网页抓取提供方还是 deepseek-fetch-api：抓取请求会被送到本插件，而本插件只提供搜索。点「{action}」把抓取改回本地 HTTP 抓取。',
      unwire: '恢复默认',
      unwireHint: '恢复后网页搜索改回 DeepSeek 官方接口，凭据也改回读 DeepSeek 的 API Key。',
      unwireApiHint: '恢复后新版搜索改回 DeepSeek 官方 Search API 地址与凭据，网页抓取改回 DeepSeek Fetch API。',
      wired: '已接入：网页搜索现在使用本插件的接口与占位凭据。',
      wiredNative: '网页搜索已切换到 Tavily。',
      unwiredNative: '已恢复默认网页搜索提供方。',
      wiredApi: '已接入：新版 Web 搜索 API 现在使用本插件的搜索接口。',
      unwired: '已恢复网页搜索的默认接口地址与凭据。',
      unwiredApi: '已恢复新版 Search API 的默认地址与凭据。',
      purgeTitle: '清除插件数据',
      purgeHint: '卸载前可在这里删除已保存的 Tavily API Key，并撤销 Tavily 的网页搜索接入。',
      purge: '清除插件数据',
      purging: '清除中…',
      purgeConfirmTitle: '清除插件数据？',
      purgeConfirmKeys: '删除 {count} 个 Tavily API Key（凭据库里的值会被清掉，无法撤销）。',
      purgeConfirmWeb: '撤销本插件的网页搜索接入。',
      purgeConfirm: '确认清除',
      purgeKeysRemoved: '已删除 {count} 个 API Key。',
      purgeWebRestored: '已撤销 Tavily 的网页搜索接入。',
      purgeKeysFailed: '{count} 个 Key 没删掉：{reason}',
      purgeWebFailed: '网页搜索接口没能恢复：{reason}',
      purgeSkipped: '{count} 个 Key 来自环境变量等只读来源，需要在外部删除。',
      purgeDone: '现在可以去「插件」页卸载本插件。',
      webReadOnly: '本部署的设置为只读。',
      writeRejected: '宿主没有接受这次修改。',
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
      updateUnsupported: '当前 DSH 版本缺少官方插件更新接口。请升级 DSH，或在「插件」页按下面的指定版本重新安装。',
      updateLinked: '本插件从本地目录安装，请更新源码后重新运行安装脚本。',
      updateManaged: '此安装由 DSH 统一管理，请通过宿主更新。',
      updateRunning: '正在更新…',
      updateCheckingTarget: '正在核对目标版本…',
      updateManagerFailed: '官方插件管理器检查失败：{reason}',
      updateSucceeded: '已更新到 v{version}。',
      updateRestartHint: '重启 DSH 后生效。',
      updateRestoreFailed: '恢复旧版本失败：{reason}。请在「插件」页检查并重新安装。',
      updateFailed: '更新失败：{reason}',
      updateInUse: 'DSH 无法在本插件运行时卸下它（bundle-in-use），没有安装新版本，当前版本照常运行。请按下面的指定版本手动重新安装。',
      updateReselectFailed: 'DSH 拒绝卸载时已把本插件移出启用列表，自动补回失败：{reason}。重启 DSH 前请在「插件」页重新启用本插件。',
      updateNoCompatible: '官方插件管理器暂未提供可更新的兼容正式版。',
      updateNotUpdatable: '官方插件管理器不支持更新此安装，请在「插件」页查看安装来源。',
      updatePinnedInstall: '按指定版本安装',
      updatePinnedHint: '先复制下面的包名和版本。在「插件」页本插件详情里先关闭「Tavily 联网搜索」组件，再卸载本插件（插件仍在运行时 DSH 会拒绝卸载），然后在「添加插件」中粘贴安装，装好后重新打开该组件。指定版本可避免 latest 因发布观察期选到旧版。卸载前无需清除插件数据，安装后重启 DSH。',
      updateCopySpec: '复制包名和版本',
      updateSpecCopied: '已复制 {spec}。到「插件」页卸载后，添加这个指定版本。',
      updateSpecCopyFailed: '复制失败，请选中包名和版本手动复制。',
      updateCancelled: '更新已取消。',
      updateRolledBack: '更新已回滚，插件保持在 v{version}。',
      updateUnknown: '未能确认更新结果，请检查「插件」页的实际安装版本后重试。',
      updateRemoving: '正在卸载旧版本…',
      updateInstalling: '正在安装新版本…',
      updateRestoring: '正在恢复旧版本…',
    };

    const en = {
      title: 'Tavily web search',
      description: 'Use Tavily for DSH web search. API keys are stored in the DSH credential store.',
      summary: 'Feeds DSH web search with Tavily.',
      tabKeys: 'API keys',
      tabWeb: 'Web search',
      tabServer: 'Search endpoint',
      tabPlugin: 'Plugin',
      keyTitle: 'API keys',
      keyCount: '{count}',
      keyUnset: 'No key',
      keyLoading: 'Reading keys…',
      keyLoadFailed: 'Could not read the keys: {reason}',
      keyRotate: 'Keys are used in turn; when one is invalid, rate-limited or out of credits, the next one is tried.',
      keyReadOnly: 'from the launch environment; cannot be removed here',
      keyAddLabel: 'Add a Tavily API key',
      keyAddHint: 'Stored in the DSH credential store ({ref}), never in a settings file.',
      keyFull: 'Limit reached ({max} keys). Remove one before adding another.',
      keyGet: 'Get a Tavily API key: ',
      add: 'Add',
      adding: 'Adding…',
      remove: 'Remove',
      removing: 'Removing…',
      removeTitle: 'Remove {name}?',
      removeLastTitle: '{name} is the last key; web search will fail without one. Remove it?',
      removeConfirm: 'Remove',
      cancel: 'Cancel',
      keyAdded: 'Added; it joins the rotation from the next search.',
      keyRemoved: 'Removed {name}.',
      serverTitle: 'Search endpoint',
      nativeTestTitle: 'Tavily search',
      serverEndpoint: 'Messages: ',
      serverApiEndpoint: 'New API: ',
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
      nativeHint: 'You can also select Tavily as the web search provider in Web search and fetch, then save.',
      webLoading: 'Reading web-search settings…',
      webUnavailable: 'The built-in web-search plugin is not loaded, so it cannot be wired.',
      webApiUnavailable: 'The built-in new-API plugin (web-deepseek-api) is not loaded, so the new Search API cannot be wired; turn the new API switch off on the Web search page to wire Messages search instead.',
      webChannel: 'Search channel: ',
      channelMessages: 'Messages search (legacy)',
      channelApi: 'new Web Search API',
      channelOther: 'another provider ({provider})',
      webCurrent: 'Web-search endpoint: ',
      webCurrentApi: 'Search API base URL: ',
      webDefault: 'default (DeepSeek official)',
      webWired: 'wired',
      webNotWired: 'not wired',
      webNeedsRepair: 'needs repair',
      webBypassed: 'occupied',
      webProvider: 'Search provider: ',
      bypassOtherHint: 'The web-search provider is set to {provider}, so searches skip this plugin. Click {action} to wire this plugin back in: the new Search API when its plugin is loaded, otherwise Messages search.',
      wire: 'Wire web search',
      repair: 'Repair wiring',
      wiring: 'Working…',
      wireHint: 'Sets the web-search endpoint to {endpoint} and points it at the placeholder credential {ref} owned by this plugin, so it no longer shares DEEPSEEK_API_KEY with DeepSeek chat.',
      wireApiHint: 'Sets the Search API base URL to {endpoint} and points it at the placeholder credential {ref} owned by this plugin; web fetch stays on local HTTP fetch and does not spend Tavily credits.',
      repairRefHint: 'Web search points at this plugin but still reads the credential {ref}, which is the DeepSeek chat key by default: when empty, web search sends nothing; when set, it is sent to the local endpoint too. Click Repair wiring to use the placeholder credential owned by this plugin.',
      repairKeyHint: 'The placeholder credential {ref} is empty, and web search only sends requests when it is set. Click Repair wiring to write it again.',
      repairFetchHint: 'The fetch provider is still deepseek-fetch-api, so page fetches would be sent to this plugin, which only serves search. Click {action} to put web fetch back on local HTTP fetch.',
      unwire: 'Reset to default',
      unwireHint: 'Web search goes back to the DeepSeek official endpoint and the DeepSeek API key.',
      unwireApiHint: 'The new search goes back to the DeepSeek official Search API endpoint and credential, and web fetch goes back to the DeepSeek Fetch API.',
      wired: 'Wired: web search now uses the endpoint and placeholder credential of this plugin.',
      wiredNative: 'Web search now uses Tavily.',
      unwiredNative: 'The default web search provider has been restored.',
      wiredApi: 'Wired: the new Web Search API now uses the search endpoint of this plugin.',
      unwired: 'Web-search endpoint and credential reset to default.',
      unwiredApi: 'The new Search API endpoint and credential reset to default.',
      purgeTitle: 'Clear plugin data',
      purgeHint: 'Before uninstalling, use this to delete saved Tavily API keys and disconnect Tavily from web search.',
      purge: 'Clear plugin data',
      purging: 'Clearing…',
      purgeConfirmTitle: 'Clear plugin data?',
      purgeConfirmKeys: 'Delete {count} Tavily API key(s) from the credential store. This cannot be undone.',
      purgeConfirmWeb: 'Disconnect this plugin from web search.',
      purgeConfirm: 'Clear',
      purgeKeysRemoved: 'Deleted {count} API key(s).',
      purgeWebRestored: 'Tavily disconnected from web search.',
      purgeKeysFailed: '{count} key(s) could not be deleted: {reason}',
      purgeWebFailed: 'Could not reset the web-search endpoint: {reason}',
      purgeSkipped: '{count} key(s) come from read-only sources such as environment variables; remove them there.',
      purgeDone: 'You can now uninstall this plugin on the Plugins page.',
      webReadOnly: 'This deployment stores settings read-only.',
      writeRejected: 'The host did not accept the change.',
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
      updateUnsupported: 'This DSH version lacks the official plugin update API. Upgrade DSH or reinstall the exact version below from the Plugins page.',
      updateLinked: 'This plugin is installed from a local directory. Update its source and run the installer again.',
      updateManaged: 'This installation is managed by DSH. Update it through the host.',
      updateRunning: 'Updating…',
      updateCheckingTarget: 'Checking the target version…',
      updateManagerFailed: 'Official plugin manager check failed: {reason}',
      updateSucceeded: 'Updated to v{version}.',
      updateRestartHint: 'Restart DSH to apply it.',
      updateRestoreFailed: 'Restoring the previous version failed: {reason}. Check and reinstall on the Plugins page.',
      updateFailed: 'Update failed: {reason}',
      updateInUse: 'DSH cannot remove this plugin while it runs (bundle-in-use). Nothing new was installed and the current version keeps running. Reinstall the exact version below by hand.',
      updateReselectFailed: 'When DSH refused the removal it had already taken this plugin off the enabled list, and putting it back failed: {reason}. Enable the plugin again on the Plugins page before restarting DSH.',
      updateNoCompatible: 'The official plugin manager offers no compatible stable update.',
      updateNotUpdatable: 'The official plugin manager cannot update this installation. Check its source on the Plugins page.',
      updatePinnedInstall: 'Install a specific version',
      updatePinnedHint: 'Copy the package and version below first. On this plugin\'s Plugins page, turn off the “Tavily web search” component, then uninstall the plugin (DSH refuses to uninstall it while it runs), paste it into Add plugin, and turn the component back on. An exact version prevents latest from selecting an older release during the release-age wait. Keep the plugin data, then restart DSH after installation.',
      updateCopySpec: 'Copy package and version',
      updateSpecCopied: 'Copied {spec}. Uninstall on the Plugins page, then add this exact version.',
      updateSpecCopyFailed: 'Could not copy. Select the package and version and copy it manually.',
      updateCancelled: 'Update cancelled.',
      updateRolledBack: 'Update rolled back; the plugin stays at v{version}.',
      updateUnknown: 'The update outcome could not be confirmed. Check the installed version on the Plugins page before retrying.',
      updateRemoving: 'Removing the previous version…',
      updateInstalling: 'Installing the new version…',
      updateRestoring: 'Restoring the previous version…',
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

    /** 官方管理结果 → 一句可展示的原因：管理错误的诊断，其次 pnpm 失败分类，最后是应用状态本身。 */
    function managementReason(result) {
      return result?.error?.diagnostic ?? result?.error?.code ?? result?.packageResult?.kind ?? result?.application ?? 'invalid response';
    }

    /**
     * 官方管理结果里算作"已装上"的应用状态：立即生效、等重启生效，
     * 以及 overridden（已写入 profile，只是启用状态被更高优先级的配置层盖住）。
     */
    const APPLIED_STATES = new Set(['applied', 'restart-required', 'overridden']);
    /** 宿主拒绝卸载运行中插件时的错误码。 */
    const IN_USE = 'bundle-in-use';

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
          state: restoredOK ? 'rolled-back' : 'failed',
          installedVersion: restored.version,
          failure: { message: managementReason(result) },
          restoreFailure: restoredOK ? undefined : managementReason(restored),
          outcome: { restartRequired: restored.application === 'restart-required' },
        };
      }
      if (application === 'cancelled') return { state: 'cancelled' };
      // removeBundle 先把本插件移出启用列表并热重载，重载后本插件仍在运行才拒绝：什么都没装，旧版本照常运行，
      // 但启用状态已被移出（见 reselect）。
      if (value?.step === 'remove' && result?.error?.code === IN_USE) {
        return { state: 'failed', inUse: true, failure: { message: managementReason(result) } };
      }
      if (value?.step === 'install' && APPLIED_STATES.has(application) && result.version === target) {
        return {
          state: 'succeeded',
          installedVersion: result.version,
          outcome: { restartRequired: application === 'restart-required' },
        };
      }
      // 宿主明确报 failed 时原因可信；其余情况（版本不符、停在卸载步骤等）说不清实际装了什么，提示去核对
      return { state: 'failed', failure: { message: managementReason(result) }, unknown: application !== 'failed' };
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
     * 官方插件管理器的 Remote 命名空间。cordis 不允许读未声明的服务：connectPluginManager 接上之前，
     * 这里取值会抛错（命名空间存在也一样），当作没有。
     */
    function pluginManagerOf(remote) {
      try {
        return remote?.pluginManager;
      } catch {
        return undefined;
      }
    }

    /**
     * 把官方插件管理器接到更新器上。不写进顶层 inject：旧宿主没有这个命名空间也要能加载卡片。
     * 动态 inject 等命名空间就绪后给出声明过依赖的 remote，只有它读得到 pluginManager。
     */
    function connectPluginManager(ctx, updater) {
      ctx.inject(['remote.pluginManager'], (scoped) => {
        updater.connect(scoped.remote);
        scoped.effect(() => () => updater.connect(undefined));
      });
    }

    /**
     * 「插件更新」的共享状态与动作，随插件生命周期存在：两处卡片共用一份，卡片挂卸只增减订阅，
     * 不会打断进行中的更新，也不会重复提交。
     *
     * 更新资格、目标版本、注册表、安装与失败恢复都由宿主确定。页面重载后重新读取实际安装状态。
     */
    function createPluginUpdater(initialRemote) {
      // connectPluginManager 换成声明过 pluginManager 的 remote；事件订阅两者都能用。
      let remote = initialRemote;
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
          // 官方更新的资格由插件列表决定；旧宿主只用列表解释安装来源。
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
          && !item.deprecated && !item.incompatible && pinnedInstallSpec(item.version));
        const value = { installedVersion: list.installed, candidate: candidate?.version, registry: list.registry };
        versionList = { installed: state.installedVersion, at: Date.now(), value };
        return value;
      };

      /**
       * 检查版本与官方更新资格。quiet 给宿主的插件变更广播用：不把区块切成"正在检查"，只静默重读，
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
          })
          .finally(() => {
            checking = undefined;
          });
        return checking;
      };

      /**
       * 宿主卸载前会先把本插件移出启用列表，拒绝时不撤回；不补回的话下次启动 DSH 本插件就不加载了。
       * 只在确实被移出时才动；返回补回失败的原因，成功或无需补回时返回 undefined。
       */
      const reselect = async (manager) => {
        try {
          const bundles = unwrap(await manager.listBundles());
          const bundle = Array.isArray(bundles) ? bundles.find((item) => item.name === PACKAGE_NAME) : undefined;
          if (!bundle || bundle.enabled !== false) return undefined;
          if (typeof manager.setBundleEnabled !== 'function') return 'setBundleEnabled unavailable';
          const result = unwrap(await manager.setBundleEnabled(PACKAGE_NAME, true));
          return APPLIED_STATES.has(result?.application) ? undefined : managementReason(result);
        } catch (error) {
          return errorText(error);
        }
      };

      const startOfficial = (target, registry) => {
        const requestId = updateRequestId();
        // 更新途中本插件可能被宿主卸载，动态 inject 随之撤下，重新读接口会抛错；引用先留住，补回启用状态要靠它。
        const manager = pluginManagerOf(remote);
        patch({
          busy: true,
          operation: { state: 'running', step: 'checking', requestId },
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
            const answer = await manager.updateBundle(PACKAGE_NAME, target, { registry, requestId });
            const operation = officialOutcome(unwrap(answer), target);
            if (operation.inUse) {
              const reason = await reselect(manager);
              if (reason) operation.reselectFailure = reason;
            }
            const installedVersion = operation.installedVersion ?? snapshot.manager.installedVersion;
            patch({ operation, manager: { ...snapshot.manager, installedVersion } });
          } catch (error) {
            // 连接断开不等于宿主取消了安装；不冒充成功，也不自动重试写操作
            patch({ operation: { state: 'failed', failure: { message: errorText(error) }, unknown: true } });
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

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        check: (force = false) => run(force, false),
        refresh: () => run(false, true),
        /** 换用声明过 pluginManager 的 remote；撤下时只换回来，下次检查自然读到。 */
        connect: (scoped) => {
          remote = scoped ?? initialRemote;
          // 还没检查过时不用动，第一次检查自然读到新接口；检查进行中时 run 会直接返回，要等它结束再重读。
          if (scoped && (checking || snapshot.manager.phase !== 'loading')) {
            Promise.resolve(checking).catch(() => {}).then(() => run(false, true));
          }
        },
        startUpdate: () => {
          if (disposed) return Promise.resolve();
          if (updating) return updating;
          const { manager } = snapshot;
          if (!checking && manager.phase === 'ready' && manager.candidate) {
            return startOfficial(manager.candidate, manager.registry);
          }
          return Promise.resolve();
        },
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

    /** npm 的安装规格用不带 v 的明确版本；拒绝标签、范围和其它安装来源。 */
    function pinnedInstallSpec(version) {
      if (typeof version !== 'string') return undefined;
      const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(version.trim());
      return match ? `${PACKAGE_NAME}@${match[1]}` : undefined;
    }

    /** 有新版本却没有一键更新时，说明原因的文案 key。 */
    function updateBlockerKey(manager) {
      if (manager.local) return 'updateLinked';
      if (manager.managed) return 'updateManaged';
      if (manager.phase === 'blocked') return 'updateNotUpdatable';
      if (manager.phase === 'ready') return 'updateNoCompatible';
      if (manager.phase === 'unsupported') return 'updateUnsupported';
      return undefined;
    }

    /**
     * 「插件更新」区块只为宿主确认兼容的正式版提供一键更新。
     */
    function renderUpdateSection(update, actions, t) {
      const { version, manager, operation } = update;
      const running = update.busy === true;
      const ready = version.phase === 'ready';
      // 当前运行版本要等重启 / 刷新才换，所以按实际安装版本判断是否已装上最新版；
      // 镜像落后或再查到更高版本时，仍需提供更新入口。
      const installed = operation?.state === 'succeeded' ? operation.installedVersion : manager.installedVersion;
      const latestInstalled = ready && Boolean(installed) && !versionBelow(installed, version.latestVersion);
      const outdated = ready && version.updateAvailable && !latestInstalled;

      // 更新目标以宿主返回的兼容版本为准，npm 镜像滞后时也能更新。
      const candidate = manager.phase === 'ready' ? manager.candidate : undefined;
      const target = candidate && (!installed || versionBelow(installed, candidate)) ? candidate : undefined;

      const head = [h('span', { key: 'title', className: 'dsm-tv-section-title' }, t('updateTitle'))];
      if (ready) {
        const pending = latestInstalled && operation?.state === 'succeeded' ? operation.outcome : undefined;
        const tone = pending?.restartRequired
          ? { kind: 'warn', text: t('updatePendingRestart') }
          : target || outdated
            ? { kind: 'warn', text: t('updateAvailable') }
            : { kind: 'ok', text: t('updateUpToDate') };
        head.push(badge('badge', tone.kind, tone.text));
      }
      const checkBusy = version.phase === 'loading' || manager.phase === 'loading';
      head.push(button('check', 'outline', t('updateCheck'), actions.checkUpdate, checkBusy || running));
      if (target) {
        head.push(
          button('update', 'primary', running ? t('updateRunning') : t('updateNow', { version: target }), actions.startUpdate, running),
        );
      }

      const section = [h('div', { key: 'head', className: 'dsm-tv-section-head' }, head)];
      if (version.phase === 'loading') {
        section.push(h('p', { key: 'checking', className: 'dsm-tv-line' }, t('updateChecking')));
      } else if (version.phase === 'error') {
        section.push(notice('checkError', { kind: 'error', text: t('updateCheckFailed', { reason: version.reason }) }));
      }
      if (version.currentVersion) {
        section.push(
          h(
            'p',
            { key: 'versions', className: 'dsm-tv-line' },
            t('updateCurrent'),
            h('span', { className: 'dsm-tv-code' }, `v${version.currentVersion}`),
            ready ? '  ·  ' : null,
            ready ? t('updateLatestVersion') : null,
            ready ? h('span', { className: 'dsm-tv-code' }, `v${version.latestVersion}`) : null,
          ),
        );
      }
      if (manager.phase === 'error') {
        section.push(notice('managerError', { kind: 'error', text: t('updateManagerFailed', { reason: manager.reason }) }));
      }
      // 只在确实有新版本时说明为什么没有一键更新；已是最新时不打扰
      const blocker = outdated && !target && !operation ? updateBlockerKey(manager) : undefined;
      if (blocker) section.push(h('p', { key: 'unavailable', className: 'dsm-tv-hint' }, t(blocker)));

      if (operation?.state === 'running') {
        section.push(h('p', { key: 'progress', className: 'dsm-tv-line' }, t(UPDATE_STEPS[operation.step] ?? 'updateRunning')));
      } else if (operation?.state === 'succeeded') {
        const parts = [t('updateSucceeded', { version: operation.installedVersion })];
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        section.push(notice('done', { kind: 'ok', text: parts.join(' ') }));
      } else if (operation?.state === 'failed' && operation.inUse) {
        section.push(notice('inUse', { kind: 'error', text: t('updateInUse') }));
        if (operation.reselectFailure) {
          section.push(notice('reselectFailed', { kind: 'error', text: t('updateReselectFailed', { reason: operation.reselectFailure }) }));
        }
      } else if (operation?.state === 'failed') {
        section.push(notice('failed', { kind: 'error', text: t('updateFailed', { reason: operation.failure?.message ?? '' }) }));
        if (operation.restoreFailure) {
          section.push(notice('restoreFailed', { kind: 'error', text: t('updateRestoreFailed', { reason: operation.restoreFailure }) }));
        }
        if (operation.unknown) section.push(notice('unknown', { kind: 'error', text: t('updateUnknown') }));
      } else if (operation?.state === 'cancelled') {
        section.push(notice('cancelled', { kind: 'error', text: t('updateCancelled') }));
      } else if (operation?.state === 'rolled-back') {
        const parts = [];
        if (operation.failure?.message) parts.push(t('updateFailed', { reason: operation.failure.message }));
        parts.push(t('updateRolledBack', { version: operation.installedVersion }));
        if (operation.outcome?.restartRequired) parts.push(t('updateRestartHint'));
        section.push(notice('rolledBack', { kind: 'error', text: parts.join(' ') }));
      }

      const spec = outdated ? pinnedInstallSpec(version.latestVersion) : undefined;
      // 缺少接口、查询失败或运行中卸载受阻时，可在 DSH 插件页手动重装。
      const unsupported = manager.phase === 'unsupported';
      if (spec && !running && !manager.local && !manager.managed && (unsupported || manager.phase === 'error' || operation?.inUse)) {
        section.push(
          h(
            'details',
            { key: 'pinnedInstall', open: unsupported || operation?.inUse === true },
            h('summary', { className: 'dsm-tv-line' }, t('updatePinnedInstall')),
            h('p', { className: 'dsm-tv-hint' }, t('updatePinnedHint')),
            h('input', {
              className: 'dsm-tv-input dsm-tv-install-spec',
              type: 'text',
              readOnly: true,
              value: spec,
              'aria-label': t('updatePinnedInstall'),
              onFocus: (event) => event.currentTarget.select(),
            }),
            h('div', { className: 'dsm-tv-toolbar' }, button('copySpec', 'outline', t('updateCopySpec'), actions.copyInstallSpec, false)),
          ),
        );
      }
      section.push(notice('updateNotice', update.notice));
      return section;
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

    /** 列表里一个 key 的称呼：有末 4 位就用 `…abcd`，否则用引用名。 */
    function keyName(slot) {
      return slot.tail ? `…${slot.tail}` : slot.ref;
    }

    /**
     * 「API Key」区块：已配置的 key 逐个列出、各自可删（带二次确认），下面一个输入框往空槽位添加。
     *
     * @param {{ keys: object, draft: string, keyBusy?: string, confirmRemove?: string, keyNotice?: object }} model
     *   keys.slots 来自宿主 keys 路由；keyBusy 为 'add' 或正在删除的那个引用名
     */
    function renderKeySection(model, actions, t) {
      const { keys } = model;
      const slots = Array.isArray(keys.slots) ? keys.slots : [];
      const configured = slots.filter((slot) => slot.configured);
      const busy = Boolean(model.keyBusy);
      // 添加到第一个空着且可写的槽位：删掉中间某个后，下次添加正好补回那个空位
      const free = slots.find((slot) => !slot.configured && slot.writable !== false);

      const head = [h('span', { key: 'title', className: 'dsm-tv-section-title' }, t('keyTitle'))];
      if (keys.phase === 'ready') {
        head.push(
          configured.length > 0 ? badge('count', 'ok', t('keyCount', { count: configured.length })) : badge('count', 'warn', t('keyUnset')),
        );
      }
      const section = [h('div', { key: 'head', className: 'dsm-tv-section-head' }, head)];

      if (keys.phase === 'loading' && slots.length === 0) {
        section.push(h('p', { key: 'loading', className: 'dsm-tv-line' }, t('keyLoading')));
      } else if (keys.phase === 'error') {
        section.push(notice('keyError', { kind: 'error', text: t('keyLoadFailed', { reason: keys.reason }) }));
      }

      if (configured.length > 0) {
        const rows = configured.map((slot) => {
          const name = keyName(slot);
          const row = [
            h(
              'div',
              { key: 'main', className: 'dsm-tv-keyrow-main' },
              h('span', { className: 'dsm-tv-keyrow-index' }, `#${slots.indexOf(slot) + 1}`),
              h('span', { className: 'dsm-tv-code' }, name),
              slot.tail ? h('span', { className: 'dsm-tv-keyrow-ref' }, slot.ref) : null,
            ),
          ];
          if (slot.writable === false) {
            row.push(h('span', { key: 'readOnly', className: 'dsm-tv-keyrow-ref' }, t('keyReadOnly')));
          } else {
            const label = model.keyBusy === slot.ref ? t('removing') : t('remove');
            row.push(button('remove', 'danger', label, () => actions.askRemove(slot.ref), busy || model.confirmRemove === slot.ref));
          }
          if (model.confirmRemove === slot.ref) {
            row.push(
              h(
                'div',
                { key: 'confirm', className: 'dsm-tv-confirm' },
                h('div', { className: 'dsm-tv-line' }, h('strong', null, t(configured.length === 1 ? 'removeLastTitle' : 'removeTitle', { name }))),
                h(
                  'div',
                  { className: 'dsm-tv-toolbar' },
                  button('cancel', 'outline', t('cancel'), actions.cancelRemove, busy),
                  button('confirm', 'danger', t('removeConfirm'), () => actions.removeKey(slot.ref), busy),
                ),
              ),
            );
          }
          return h('li', { key: slot.ref, className: 'dsm-tv-keyrow' }, row);
        });
        section.push(h('ul', { key: 'list', className: 'dsm-tv-keys' }, rows));
      }
      if (configured.length > 1) section.push(h('p', { key: 'rotate', className: 'dsm-tv-hint' }, t('keyRotate')));

      // 槽位列表还没读到时不知道该写哪个引用，先禁用添加
      const canAdd = keys.phase === 'ready' && Boolean(free);
      section.push(
        h(
          'div',
          { key: 'field', className: 'dsm-tv-key' },
          h(SecretField, {
            id: 'dsh-tavily-search-key',
            label: t('keyAddLabel'),
            hint: free ? t('keyAddHint', { ref: free.ref }) : keys.phase === 'ready' ? t('keyFull', { max: slots.length }) : '',
            disabled: !canAdd || busy,
            text: model.draft,
            configured: false,
            stateLabel: free ? free.ref : '',
            onEdit: actions.editDraft,
          }),
        ),
        h(
          'div',
          { key: 'toolbar', className: 'dsm-tv-toolbar' },
          button('add', 'primary', model.keyBusy === 'add' ? t('adding') : t('add'), () => actions.addKey(free?.ref), !model.draft.trim() || busy || !canAdd),
        ),
      );
      section.push(notice('keyNotice', model.keyNotice));
      return section;
    }

    /**
     * 网页搜索设置里哪些用户层覆盖是本插件写的。只撤销这两种：接口地址覆盖成本插件端点、
     * 凭据引用覆盖成本插件的占位引用；默认值或别人改的值不归本插件管。
     * @param form - webModel() 的表单快照（web-search-deepseek 或 web-deepseek-api）
     * @param endpoint - 该协议下本插件的接口地址
     */
    function webOwnership(form, endpoint) {
      const ready = form?.phase === 'ready' && form.writable !== false;
      return {
        web: ready && form.overridden === true && sameEndpoint(form.baseURL, endpoint),
        webKeyRef: ready && form.keyRefOverridden === true && form.apiKeyEnv === WEB_SEARCH_SHIM_REF,
      };
    }

    /**
     * 两套协议里本插件写过的覆盖。恢复默认与「清除插件数据」都按这里判断，
     * 避免旧接入（Messages）与新接入（Search API）只清掉一半。
     */
    function ownershipOf(model, endpoint, apiEndpoint) {
      const messages = webOwnership(model.web, endpoint);
      const native = model.status?.nativeProvider === NATIVE_SEARCH_PROVIDER;
      // 新宿主忽略旧版 Search API 的 baseURL / apiKeyEnv，且搜索和获取是独立选择。
      const searchApi = webOwnership(native ? undefined : model.api, apiEndpoint);
      const selection = model.selection;
      const restoreNative =
        selection?.searchProvider === NATIVE_SEARCH_PROVIDER && selection.base?.searchProvider !== NATIVE_SEARCH_PROVIDER;
      const ownsAny = messages.web || messages.webKeyRef || searchApi.web || searchApi.webKeyRef;
      return {
        messages,
        api: searchApi,
        any: ownsAny || restoreNative,
        restoreNative,
        deletePlaceholder: messages.webKeyRef || searchApi.webKeyRef,
        // 新版接入时本插件把抓取从 deepseek-fetch-api 改成了本地 HTTP；恢复时改回开关配对值
        restoreFetch:
          !native && ownsAny &&
          selection?.phase === 'ready' &&
          selection.searchProvider === API_SEARCH_PROVIDER &&
          selection.fetchProvider === HTTP_FETCH_PROVIDER,
      };
    }

    /**
     * 写一个设置命名空间的几个字段。宿主表单有 mutate 时一次原子提交，避免接口地址和凭据引用只改了一半；
     * 没有时退回逐个 set / unset，遇到被拒就停。
     */
    async function writeWebFields(form, ops) {
      if (typeof form.mutate === 'function') return form.mutate(ops);
      for (const op of ops) {
        const accepted = await (op.op === 'set' ? form.set(op.path[0], op.value) : form.unset(op.path[0]));
        if (accepted === false) return false;
      }
      return true;
    }

    /** `web` 命名空间里"目标值等于部署默认就清覆盖，否则显式写"的 op（与宿主网页搜索页的写法一致）。 */
    function providerOp(selection, field, target) {
      return selection.base?.[field] === target
        ? { op: 'unset', path: [field] }
        : { op: 'set', path: [field], value: target };
    }

    /**
     * 接入时 `web` 命名空间要写的提供方：
     *   - 接新版 API：确保 searchProvider 是 deepseek-search-api；抓取提供方若正指向
     *     deepseek-fetch-api（开关配对写入的），改成本地 HTTP —— 本插件只提供搜索；
     *   - 接旧版 Messages：搜索提供方被别的 id 占着时按宿主关开关的写法改回 deepseek-official。
     * 已是目标值时返回空数组，不写。
     */
    function selectionWireOps({ selection, mode }) {
      if (selection?.phase !== 'ready') return [];
      const ops = [];
      const wantSearch = mode === 'api' ? API_SEARCH_PROVIDER : MESSAGES_SEARCH_PROVIDER;
      if (selection.searchProvider !== wantSearch) ops.push(providerOp(selection, 'searchProvider', wantSearch));
      if (mode === 'api') {
        if (selection.fetchProvider === API_FETCH_PROVIDER) ops.push(providerOp(selection, 'fetchProvider', HTTP_FETCH_PROVIDER));
      } else if (selection.searchProvider === API_SEARCH_PROVIDER && selection.fetchProvider === API_FETCH_PROVIDER) {
        ops.push(providerOp(selection, 'fetchProvider', HTTP_FETCH_PROVIDER));
      }
      return ops;
    }

    /**
     * 接入：先确保占位凭据有值，再把目标协议的接口地址与凭据引用一起改指向本插件，
     * 最后切提供方（与宿主网页搜索页的保存顺序一致，避免中间时刻打到 DeepSeek 官方接口）。
     * 占位凭据已有值时不覆盖——配了 shimApiKey 的用户会在内置网页搜索页把它改成真正的校验值。
     *
     * @param api - 卡片拿到的宿主能力（见 apply 里的 api 对象）
     * @param {{mode: 'native'|'messages'|'api', endpoint: string, apiEndpoint: string, selection: object}} options
     *   mode 是这次要接的协议，不是当前正在用的协议：网页提供方被别的插件占用时，卡片优先接新版 API。
     */
    async function wireWebSearch(api, { mode, endpoint, apiEndpoint, selection }) {
      if (mode === 'native') {
        if (!api.selectionForm || selection?.phase !== 'ready' || selection.writable === false) return false;
        if (selection.searchProvider === NATIVE_SEARCH_PROVIDER) return true;
        return writeWebFields(api.selectionForm, [providerOp(selection, 'searchProvider', NATIVE_SEARCH_PROVIDER)]);
      }
      const form = mode === 'api' ? api.apiForm : api.webForm;
      if (!form) return false;
      const target = mode === 'api' ? apiEndpoint : endpoint;
      const views = unwrap(await api.describe([WEB_SEARCH_SHIM_REF]));
      if (views?.[WEB_SEARCH_SHIM_REF]?.configured !== true) {
        unwrap(await api.setKey(WEB_SEARCH_SHIM_REF, WEB_SEARCH_SHIM_VALUE));
      }
      const accepted = await writeWebFields(form, [
        { op: 'set', path: ['apiKeyEnv'], value: WEB_SEARCH_SHIM_REF },
        { op: 'set', path: ['baseURL'], value: target },
      ]);
      if (accepted === false) return false;
      const ops = selectionWireOps({ selection, mode });
      if (ops.length === 0 || !api.selectionForm) return true;
      return writeWebFields(api.selectionForm, ops);
    }

    /** 把 `web` 命名空间的快照翻成卡片关心的几项；没下发（旧版 DSH）时 phase 为 unavailable。 */
    function selectionModel(snapshot) {
      if (!snapshot || snapshot.status === 'loading') return { phase: 'loading' };
      if (snapshot.status !== 'ready') return { phase: 'unavailable' };
      const text = (source, field) => (typeof source?.[field] === 'string' && source[field] ? source[field] : undefined);
      return {
        phase: 'ready',
        searchProvider: text(snapshot.value, 'searchProvider'),
        fetchProvider: text(snapshot.value, 'fetchProvider'),
        base: { searchProvider: text(snapshot.base, 'searchProvider'), fetchProvider: text(snapshot.base, 'fetchProvider') },
        writable: snapshot.writable !== false,
      };
    }

    /**
     * 当前搜索走哪套协议：
     *   api      网页搜索页打开了「启用新版 Web 搜索 API」（searchProvider = deepseek-search-api）；
     *   messages 旧版 Messages 搜索（searchProvider 未配置或 deepseek-official；旧版 DSH 也走这里）；
     *   other    搜索提供方被别的插件占用。
     */
    function webMode(selection) {
      if (selection?.phase !== 'ready') return 'messages';
      const provider = selection.searchProvider;
      if (provider === API_SEARCH_PROVIDER) return 'api';
      if (provider === undefined || provider === MESSAGES_SEARCH_PROVIDER) return 'messages';
      return 'other';
    }

    /**
     * 当前通道的接入状态。区块徽标、头部状态与页签提醒共用这一份判断，三处不会说法不一。
     * 接口指向本插件还不够：凭据引用也得是本插件的占位引用且有值，搜索才会真的发请求；
     * 新版通道的抓取提供方还是 deepseek-fetch-api 时，抓取请求会被送到本插件（本插件只提供搜索）。
     * @returns 表单还没就绪时 undefined；否则 tone / label（文案 key）与各分项结论。
     */
    function wiringOf(model, endpoint, apiEndpoint) {
      if (model.status?.nativeProvider === NATIVE_SEARCH_PROVIDER) {
        if (model.selection?.phase !== 'ready') return undefined;
        const complete = model.selection.searchProvider === NATIVE_SEARCH_PROVIDER;
        return { complete, tone: complete ? 'ok' : 'warn', label: complete ? 'webWired' : 'webNotWired' };
      }
      const mode = webMode(model.selection);
      const form = mode === 'api' ? (model.api ?? { phase: 'unavailable' }) : model.web;
      if (form.phase !== 'ready') return undefined;
      if (mode === 'other') return { tone: 'warn', label: 'webBypassed' };
      const wired = sameEndpoint(form.baseURL, mode === 'api' ? apiEndpoint : endpoint);
      const keyIsolated = form.apiKeyEnv === WEB_SEARCH_SHIM_REF;
      const fetchNeedsRepair = mode === 'api' && model.selection.fetchProvider === API_FETCH_PROVIDER;
      const complete = wired && keyIsolated && form.keyConfigured !== false && !fetchNeedsRepair;
      return {
        wired,
        keyIsolated,
        fetchNeedsRepair,
        complete,
        tone: complete ? 'ok' : 'warn',
        label: complete ? 'webWired' : wired ? 'webNeedsRepair' : 'webNotWired',
      };
    }

    /** 单个协议要撤销的字段 ops：只撤销本插件写的覆盖。 */
    function fieldRestoreOps(owned) {
      const ops = [];
      if (owned.web) ops.push({ op: 'unset', path: ['baseURL'] });
      if (owned.webKeyRef) ops.push({ op: 'unset', path: ['apiKeyEnv'] });
      return ops;
    }

    /**
     * 恢复默认：只撤销 ownershipOf 标出的本插件写的覆盖（两套协议都看），凭据引用恢复后
     * 占位凭据没人读了就顺手删掉；新版接入还把抓取提供方改回开关配对值。
     * 删不掉占位凭据不影响恢复结果（它只是个占位串）。
     * @returns 宿主是否接受；没有要撤销的覆盖时返回 undefined。
     */
    async function restoreWebSearch(api, owned, selection) {
      if (owned.restoreNative) {
        if (!api.selectionForm || selection?.phase !== 'ready' || selection.writable === false) return false;
        const latest = api.selectionForm.getSnapshot?.();
        const current = latest ? selectionModel(latest) : selection;
        if (current.phase !== 'ready' || current.writable === false) return false;
        if (current.searchProvider === NATIVE_SEARCH_PROVIDER && current.base?.searchProvider !== NATIVE_SEARCH_PROVIDER) {
          if (await writeWebFields(api.selectionForm, [{ op: 'unset', path: ['searchProvider'] }]) === false) return false;
        }
      }
      const tasks = [];
      if (api.webForm && (owned.messages?.web || owned.messages?.webKeyRef)) {
        tasks.push({ form: api.webForm, ops: fieldRestoreOps(owned.messages) });
      }
      if (api.apiForm && (owned.api?.web || owned.api?.webKeyRef)) {
        tasks.push({ form: api.apiForm, ops: fieldRestoreOps(owned.api) });
      }
      let accepted = true;
      for (const task of tasks) {
        if ((await writeWebFields(task.form, task.ops)) === false) accepted = false;
      }
      if (accepted && owned.restoreFetch && api.selectionForm && selection?.phase === 'ready') {
        const result = await writeWebFields(api.selectionForm, [providerOp(selection, 'fetchProvider', API_FETCH_PROVIDER)]);
        if (result === false) accepted = false;
      }
      if (accepted && owned.deletePlaceholder) {
        try {
          unwrap(await api.unsetKey(WEB_SEARCH_SHIM_REF));
        } catch {
          // 占位值留在凭据库里无害
        }
      }
      if (tasks.length === 0 && !owned.restoreFetch && !owned.restoreNative) return undefined;
      return accepted;
    }

    /**
     * 「清除插件数据」要清的东西：卡片能删的 key，以及网页搜索里本插件写的覆盖
     * （两套协议 + 抓取提供方，见 ownershipOf）。只读来源的 key 删不掉，单独计数提示。
     */
    function purgeTargets(model, endpoint, apiEndpoint) {
      const slots = Array.isArray(model.keys?.slots) ? model.keys.slots : [];
      return {
        refs: slots.filter((slot) => slot.configured && slot.writable !== false).map((slot) => slot.ref),
        readOnly: slots.filter((slot) => slot.configured && slot.writable === false).length,
        owned: ownershipOf(model, endpoint, apiEndpoint),
        selection: model.selection,
      };
    }

    /**
     * 执行清除：逐个删 key（走与「删除」按钮同一条 remote.credentials.unset），再恢复网页搜索接口与凭据引用。
     * 单个失败不打断其余步骤，结果汇总给卡片提示。
     */
    async function purgePluginData({ api, targets }) {
      const removed = [];
      const failed = [];
      for (const ref of targets.refs) {
        try {
          unwrap(await api.unsetKey(ref));
          removed.push(ref);
        } catch (error) {
          failed.push({ ref, reason: errorText(error) });
        }
      }
      const owned = targets.owned ?? {};
      let restored = false;
      let restoreError;
      if (owned.any || owned.restoreFetch) {
        try {
          const accepted = await restoreWebSearch(api, owned, targets.selection);
          if (accepted === false) restoreError = 'rejected';
          else restored = true;
        } catch (error) {
          restoreError = errorText(error);
        }
      }
      return { removed, failed, restored, restoreError, readOnly: targets.readOnly };
    }

    /** 把清除结果拼成一条提示；有任何一步失败就用错误色。 */
    function purgeNoticeOf(result, t) {
      const parts = [];
      if (result.removed.length > 0) parts.push(t('purgeKeysRemoved', { count: result.removed.length }));
      if (result.restored) parts.push(t('purgeWebRestored'));
      if (result.failed.length > 0) {
        parts.push(t('purgeKeysFailed', { count: result.failed.length, reason: result.failed.map((item) => `${item.ref}: ${item.reason}`).join('; ') }));
      }
      if (result.restoreError) {
        parts.push(t('purgeWebFailed', { reason: result.restoreError === 'rejected' ? t('writeRejected') : result.restoreError }));
      }
      if (result.readOnly > 0) parts.push(t('purgeSkipped', { count: result.readOnly }));
      const ok = result.failed.length === 0 && !result.restoreError;
      if (ok) parts.push(t('purgeDone'));
      return { kind: ok ? 'ok' : 'error', text: parts.join(' ') };
    }

    /** 「清除插件数据」区块：没东西可清（也没有待显示的结果）时整块不出现。 */
    function renderPurgeSection(model, actions, t, { endpoint, apiEndpoint }) {
      const targets = purgeTargets(model, endpoint, apiEndpoint);
      const hasWork = targets.refs.length > 0 || targets.owned.any || targets.owned.restoreFetch;
      if (!hasWork && !model.purgeNotice) return null;
      const busy = Boolean(model.purgeBusy);
      const section = [
        h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t('purgeTitle')),
          hasWork ? button('purge', 'danger', busy ? t('purging') : t('purge'), actions.askPurge, busy || model.confirmPurge === true) : null,
        ),
      ];
      if (hasWork) section.push(h('p', { key: 'hint', className: 'dsm-tv-hint' }, t('purgeHint')));
      if (hasWork && model.confirmPurge === true) {
        section.push(
          h(
            'div',
            { key: 'confirm', className: 'dsm-tv-confirm' },
            h('div', { className: 'dsm-tv-line' }, h('strong', null, t('purgeConfirmTitle'))),
            targets.refs.length > 0 ? h('p', { className: 'dsm-tv-hint' }, t('purgeConfirmKeys', { count: targets.refs.length })) : null,
            targets.owned.any || targets.owned.restoreFetch ? h('p', { className: 'dsm-tv-hint' }, t('purgeConfirmWeb')) : null,
            h(
              'div',
              { className: 'dsm-tv-toolbar' },
              button('cancel', 'outline', t('cancel'), actions.cancelPurge, busy),
              button('confirm', 'danger', t('purgeConfirm'), () => actions.purge(targets), busy),
            ),
          ),
        );
      }
      section.push(notice('purgeNotice', model.purgeNotice));
      return section;
    }

    /**
     * 纯渲染：view model + 动作 → 元素树。与 hooks 分开，测试可以直接喂各种状态断言输出。
     *
     * @param {object} model 见 TavilyCard 里的组装
     * @param {Record<string, Function>} actions
     * @param {(key: string, params?: object) => string} t
     */
    function renderCard(model, actions, t) {
      const { status, web, test } = model;
      const native = status.nativeProvider === NATIVE_SEARCH_PROVIDER;
      const endpoint = status.endpoint ?? DEFAULT_ENDPOINT;
      /** 新版 Search API 的基础地址（宿主 /status 下发；拿不到时按同端口推算，与 lib/config.js 一致）。 */
      const apiEndpoint = status.apiEndpoint ?? `${endpoint}/tools`;

      // ---- API Key（可以多个）----
      const keySection = renderKeySection(model, actions, t);

      // ---- 搜索接口 ----
      const state = status.server?.state;
      const [tone, label] = native ? [] : SERVER_BADGE[state] ?? [];
      const canTest = native || state === 'listening' || state === 'external';
      const serverSection = [
        h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t(native ? 'nativeTestTitle' : 'serverTitle')),
          label ? badge('badge', tone, t(label)) : null,
          button('refresh', 'outline', t('refresh'), actions.reload, status.phase === 'loading'),
          button('test', 'primary', test.busy ? t('testing') : t('test'), actions.runTest, test.busy || !canTest),
        ),
      ];
      if (!native) {
        serverSection.push(
          h('p', { key: 'endpoint', className: 'dsm-tv-line' }, t('serverEndpoint'), h('span', { className: 'dsm-tv-code' }, endpoint)),
          h('p', { key: 'apiEndpoint', className: 'dsm-tv-line' }, t('serverApiEndpoint'), h('span', { className: 'dsm-tv-code' }, apiEndpoint)),
        );
      }
      if (status.phase === 'loading') {
        serverSection.push(h('p', { key: 'loading', className: 'dsm-tv-line' }, t('statusLoading')));
      } else if (status.phase === 'error') {
        serverSection.push(notice('statusError', { kind: 'error', text: t('statusError', { reason: status.reason }) }));
      }
      if (!native && status.server?.reason) serverSection.push(h('p', { key: 'reason', className: 'dsm-tv-line' }, status.server.reason));
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
      const apiForm = model.api ?? { phase: 'unavailable' };
      const mode = webMode(model.selection);
      const wiring = wiringOf(model, endpoint, apiEndpoint);
      const webBusy = Boolean(model.webBusy);
      const busyLabel = (text) => (webBusy ? t('wiring') : text);
      const channelLabel =
        mode === 'other'
          ? t('channelOther', { provider: model.selection.searchProvider })
          : t(mode === 'api' ? 'channelApi' : 'channelMessages');
      const webSection = [h('div', { key: 'head', className: 'dsm-tv-section-head' }, h('span', { className: 'dsm-tv-section-title' }, t('webTitle')))];
      if (!native) {
        webSection.push(h('p', { key: 'channel', className: 'dsm-tv-line' }, t('webChannel'), h('span', { className: 'dsm-tv-code' }, channelLabel)));
      }

      if (native) {
        const selection = model.selection;
        const writable = selection?.phase === 'ready' && selection.writable !== false;
        const canRestore = wiring?.complete && selection.base?.searchProvider !== NATIVE_SEARCH_PROVIDER;
        webSection[0] = h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t('webTitle')),
          wiring ? badge('badge', wiring.tone, t(wiring.label)) : null,
          wiring && !wiring.complete ? button('wire', 'primary', busyLabel(t('wire')), actions.wire, webBusy || !writable) : null,
          canRestore ? button('unwire', 'outline', busyLabel(t('unwire')), actions.unwire, webBusy || !writable) : null,
        );
        webSection.push(h('p', { key: 'nativeHint', className: 'dsm-tv-hint' }, t('nativeHint')));
        if (!wiring || !writable) {
          const hint = selection?.phase === 'loading' ? 'webLoading' : selection?.phase === 'unavailable' ? 'webUnavailable' : 'webReadOnly';
          webSection.push(h('p', { key: 'selectionStatus', className: 'dsm-tv-hint' }, t(hint)));
        }
      } else if (mode === 'api') {
        if (apiForm.phase === 'unavailable') {
          webSection.push(h('p', { key: 'unavailable', className: 'dsm-tv-line' }, t('webApiUnavailable')));
        } else if (apiForm.phase !== 'ready') {
          webSection.push(h('p', { key: 'loading', className: 'dsm-tv-line' }, t('webLoading')));
        } else {
          const { wired, keyIsolated, fetchNeedsRepair, complete } = wiring;
          const owned = webOwnership(apiForm, apiEndpoint);
          const writable = apiForm.writable && (model.selection.writable !== false || !fetchNeedsRepair);
          const wireLabel = wired ? t('repair') : t('wire');
          webSection[0] = h(
            'div',
            { key: 'head', className: 'dsm-tv-section-head' },
            h('span', { className: 'dsm-tv-section-title' }, t('webTitle')),
            badge('badge', wiring.tone, t(wiring.label)),
            complete ? null : button('wire', 'primary', busyLabel(wireLabel), actions.wire, webBusy || !writable),
            wired && (owned.web || owned.webKeyRef) ? button('unwire', 'outline', busyLabel(t('unwire')), actions.unwire, webBusy || !apiForm.writable) : null,
          );
          webSection.push(
            h(
              'p',
              { key: 'current', className: 'dsm-tv-line' },
              t('webCurrentApi'),
              apiForm.baseURL ? h('span', { className: 'dsm-tv-code' }, apiForm.baseURL) : t('webDefault'),
            ),
          );
          if (!writable) {
            webSection.push(h('p', { key: 'readOnly', className: 'dsm-tv-hint' }, t('webReadOnly')));
          } else if (!wired) {
            webSection.push(h('p', { key: 'wireHint', className: 'dsm-tv-hint' }, t('wireApiHint', { endpoint: apiEndpoint, ref: WEB_SEARCH_SHIM_REF })));
          } else if (fetchNeedsRepair) {
            webSection.push(h('p', { key: 'repairHint', className: 'dsm-tv-hint' }, t('repairFetchHint', { action: wireLabel })));
          } else if (!keyIsolated) {
            webSection.push(h('p', { key: 'repairHint', className: 'dsm-tv-hint' }, t('repairRefHint', { ref: apiForm.apiKeyEnv })));
          } else if (apiForm.keyConfigured === false) {
            webSection.push(h('p', { key: 'repairHint', className: 'dsm-tv-hint' }, t('repairKeyHint', { ref: WEB_SEARCH_SHIM_REF })));
          } else if (complete && (owned.web || owned.webKeyRef)) {
            webSection.push(h('p', { key: 'unwireHint', className: 'dsm-tv-hint' }, t('unwireApiHint')));
          }
        }
      } else if (web.phase === 'unavailable') {
        webSection.push(h('p', { key: 'unavailable', className: 'dsm-tv-line' }, t('webUnavailable')));
      } else if (web.phase !== 'ready') {
        webSection.push(h('p', { key: 'loading', className: 'dsm-tv-line' }, t('webLoading')));
      } else if (mode === 'other') {
        // 搜索被别的提供方占着：接回本插件。装新版搜索插件时接新版 API，否则接回 Messages 搜索
        const wireMode = apiForm.phase === 'ready' ? 'api' : 'messages';
        const targetForm = wireMode === 'api' ? apiForm : web;
        const writable = targetForm.writable !== false && model.selection.writable !== false;
        webSection[0] = h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t('webTitle')),
          badge('badge', 'warn', t('webBypassed')),
          button('wire', 'primary', busyLabel(t('wire')), actions.wire, webBusy || !writable),
        );
        webSection.push(
          h('p', { key: 'provider', className: 'dsm-tv-line' }, t('webProvider'), h('span', { className: 'dsm-tv-code' }, model.selection.searchProvider)),
        );
        webSection.push(
          writable
            ? h('p', { key: 'bypassHint', className: 'dsm-tv-hint' }, t('bypassOtherHint', { provider: model.selection.searchProvider, action: t('wire') }))
            : h('p', { key: 'readOnly', className: 'dsm-tv-hint' }, t('webReadOnly')),
        );
      } else {
        const { wired, keyIsolated, complete } = wiring;
        const owned = webOwnership(web, endpoint);
        const writable = web.writable;
        const wireLabel = wired ? t('repair') : t('wire');
        webSection[0] = h(
          'div',
          { key: 'head', className: 'dsm-tv-section-head' },
          h('span', { className: 'dsm-tv-section-title' }, t('webTitle')),
          badge('badge', wiring.tone, t(wiring.label)),
          complete ? null : button('wire', 'primary', busyLabel(wireLabel), actions.wire, webBusy || !writable),
          wired && (owned.web || owned.webKeyRef) ? button('unwire', 'outline', busyLabel(t('unwire')), actions.unwire, webBusy || !web.writable) : null,
        );
        webSection.push(
          h(
            'p',
            { key: 'current', className: 'dsm-tv-line' },
            t('webCurrent'),
            web.baseURL ? h('span', { className: 'dsm-tv-code' }, web.baseURL) : t('webDefault'),
          ),
        );
        if (!writable) {
          webSection.push(h('p', { key: 'readOnly', className: 'dsm-tv-hint' }, t('webReadOnly')));
        } else if (!wired) {
          webSection.push(h('p', { key: 'wireHint', className: 'dsm-tv-hint' }, t('wireHint', { endpoint, ref: WEB_SEARCH_SHIM_REF })));
        } else if (!keyIsolated) {
          webSection.push(h('p', { key: 'repairHint', className: 'dsm-tv-hint' }, t('repairRefHint', { ref: web.apiKeyEnv })));
        } else if (web.keyConfigured === false) {
          webSection.push(h('p', { key: 'repairHint', className: 'dsm-tv-hint' }, t('repairKeyHint', { ref: WEB_SEARCH_SHIM_REF })));
        } else if (complete && (owned.web || owned.webKeyRef)) {
          webSection.push(h('p', { key: 'unwireHint', className: 'dsm-tv-hint' }, t('unwireHint')));
        }
      }
      webSection.push(notice('webNotice', model.webNotice));

      // ---- 清除插件数据（卸载前用）----
      const purgeSection = renderPurgeSection(model, actions, t, { endpoint, apiEndpoint });

      // ---- 头部状态与页签提醒 ----
      const activeTab = TABS.some(([id]) => id === model.tab) ? model.tab : 'keys';
      const configuredKeys = (Array.isArray(model.keys.slots) ? model.keys.slots : []).filter((slot) => slot.configured).length;
      const keyTone = model.keys.phase === 'error' ? 'error' : model.keys.phase !== 'ready' ? undefined : configuredKeys > 0 ? 'ok' : 'warn';
      const version = model.update?.version;
      // 刚更新成功时运行版本要等重启才换，此时不再提醒「有新版本」
      const updateReady = version?.phase === 'ready' && version.updateAvailable && model.update.operation?.state !== 'succeeded';
      const chip = (key, target, chipTone, title, value) =>
        h(
          'button',
          { key, type: 'button', className: 'dsm-tv-chip', 'data-tone': chipTone, onClick: () => actions.selectTab(target) },
          h('span', { className: 'dsm-tv-chip-dot', 'aria-hidden': true }),
          title,
          value ? h('b', null, value) : null,
        );
      const chips = [
        keyTone ? chip('keys', 'keys', keyTone, t('tabKeys'), keyTone === 'ok' ? t('keyCount', { count: configuredKeys }) : keyTone === 'warn' ? t('keyUnset') : undefined) : null,
        wiring ? chip('web', 'web', wiring.tone, t('tabWeb'), t(wiring.label)) : null,
        label ? chip('server', 'server', tone, t('tabServer'), t(label)) : null,
        version?.currentVersion
          ? h(
              'button',
              { key: 'version', type: 'button', className: 'dsm-tv-chip', onClick: () => actions.selectTab('plugin') },
              `v${version.currentVersion}`,
              updateReady ? h('span', { className: 'dsm-tv-new' }, ` · ${t('updateAvailable')}`) : null,
            )
          : null,
      ].filter(Boolean);

      // 只有要用户处理的状态才在页签上标点；一切正常时页签保持干净
      const attention = (value) => (value === 'warn' || value === 'error' || value === 'accent' ? value : undefined);
      const marks = { keys: attention(keyTone), web: attention(wiring?.tone), server: attention(tone), plugin: updateReady ? 'accent' : undefined };
      const tabBar = h(
        'div',
        { key: 'tabs', className: 'dsm-tv-tabs', role: 'tablist', 'aria-label': t('title') },
        TABS.map(([id, labelKey]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              id: `dsm-tv-tab-${id}`,
              className: 'dsm-tv-tab',
              'aria-selected': id === activeTab,
              'aria-controls': `dsm-tv-panel-${id}`,
              onClick: () => actions.selectTab(id),
            },
            t(labelKey),
            marks[id] ? h('span', { className: 'dsm-tv-mark', 'data-tone': marks[id], 'aria-hidden': true }) : null,
          ),
        ),
      );
      // 各面板都渲染、只切 hidden：切页签不丢输入中的 key 与二次确认状态
      const panel = (id, ...children) =>
        h(
          'div',
          { key: id, className: 'dsm-tv-panel', role: 'tabpanel', id: `dsm-tv-panel-${id}`, 'aria-labelledby': `dsm-tv-tab-${id}`, hidden: id !== activeTab },
          ...children,
        );

      return h(
        'div',
        { className: 'dsm-tv-card', ref: showPanelFromTop },
        h(
          'header',
          { key: 'head', className: 'dsm-tv-head' },
          h('div', { className: 'dsm-tv-title' }, t('title')),
          h('p', { className: 'dsm-tv-desc' }, t('description')),
          chips.length > 0 ? h('div', { className: 'dsm-tv-chips' }, chips) : null,
        ),
        tabBar,
        panel(
          'keys',
          h('div', { key: 'key', className: 'dsm-tv-section' }, keySection),
          // 申请链接常驻本页：加第二个、第三个 key 时同样要去控制台拿，不只在一个都没配时才需要
          h('p', { key: 'get', className: 'dsm-tv-hint' }, t('keyGet'), externalLink(TAVILY_CONSOLE_URL)),
        ),
        panel('web', h('div', { key: 'web', className: 'dsm-tv-section' }, webSection)),
        panel('server', h('div', { key: 'server', className: 'dsm-tv-section' }, serverSection)),
        panel(
          'plugin',
          model.update ? h('div', { key: 'update', className: 'dsm-tv-section' }, renderUpdateSection(model.update, actions, t)) : null,
          purgeSection ? h('div', { key: 'purge', className: 'dsm-tv-section' }, purgeSection) : null,
        ),
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
        keyRefOverridden: user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, 'apiKeyEnv'),
        writable: snapshot.writable !== false,
      };
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

    /**
     * 有状态的外壳：取数、订阅、动作；渲染交给 renderCard。
     *
     * @param {{ t: Function, view?: string, api: object }} props
     */
    function TavilyCard({ t, view, api }) {
      const [status, setStatus] = useState({ phase: 'loading' });
      const [keys, setKeys] = useState({ phase: 'loading', slots: [] });
      const [draft, setDraft] = useState('');
      const [keyBusy, setKeyBusy] = useState(undefined);
      const [confirmRemove, setConfirmRemove] = useState(undefined);
      const [keyNotice, setKeyNotice] = useState(undefined);
      const [webSnapshot, setWebSnapshot] = useState(() => api.webForm?.getSnapshot?.());
      const [apiSnapshot, setApiSnapshot] = useState(() => api.apiForm?.getSnapshot?.());
      const [webKeyConfigured, setWebKeyConfigured] = useState(undefined);
      const [webBusy, setWebBusy] = useState(false);
      const [webNotice, setWebNotice] = useState(undefined);
      const [test, setTest] = useState({ busy: false, result: undefined });
      const updater = useUpdater(t, api);
      // 「清除插件数据」的状态排在既有 hooks 之后，不打乱它们的调用顺序
      const [confirmPurge, setConfirmPurge] = useState(false);
      const [purgeBusy, setPurgeBusy] = useState(false);
      const [purgeNotice, setPurgeNotice] = useState(undefined);
      // `web` 命名空间（提供方选择）同理排在最后；旧版 DSH 没有它，selectionForm 可能是 undefined
      const [selectionSnapshot, setSelectionSnapshot] = useState(() => api.selectionForm?.getSnapshot?.());
      const [tab, setTab] = useState('keys');

      const web = webModel(webSnapshot);
      const apiModel = webModel(apiSnapshot);
      const selection = selectionModel(selectionSnapshot);
      const mode = webMode(selection);
      /** 当前搜索通道实际读哪个凭据引用：新版走 web-deepseek-api，旧版走 web-search-deepseek。 */
      const native = status.nativeProvider === NATIVE_SEARCH_PROVIDER;
      const activeKeyRef = native ? undefined : (mode === 'api' ? apiModel : web).apiKeyEnv;

      const loadStatus = useCallback(async () => {
        setStatus((previous) => ({ ...previous, phase: 'loading' }));
        try {
          const payload = await request(STATUS_PATH, 'GET');
          setStatus({ phase: 'ready', ...payload });
        } catch (error) {
          setStatus({ phase: 'error', reason: errorText(error) });
        }
      }, []);

      const loadKeys = useCallback(async () => {
        // 保留旧列表：刷新期间列表不闪
        setKeys((previous) => ({ ...previous, phase: 'loading' }));
        try {
          const payload = await request(KEYS_PATH, 'GET');
          setKeys({ phase: 'ready', slots: Array.isArray(payload.keys) ? payload.keys : [] });
        } catch (error) {
          setKeys((previous) => ({ phase: 'error', slots: previous.slots, reason: errorText(error) }));
        }
      }, []);

      const loadWebKey = useCallback(async () => {
        if (!activeKeyRef) return;
        try {
          const views = unwrap(await api.describe([activeKeyRef]));
          setWebKeyConfigured(views?.[activeKeyRef]?.configured === true);
        } catch {
          setWebKeyConfigured(undefined);
        }
      }, [api, activeKeyRef]);

      useEffect(() => {
        loadStatus();
      }, [loadStatus]);

      useEffect(() => {
        loadKeys();
      }, [loadKeys]);

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

      // 新版 Search API 的设置（web-deepseek-api）同理：内置网页搜索页打开新版开关后编辑的是它
      useEffect(() => {
        const form = api.apiForm;
        if (typeof form?.subscribe !== 'function') return undefined;
        setApiSnapshot(form.getSnapshot());
        return form.subscribe(() => setApiSnapshot(form.getSnapshot()));
      }, [api]);

      // 新版 Search API 开关在内置网页搜索页里切换，同样订阅
      useEffect(() => {
        const form = api.selectionForm;
        if (typeof form?.subscribe !== 'function') return undefined;
        setSelectionSnapshot(form.getSnapshot());
        return form.subscribe(() => setSelectionSnapshot(form.getSnapshot()));
      }, [api]);

      // 凭据在别处被改（内置网页搜索页 / 模型页写同一个引用）时刷新 key 列表与徽标。
      // 依赖用拼接串而不是数组：每次渲染的新数组会让订阅反复重挂
      const keyRefs = (status.apiKeyRefs ?? keys.slots.map((slot) => slot.ref)).join(',');
      useEffect(
        () =>
          api.onCredentialUpdated?.((changed) => {
            if (changed === DEFAULT_REF || keyRefs.split(',').includes(changed)) loadKeys();
            if (changed === activeKeyRef) loadWebKey();
          }),
        [api, keyRefs, activeKeyRef, loadKeys, loadWebKey],
      );

      const addKey = useCallback(
        async (ref) => {
          const value = draft.trim();
          if (!value || !ref) return;
          setKeyBusy('add');
          setKeyNotice(undefined);
          try {
            unwrap(await api.setKey(ref, value));
            setDraft('');
            setKeyNotice({ kind: 'ok', text: t('keyAdded') });
            await loadKeys();
          } catch (error) {
            setKeyNotice({ kind: 'error', text: errorText(error) });
          } finally {
            setKeyBusy(undefined);
          }
        },
        [api, draft, loadKeys, t],
      );

      const removeKey = useCallback(
        async (ref) => {
          const slot = keys.slots.find((item) => item.ref === ref);
          const label = slot ? keyName(slot) : ref;
          setConfirmRemove(undefined);
          setKeyBusy(ref);
          setKeyNotice(undefined);
          try {
            unwrap(await api.unsetKey(ref));
            setKeyNotice({ kind: 'ok', text: t('keyRemoved', { name: label }) });
            await loadKeys();
          } catch (error) {
            setKeyNotice({ kind: 'error', text: errorText(error) });
          } finally {
            setKeyBusy(undefined);
          }
        },
        [api, keys.slots, loadKeys, t],
      );

      const writeWeb = useCallback(
        async (op) => {
          if (op === 'set' && (status.phase !== 'ready' || status.server?.state === 'disabled')) return;
          const endpoint = status.endpoint ?? DEFAULT_ENDPOINT;
          const apiEndpoint = status.apiEndpoint ?? `${endpoint}/tools`;
          const currentSelection = selectionModel(api.selectionForm?.getSnapshot?.() ?? selectionSnapshot);
          const currentMode = webMode(currentSelection);
          const currentApi = webModel(apiSnapshot);
          // 新宿主直接选择 Tavily；旧宿主按当前搜索提供方决定兼容协议。
          const wireMode = native ? 'native' : currentMode !== 'messages' && currentApi.phase === 'ready' ? 'api' : 'messages';
          const owned = native
            ? { restoreNative: true }
            : ownershipOf({ web: webModel(webSnapshot), api: currentApi, selection: currentSelection }, endpoint, apiEndpoint);
          setWebBusy(true);
          setWebNotice(undefined);
          try {
            const accepted = await (op === 'set'
              ? wireWebSearch(api, { mode: wireMode, endpoint, apiEndpoint, selection: currentSelection })
              : restoreWebSearch(api, owned, currentSelection));
            if (accepted === false) {
              setWebNotice({ kind: 'error', text: t('writeRejected') });
            } else {
              const noticeKey = op === 'set'
                ? { native: 'wiredNative', api: 'wiredApi', messages: 'wired' }[wireMode]
                : native ? 'unwiredNative' : currentMode === 'api' ? 'unwiredApi' : 'unwired';
              setWebNotice({ kind: 'ok', text: t(noticeKey) });
            }
          } catch (error) {
            setWebNotice({ kind: 'error', text: errorText(error) });
          } finally {
            setWebBusy(false);
          }
        },
        [api, native, status, webSnapshot, apiSnapshot, selectionSnapshot, t],
      );

      const purge = useCallback(
        async (targets) => {
          setConfirmPurge(false);
          setPurgeBusy(true);
          setPurgeNotice(undefined);
          try {
            setPurgeNotice(purgeNoticeOf(await purgePluginData({ api, targets }), t));
            // 网页搜索的快照靠订阅自己刷新；key 列表要重读
            await loadKeys();
          } catch (error) {
            setPurgeNotice({ kind: 'error', text: errorText(error) });
          } finally {
            setPurgeBusy(false);
          }
        },
        [api, loadKeys, t],
      );

      const runTest = useCallback(async () => {
        const testMode = native ? 'native' : webMode(selectionModel(selectionSnapshot)) === 'api' ? 'api' : 'messages';
        setTest({ busy: true, result: undefined });
        try {
          setTest({ busy: false, result: await request(TEST_PATH, 'POST', { mode: testMode }) });
        } catch (error) {
          setTest({ busy: false, result: { ok: false, reason: errorText(error) } });
        }
      }, [native, selectionSnapshot]);

      // 行详情页在缺少包描述时才用 summary 视图；本包有 description，正常走完整卡片。
      if (view === 'summary') return h('p', { className: 'dsm-tv-desc' }, t('summary'));

      return renderCard(
        {
          status,
          keys,
          draft,
          keyBusy,
          confirmRemove,
          keyNotice,
          web: { ...web, keyConfigured: webKeyConfigured },
          api: { ...apiModel, keyConfigured: webKeyConfigured },
          selection,
          webBusy,
          webNotice,
          test,
          confirmPurge,
          purgeBusy,
          purgeNotice,
          update: updater.model,
          tab,
        },
        {
          ...updater.actions,
          selectTab: setTab,
          editDraft: (text) => {
            setDraft(text);
            setKeyNotice(undefined);
          },
          addKey,
          askRemove: (ref) => setConfirmRemove(ref),
          cancelRemove: () => setConfirmRemove(undefined),
          removeKey,
          wire: () => writeWeb('set'),
          unwire: () => writeWeb('unset'),
          runTest,
          askPurge: () => {
            setConfirmPurge(true);
            setPurgeNotice(undefined);
          },
          cancelPurge: () => setConfirmPurge(false),
          purge,
          reload: () => {
            loadStatus();
            loadKeys();
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

      // 更新器随插件挂卸，两处卡片共用一份更新状态。
      const updater = createPluginUpdater(ctx.remote);
      ctx.effect(() => () => updater.dispose(), `${name}: plugin updater`);
      connectPluginManager(ctx, updater);
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

      /** 卡片拿到的全部能力；凭据值只往宿主写，没有任何读值的路径。 */
      const api = {
        updater,
        describe: (refs) => ctx.remote.credentials.describe(refs),
        setKey: (ref, value) => ctx.remote.credentials.set(ref, value),
        unsetKey: (ref) => ctx.remote.credentials.unset(ref),
        webForm: ctx.configForms.get(WEB_SEARCH_NS),
        apiForm: ctx.configForms.get(WEB_API_NS),
        selectionForm: ctx.configForms.get(WEB_NS),
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

      // 插件页按"包名"找 bundle 卡片、按"包名#行 id"找行卡片（DSH plugin-manager 的 rowConfigKey）。
      registerCard('plugins.bundle.config', '@zhiqiangme/dsh-tavily-search');
      registerCard('plugins.row.config', '@zhiqiangme/dsh-tavily-search#dsh-tavily-search');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    // 只给测试用：纯渲染函数与快照映射，宿主不会读这些导出
    exports.renderCard = renderCard;
    exports.webModel = webModel;
    exports.purgePluginData = purgePluginData;
    exports.purgeTargets = purgeTargets;
    exports.ownershipOf = ownershipOf;
    exports.wireWebSearch = wireWebSearch;
    exports.restoreWebSearch = restoreWebSearch;
    exports.selectionModel = selectionModel;
    exports.selectionWireOps = selectionWireOps;
    exports.webMode = webMode;
    exports.pinnedInstallSpec = pinnedInstallSpec;
    exports.createPluginUpdater = createPluginUpdater;
    exports.connectPluginManager = connectPluginManager;
    return module.exports;
  },
});
