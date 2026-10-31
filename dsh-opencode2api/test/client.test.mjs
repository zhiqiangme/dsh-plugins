/**
 * 客户端半侧的契约测试（在 Node 里跑，不需要浏览器）。
 *
 * 为什么值得测：卡片在浏览器里出问题时只有一句 "正在读取…" 或者干脆整块消失，
 * 看不到原因。这里把 bundle 放进沙箱、用替身 React 把组件真跑一遍，把两类
 * 已经踩过的坑钉死：
 *   1) 文案字典的值必须是字符串——DSH 的 t(key, params) 只做 `{name}` 插值，
 *      值放函数会让 React 拿到函数当 child，整块卡片直接崩掉；
 *   2) 两个 slot 的 key 必须逐字正确（写错不报错，只是卡片不出现）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/** 宿主按 npm 包名登记客户端模块、寻址插件页卡片；行 id 则沿用改作用域包之前的名字。 */
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
const ROW_ID = 'dsh-opencode2api';
const NAMESPACE = 'settings.dsh-opencode2api';

/** 把 bundle 放进沙箱执行，拿回它注册进 __ModuleLoader__ 的 registration 与注入的样式。 */
function loadBundle({ fetchImpl = globalThis.fetch, crypto = webcrypto, clipboard } = {}) {
  let registration;
  const styles = [];
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } }, crypto, navigator: { clipboard } };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (element) => styles.push(element) },
  };
  // eslint-disable-next-line no-new-func -- 故意在沙箱里跑浏览器 bundle
  new Function('window', 'document', 'console', 'fetch', SOURCE)(window, document, console, fetchImpl);
  assert.ok(registration, 'bundle 应调用 window.__ModuleLoader__.load');
  assert.equal(registration.id, PACKAGE_NAME);
  return { registration, styles };
}

/** 替身 React：createElement 产出普通对象；useState 按调用顺序喂预设状态。 */
function makeReact(states) {
  let index = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const slot = index++;
      if (states[slot] === undefined) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
    },
    beginRender: () => { index = 0; },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
}

/** 收集渲染结果里的所有文本 child。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out);
  }
  return out;
}

/** 按元素类型收集节点（用于检查链接的 href/target 这类属性）。 */
function collectByType(node, type, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectByType(item, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectByType(child, type, out);
  }
  return out;
}

/**
 * 展开函数组件。
 *
 * 替身 React 的 createElement 只记录元素、不执行组件，所以 <Modal title=... footer=.../>
 * 的 props 不会变成子节点。测试里手动调用一次函数组件，把树"渲染"出来。
 * 本插件自己的组件是直接调用的，这里只会命中 Modal 这类宿主组件。
 */
function render(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node.type === 'function') {
    return render(node.type({ ...node.props, children: node.children }));
  }
  if (Array.isArray(node.children)) {
    return { ...node, children: node.children.map(render) };
  }
  return node;
}

/** 按 DSH 的约定插值；值不是字符串就原样返回，好让测试看出这类错误。 */
function interpolate(value, params) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (params && key in params ? String(params[key]) : match));
}

/**
 * 跑一遍模块与 apply。
 *
 * @param {unknown[]} states 组件渲染时 useState 按顺序返回的值
 * @param {{ withPrimitives?: boolean }} [options] withPrimitives=false 时模拟宿主组件不可用
 */
function boot(states = [], { withPrimitives = true, fetchImpl, crypto, clipboard, $on } = {}) {
  const { registration, styles } = loadBundle({ fetchImpl, crypto, clipboard });
  const dicts = new Map();
  const cards = [];
  const events = new Map();
  const React = makeReact(states);

  /** 替身 primitives：只提供 Modal，渲染成普通 div 便于断言内容。 */
  const primitives = {
    Modal: ({ open, title, description, children, footer }) =>
      open === false ? null : React.createElement('div', { className: 'dsm-modal' }, title, description, children, footer),
  };

  const module = registration.factory((id) => {
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives' && withPrimitives) return primitives;
    throw new Error(`未预期的 require：${id}`);
  });

  const ctx = {
    remote: { $on: $on ?? ((event, listener) => { events.set(event, listener); return () => events.delete(event); }) },
    effect: (factory) => factory(),
    locale: {
      register: (ns, dict) => {
        dicts.set(ns, dict);
        return () => {};
      },
      // 真实签名是 register(ns, { zh, en })；测试按中文解析（宿主界面就是中文）。
      bind: (ns) => (key, params) => interpolate(dicts.get(ns)?.zh?.[key], params),
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (spec, component) => {
        cards.push({ spec, component: (props) => component({ ...spec.inject(), ...props }) });
        return () => {};
      },
    },
  };

  module.apply(ctx);
  return {
    module,
    events,
    dicts,
    cards,
    renderCard: () => {
      React.beginRender();
      return cards[0].component({ t: ctx.locale.bind(NAMESPACE), view: 'page' });
    },
    t: ctx.locale.bind(NAMESPACE),
    css: styles.map((style) => style.textContent).join('\n'),
  };
}

const ROWS = [
  { id: 'cn:alpha', label: 'CN Alpha 0.11', credits: '0.11', contextWindow: 1000000, vision: true, selected: true },
  { id: 'global:beta', label: 'GL Beta Free', credits: 'Free', contextWindow: 200000, vision: false, selected: false },
];

test('bundle 契约：模块名、注入的服务名、两个 slot 的 key', () => {
  const { module, cards } = boot();
  assert.equal(module.name, 'dsh-opencode2api-client');
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote']);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'));
  assert.equal(typeof module.apply, 'function');
  assert.equal(cards.length, 2);

  const bundle = cards.find((card) => card.spec.name === 'plugins.bundle.config');
  const row = cards.find((card) => card.spec.name === 'plugins.row.config');
  assert.ok(bundle, '应注册 plugins.bundle.config');
  assert.ok(row, '应注册 plugins.row.config');
  assert.equal(bundle.spec.key, PACKAGE_NAME);
  assert.equal(row.spec.key, `${PACKAGE_NAME}#${ROW_ID}`);
  assert.equal(typeof bundle.component, 'function');
});

test('保存的白名单按面板展示顺序排（cn → global，组内后端顺序），与勾选先后无关', () => {
  const { module } = boot();
  const rows = [{ id: 'global:b' }, { id: 'cn:x' }, { id: 'global:a' }, { id: 'other' }, { id: 'cn:y' }];
  // 模拟"cn:x 取消后又勾上"：Set 插入顺序里它排在最后。
  const picked = new Set(['global:a', 'cn:y', 'other', 'global:b', 'cn:x']);
  assert.deepEqual(module.orderedSelection(rows, picked), ['cn:x', 'cn:y', 'global:b', 'global:a', 'other']);
  assert.deepEqual(module.orderedSelection(rows, new Set(['global:a'])), ['global:a']);
  assert.deepEqual(module.orderedSelection(rows, new Set()), []);
});

test('文案字典：zh/en 的每个值都必须是字符串，且两个 locale 的键集合一致', () => {
  const { dicts } = boot();
  const entry = dicts.get(NAMESPACE);
  assert.ok(entry, `应注册 locale 命名空间 ${NAMESPACE}`);
  assert.ok(entry.zh && entry.en, '应同时提供 zh 与 en');

  for (const [locale, dict] of Object.entries(entry)) {
    const nonStrings = Object.entries(dict).filter(([, value]) => typeof value !== 'string');
    assert.deepEqual(nonStrings, [], `${locale} 字典值出现非字符串——函数会让 React 崩掉整块卡片`);
  }
  assert.deepEqual(Object.keys(entry.zh).sort(), Object.keys(entry.en).sort(), 'zh/en 键集合应一致');

  const expected = [
    'backendNotInstalled', 'backendAvailableInstall', 'backendStart', 'backendStarted', 'backendProgressHint', 'backendElapsed',
    'uninstallTiaraTitle', 'uninstallTiaraDesc', 'uninstallTiaraKept',
    'gatewayTitle', 'gatewayJason', 'gatewayTiara', 'gatewaySwitching', 'gatewayWaiting', 'gatewaySwitched',
    'gatewaySynced', 'gatewaySyncFailed',
    'gatewayNotInstalled', 'gatewayTimeout', 'gatewayTiaraHint', 'panelKeyCopyTiara', 'panelKeyCopiedTiara', 'backendUninstalledTiara',
    'backendAvailable', 'backendBuilt', 'backendCheck', 'backendCurrent', 'backendHistory',
    'backendInstall', 'backendInstalled', 'backendLatest', 'backendNoAccounts', 'backendNoHistory', 'backendRollback',
    'modelsNotInstalled', 'backendPurge', 'backendPurgeHint', 'backendPurged', 'purgeConfirm', 'purgeDesc', 'purgeKept', 'purgeTitle',
    'backendTitle', 'backendUninstall', 'backendUninstalled', 'backendUnmanaged', 'backendUpdate',
    'backendUpdated', 'backendUpToDate', 'backendWorking', 'backendRolledBack', 'cancel',
    'clearAll', 'count', 'description', 'disabledHint', 'emptyBackend', 'emptyHint', 'loading',
    'panelHint', 'panelKeyCopied', 'panelKeyCopy', 'panelKeyManual', 'panelKeyNone', 'panelKeyWorking',
    'patchPath', 'refresh', 'retry', 'save', 'saveFailed', 'saveSync', 'savedDisabled', 'savedNoSync', 'savedSync',
    'saving', 'selectAll', 'summary', 'syncEnabled', 'syncHint', 'title', 'uninstallConfirm', 'uninstallDesc', 'uninstallKept',
    'uninstallTitle', 'vision',
    // 插件自身更新区（与后端版本区无关）
    'updateAvailable', 'updateCancelled', 'updateCheck', 'updateCheckFailed', 'updateChecking', 'updateCurrent',
    'updateFailed', 'updateLatestVersion', 'updateLinked', 'updateManaged', 'updateNow', 'updatePendingRestart',
    'updateRestartHint', 'updateRolledBack', 'updateRunning', 'updateSucceeded', 'updateTitle', 'updateUpToDate', 'updateLocal',
    'updateNoMarket', 'updateCheckingTarget', 'updateManagerFailed', 'updateRestoreFailed', 'updateNoCompatible', 'updateNotUpdatable',
    'updatePinnedInstall', 'updatePinnedHint', 'updateCopySpec', 'updateSpecCopied', 'updateSpecCopyFailed',
    'updateUnknown', 'updateRemoving', 'updateInstalling', 'updateRestoring',
    // 插件自身更新的 dshmarket 兜底与宿主拒绝卸载运行中插件的提示
    'updateProgress', 'updateStartFailed', 'updateMismatch', 'updateTooFresh', 'updateForce', 'updateLost',
    'updateInUse', 'updateReselectFailed', 'restartNow', 'restarting', 'restartFailed',
    // 后端自动更新
    'autoUpdateDrifted', 'autoUpdateError', 'autoUpdateFailed', 'autoUpdateHint', 'autoUpdateLabel', 'autoUpdateLast',
    'autoUpdatePending', 'autoUpdateRolledBack', 'autoUpdateTiara', 'autoUpdateUnavailable', 'autoUpdateUnknown', 'autoUpdateWaiting',
  ];
  assert.deepEqual(Object.keys(entry.zh).sort(), expected.sort());
  assert.match(entry.zh.panelKeyCopied, /初始管理密码已复制/);
  assert.match(entry.zh.panelKeyNone, /管理员账号和密码/);
});

test('渲染（含后端版本区）：显示当前/上游/历史版本，三个操作按钮都在', () => {
  const { cards, t } = boot([
    'ready', // phase
    ROWS, // rows
    { enabled: true, patchPath: '' }, // meta
    '', // reason
    new Set(['cn:alpha']), // picked
    new Set(['cn:alpha']), // savedPicked
    false, // saving
    undefined, // notice
    {
      version: { tag: 'v1.13.0', revision: 'd66384d9e3d69655f799d7d8f2e5fba1946e00ab', builtAt: '2026-10-08T00:49:09Z' },
      history: [{ name: 'v1.12.0' }],
    }, // backend
    { upToDate: false, latest: { tag: 'v1.14.0' } }, // check
    undefined, // backendBusy
    undefined, // backendNotice
  ]);

  const texts = collectText(cards[0].component({ t, view: 'page' }));
  for (const text of texts) {
    assert.equal(typeof text, 'string', `渲染出了非字符串文本：${String(text)}`);
  }
  assert.ok(texts.includes('后端版本'), '应有后端版本标题');
  assert.ok(texts.some((text) => text.includes('当前 v1.13.0')), '应显示当前版本');
  assert.ok(texts.some((text) => text.includes('上游 v1.14.0')), '应显示上游版本');
  assert.ok(texts.some((text) => text.includes('历史版本：v1.12.0')), '应显示历史版本');
  assert.ok(texts.includes('可更新到 v1.14.0'), '应提示可更新');
  assert.ok(texts.includes('检查更新'));
  assert.ok(texts.includes('更新'));
  assert.ok(texts.includes('回滚'));
});

test('渲染（后端区已是最新 + 无历史）：徽章显示已是最新', () => {
  const { cards, t } = boot([
    'ready', ROWS, {}, '', new Set(), new Set(), false, undefined,
    { version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] },
    { upToDate: true, latest: { tag: 'v1.13.0' } },
    undefined,
    undefined,
  ]);
  const texts = collectText(cards[0].component({ t, view: 'page' }));
  assert.ok(texts.includes('已是最新'));
  assert.ok(texts.includes('历史版本：无'));
});

test('渲染（ready 态）：所有文本都是字符串，且带出模型名、倍率与计数', () => {
  const { cards, t } = boot([
    'ready', // phase
    ROWS, // rows
    { enabled: true, patchPath: 'C:\\tmp\\cordis.patch.yml' }, // meta
    '', // reason
    new Set(['cn:alpha']), // picked
    new Set(['cn:alpha']), // savedPicked
    false, // saving
    undefined, // notice
  ]);

  const texts = collectText(cards[0].component({ t, view: 'page' }));

  assert.ok(texts.length > 0, '应渲染出内容');
  for (const text of texts) {
    assert.equal(typeof text, 'string', `渲染出了非字符串文本：${String(text)}`);
  }
  assert.ok(texts.includes('CN Alpha 0.11'), '应显示模型展示名');
  assert.ok(texts.includes('GL Beta Free'), '应显示模型展示名');
  assert.ok(texts.includes('0.11'), '应显示倍率徽章');
  assert.ok(texts.includes('Free'), '免费模型显示 xFree');
  assert.ok(texts.includes('视觉'), '支持视觉的模型带标签');
  assert.ok(
    texts.some((text) => text.includes('后端共 2 个模型，已勾选 1 个')),
    '计数文案应插值成功',
  );
  assert.ok(
    texts.some((text) => text.includes('写入目标：C:\\tmp\\cordis.patch.yml')),
    '应显示写入目标路径',
  );
});

test('渲染（loading / error 态）：都不抛错，error 态显示原因', () => {
  const loading = boot(['loading', [], {}, '', new Set(), new Set(), false, undefined]);
  const loadingTexts = collectText(loading.cards[0].component({ t: loading.t, view: 'page' }));
  assert.ok(loadingTexts.includes('正在读取后端模型…'));

  const failed = boot(['error', [], {}, 'connection refused', new Set(), new Set(), false, undefined]);
  const failedTexts = collectText(failed.cards[0].component({ t: failed.t, view: 'page' }));
  assert.ok(failedTexts.includes('connection refused'));
  assert.ok(failedTexts.includes('重试'));
});

/** 开关与模型勾选维持独立草稿；用实际事件和请求验证只改开关也能保存。 */
function modelStates(enabled) {
  return ['ready', ROWS, { enabled, savedEnabled: enabled }, '', new Set(['cn:alpha']), new Set(['cn:alpha']), false, undefined];
}

function syncCheckbox(tree) {
  const label = collectByType(tree, 'label').find((node) => node.props.className === 'dsm-oc-sync');
  return collectByType(label, 'input')[0];
}

test('模型开关：只开启同步就能保存，POST 同时传开关和白名单，成功后回显', async () => {
  const requests = [];
  const { renderCard } = boot(modelStates(false), {
    fetchImpl: async (path, options) => {
      requests.push({ path, ...options });
      const payload = options.method === 'POST'
        ? { ok: true, enabled: true, sync: { state: 'updated', count: 1 } }
        : { ok: true, enabled: true, models: ROWS };
      return { ok: true, json: async () => payload };
    },
  });

  let tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, false);
  assert.equal(button(collectByType(tree, 'button'), '保存').props.disabled, true);
  syncCheckbox(tree).props.onChange({ target: { checked: true } });
  tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, true);
  const save = button(collectByType(tree, 'button'), '保存并同步');
  assert.equal(save.props.disabled, false, '只改开关、白名单不变也必须能保存');
  await save.props.onClick();

  assert.equal(requests[0].path, '/plugins/dsh-opencode2api/models');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), { enabled: true, only: ['cn:alpha'] });
  assert.equal(requests[1].method, 'GET');
  tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, true);
  assert.ok(collectText(tree).includes('已保存，并已重新生成模型清单：1 个模型。'));
  assert.equal(button(collectByType(tree, 'button'), '保存并同步').props.disabled, false, '成功后仍允许重新同步');
});

test('装好后端：自动打开同步（不带 only，沿用白名单）并刷新模型区', async () => {
  const requests = [];
  const notInstalled = { exeExists: false, version: {}, history: [] };
  const { renderCard } = boot(
    ['error', [], {}, 'backend-not-installed', new Set(), new Set(), false, undefined, notInstalled],
    {
      fetchImpl: async (path, options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        requests.push({ path, method: options.method, body });
        let payload;
        if (path.endsWith('/backend')) {
          payload = { ok: true, state: 'installed', latest: { tag: 'v9.9.9' }, backend: { exeExists: true, version: { tag: 'v9.9.9' }, history: [] } };
        } else if (options.method === 'POST') {
          payload = { ok: true, enabled: true, sync: { state: 'updated', count: 2 } };
        } else {
          payload = { ok: true, enabled: true, models: ROWS };
        }
        return { ok: true, json: async () => payload };
      },
    },
  );

  await button(collectByType(renderCard(), 'button'), '安装').props.onClick();

  assert.deepEqual(requests.map((item) => `${item.method} ${item.path.split('/').pop()}`), ['POST backend', 'POST models', 'GET models']);
  assert.deepEqual(requests[1].body, { enabled: true }, '只开同步，不带 only，避免清空已有勾选');
  const tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, true, '同步开关应已勾上');
  assert.ok(collectText(tree).includes('已保存，并已重新生成模型清单：2 个模型。'));
  assert.ok(collectText(tree).some((text) => text.includes('后端已安装 v9.9.9')));
});

test('模型开关：关闭后只保存选择，失败时保留草稿并允许重试', async () => {
  let reject = true;
  const requests = [];
  const { renderCard } = boot(modelStates(true), {
    fetchImpl: async (_path, options) => {
      if (options.method === 'POST') {
        requests.push(JSON.parse(options.body));
        if (reject) return { ok: false, json: async () => ({ reason: 'write rejected' }) };
        return { ok: true, json: async () => ({ ok: true, enabled: false, sync: { state: 'disabled' } }) };
      }
      return { ok: true, json: async () => ({ ok: true, enabled: false, models: ROWS }) };
    },
  });

  syncCheckbox(renderCard()).props.onChange({ target: { checked: false } });
  await button(collectByType(renderCard(), 'button'), '保存').props.onClick();
  let tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, false);
  assert.ok(collectText(tree).includes('write rejected'));
  assert.equal(button(collectByType(tree, 'button'), '保存').props.disabled, false);

  reject = false;
  await button(collectByType(tree, 'button'), '保存').props.onClick();
  tree = renderCard();
  assert.equal(button(collectByType(tree, 'button'), '保存').props.disabled, true);
  assert.ok(collectText(tree).includes('已保存，同步已关闭；保留现有 DSH 模型列表。'));
  assert.deepEqual(requests, Array(2).fill({ enabled: false, only: ['cn:alpha'] }));
});

test('模型同步：勾选未变时可重试同步失败，保存期间禁用开关和选择操作', async () => {
  const { renderCard } = boot(modelStates(true), {
    fetchImpl: async (_path, options) => ({
      ok: true,
      json: async () => options.method === 'POST'
        ? { ok: true, sync: { state: 'failed', reason: 'backend unavailable' } }
        : { ok: true, enabled: true, models: ROWS },
    }),
  });
  await button(collectByType(renderCard(), 'button'), '保存并同步').props.onClick();
  const tree = renderCard();
  assert.ok(collectText(tree).some((text) => text.includes('backend unavailable')));
  assert.equal(button(collectByType(tree, 'button'), '保存并同步').props.disabled, false);

  const states = modelStates(true);
  states[6] = true;
  const busy = boot(states).renderCard();
  assert.ok(collectByType(busy, 'input').every((node) => node.props.disabled === true));
  const toolbar = collectByType(busy, 'div').find((node) => node.props.className === 'dsm-oc-toolbar');
  assert.ok(collectByType(toolbar, 'button').every((node) => node.props.disabled === true));
});

test('渲染（summary 视图）：给行详情页的一句话，不抛错', () => {
  const { cards, t } = boot(['loading', [], {}, '', new Set(), new Set(), false, undefined]);
  const texts = collectText(cards[0].component({ t, view: 'summary' }));
  assert.equal(texts.length, 1);
  assert.equal(typeof texts[0], 'string');
});

test('样式：颜色一律走主题令牌，不写死白/黑，主按钮禁用态有明确配色', () => {
  const { css } = boot();
  assert.ok(css.length > 0, '应注入样式');

  // 写死的白/黑文字色是"深色模式下看不清"的经典来源（本主题把
  // --dsw-alias-brand-primary 定义成 label-primary，深色下接近纯白，
  // 拿它当底色再配白字就是白底白字）。
  const hardcodedTextColor = /(^|[;{\s])color:\s*(#fff|#ffffff|white|#000|#000000|black)\b/i;
  assert.equal(hardcodedTextColor.test(css), false, '文字色必须走 --dsw-* 令牌');

  // brand-primary 在本主题里会退化成 label-primary，不能当背景色用。
  assert.equal(
    /background:\s*var\(--dsw-alias-brand-primary/.test(css),
    false,
    'brand-primary 不能当背景（本主题里它等于 label-primary）',
  );

  // 禁用态必须是显式配色，而不是整体降透明度——降透明度会把文字一起洗掉。
  assert.match(css, /\.dsm-oc-btn-primary:disabled\{[^}]*color:var\(--dsw-alias-label-dimmed/);
  assert.equal(/\.dsm-oc-btn:disabled\{[^}]*opacity/.test(css), false, '禁用态不要只靠 opacity');

  // 主按钮走反色：label-primary 当底、bg-layer-3 当字。
  assert.match(css, /\.dsm-oc-btn-primary\{[^}]*background:var\(--dsw-alias-label-primary/);
});

test('渲染：后端面板地址是外链（target=_blank，宿主会交给默认浏览器）', () => {
  const { cards, t } = boot([
    'ready', ROWS, {}, '', new Set(), new Set(), false, undefined,
    { version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [], panelUrl: 'http://127.0.0.1:8081/' },
    undefined, undefined, undefined,
  ]);

  const anchors = collectByType(cards[0].component({ t, view: 'page' }), 'a');
  assert.equal(anchors.length, 1, '应渲染一个链接');
  assert.equal(anchors[0].props.href, 'http://127.0.0.1:8081/');
  assert.equal(anchors[0].props.target, '_blank', '外链必须走 target=_blank 才会被宿主 openExternal');
  assert.match(anchors[0].props.rel ?? '', /noopener/);
  // 显示文本去掉协议头，和用户看到的写法一致
  assert.deepEqual(collectText(anchors[0]), ['127.0.0.1:8081/']);
});

test('渲染：宿主没给面板地址时回退到默认值', () => {
  const { cards, t } = boot([
    'ready', ROWS, {}, '', new Set(), new Set(), false, undefined,
    { version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] },
    undefined, undefined, undefined,
  ]);
  const anchors = collectByType(cards[0].component({ t, view: 'page' }), 'a');
  assert.equal(anchors[0].props.href, 'http://127.0.0.1:8081/');
});

/** 组件里 useState 的取值顺序：phase/rows/meta/reason/picked/savedPicked/saving/notice/backend/check/busy/notice/confirming。 */
function backendStates(backend, { check, confirming } = {}) {
  return ['ready', ROWS, {}, '', new Set(), new Set(), false, undefined, backend, check, undefined, undefined, confirming];
}

/** 渲染后把按钮的文字标签取出来。 */
const button = (buttons, label) => buttons.find((node) => collectText(node).join('') === label);

function buttonLabels(tree) {
  return collectByType(tree, 'button').map((node) => collectText(node).join(''));
}

/** 卡片 13 个 state + useUpdater 的 2 个之后，才是「复制初始管理密码」的 state。 */
function panelKeyStates(panelKey) {
  const backend = { exeExists: true, version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] };
  return [...backendStates(backend), ...Array(2).fill(undefined), panelKey];
}

test('复制初始管理密码：按钮挨着面板链接；复制成功给提示，剪贴板不可用时显示原文供手动复制', () => {
  const idle = boot(panelKeyStates(undefined));
  const panelLine = collectByType(idle.cards[0].component({ t: idle.t, view: 'page' }), 'p').find(
    (node) => node.props.className === 'dsm-oc-panel',
  );
  assert.ok(buttonLabels(panelLine).includes('复制初始管理密码'), '按钮应在面板链接那一行');

  const busy = boot(panelKeyStates({ busy: true }));
  const busyButton = collectByType(busy.cards[0].component({ t: busy.t, view: 'page' }), 'button').find(
    (node) => collectText(node).join('') === '读取中…',
  );
  assert.equal(busyButton?.props.disabled, true);

  const copied = boot(panelKeyStates({ kind: 'ok', text: '已复制' }));
  assert.ok(collectText(copied.cards[0].component({ t: copied.t, view: 'page' })).includes('已复制'));

  const manual = boot(panelKeyStates({ kind: 'manual', key: 'panel-secret' }));
  const codes = collectByType(manual.cards[0].component({ t: manual.t, view: 'page' }), 'code');
  assert.deepEqual(codes.map((node) => collectText(node).join('')), ['panel-secret']);
});

/** 只取"后端版本"那一块：卡片底部还有插件自身的更新区，它也有"检查更新"按钮。 */
function backendSection(tree) {
  return collectByType(tree, 'div').find(
    (node) => node.props.className === 'dsm-oc-backend' && collectText(node).includes('后端版本'),
  );
}

test('后端区（已安装）：显示 更新/卸载/回滚，不显示 安装；卸载是危险色', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] }),
  );
  const tree = cards[0].component({ t, view: 'page' });
  const labels = buttonLabels(backendSection(tree));

  assert.ok(labels.includes('更新'), '已安装应显示更新');
  assert.ok(labels.includes('卸载'), '已安装应显示卸载');
  assert.ok(labels.includes('回滚'), '已安装应显示回滚');
  assert.equal(labels.includes('安装'), false, '已安装不该显示安装（与卸载互斥）');

  // 顺序：更新 → 回滚 → 卸载（卸载放最后，离"检查更新"最远，减少误点）
  assert.deepEqual(labels.slice(-4), ['检查更新', '更新', '回滚', '卸载'], '后端按钮顺序应为 更新 → 回滚 → 卸载');

  const uninstall = collectByType(tree, 'button').find((node) => collectText(node).join('') === '卸载');
  assert.match(uninstall.props.className, /dsm-oc-btn-danger/, '卸载按钮用危险色');
});

test('模型区：后端没装时提示去点安装，而不是裸的 fetch failed', () => {
  const { cards, t } = boot(['error', [], {}, 'backend-not-installed', new Set(), new Set(), false, undefined,
    { exeExists: false, version: {}, history: [] }]);
  const texts = collectText(cards[0].component({ t, view: 'page' }));
  assert.ok(texts.some((text) => text.includes('后端还没有安装') && text.includes('「安装」')));
  assert.equal(texts.includes('backend-not-installed'), false, '状态码不能原样露给用户');

  const other = boot(['error', [], {}, 'fetch failed', new Set(), new Set()]);
  assert.ok(collectText(other.cards[0].component({ t: other.t, view: 'page' })).includes('fetch failed'), '其它错误照原文显示');
});

test('后端区（未安装）：显示 安装，不显示 更新/卸载/回滚', () => {
  const { cards, t } = boot(backendStates({ exeExists: false, version: {}, history: [] }));
  const labels = buttonLabels(backendSection(cards[0].component({ t, view: 'page' })));

  assert.ok(labels.includes('安装'), '未安装应显示安装');
  assert.equal(labels.includes('卸载'), false, '未安装不该显示卸载（与安装互斥）');
  assert.equal(labels.includes('更新'), false, '未安装没有可更新的东西');
  assert.equal(labels.includes('回滚'), false, '未安装没有可回滚的版本');
  assert.ok(labels.includes('检查更新'), '检查更新始终可用');
  assert.deepEqual(labels.slice(-2), ['检查更新', '安装'], '未安装时后端按钮应为 检查更新 → 安装');
});

test('卸载二次确认：弹出 Modal，含确认与取消两个按钮', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, version: {}, history: [] }, { confirming: true }),
  );
  const tree = render(cards[0].component({ t, view: 'page' }));
  const texts = collectText(tree);

  assert.ok(texts.includes('卸载后端？'), '应显示确认标题');
  assert.ok(texts.some((text) => text.includes('会停止后端')), '应说明删什么');
  assert.ok(texts.some((text) => text.includes('账号凭证与状态')), '应说明保留什么');
  assert.ok(collectByType(tree, 'div').some((node) => node.props.className === 'dsm-modal'), '走的是宿主 Modal');

  const labels = buttonLabels(tree);
  assert.ok(labels.includes('确认卸载'));
  assert.ok(labels.includes('取消'));
});

test('卸载二次确认：拿不到宿主 Modal 时退回行内确认（仍是二次确认）', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, version: {}, history: [] }, { confirming: true }),
    { withPrimitives: false },
  );
  const tree = cards[0].component({ t, view: 'page' });
  const texts = collectText(tree);

  assert.ok(texts.includes('卸载后端？'));
  assert.ok(buttonLabels(tree).includes('确认卸载'));
  assert.equal(
    collectByType(tree, 'div').some((node) => node.props.className === 'dsm-modal'),
    false,
    '没有宿主组件时不该假装有弹窗',
  );
  assert.ok(collectByType(tree, 'div').some((node) => node.props.className === 'dsm-oc-confirm'), '应走行内确认');
});

test('彻底卸载：目录存在时紧跟在卸载右侧显示危险色按钮', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, rootExists: true, root: 'C:/Users/me/.dsh/autostart-opencode2api', version: {}, history: [] }),
  );
  const tree = cards[0].component({ t, view: 'page' });
  const labels = buttonLabels(backendSection(tree));
  assert.deepEqual(labels.slice(-5), ['检查更新', '更新', '回滚', '卸载', '彻底卸载']);

  const purge = collectByType(tree, 'button').find((node) => collectText(node).join('') === '彻底卸载');
  assert.match(purge.props.className, /dsm-oc-btn-danger/);
  assert.ok(collectText(tree).some((text) => text.includes('C:/Users/me/.dsh/autostart-opencode2api')), '提示里应写明会删哪个目录');

  // 后端没装但目录还在（只剩日志 / 凭证）时同样可以清。
  const leftover = boot(backendStates({ exeExists: false, rootExists: true, root: 'x', version: {}, history: [] }));
  assert.ok(buttonLabels(backendSection(leftover.cards[0].component({ t: leftover.t, view: 'page' }))).includes('彻底卸载'));

  const gone = boot(backendStates({ exeExists: false, rootExists: false, version: {}, history: [] }));
  assert.equal(buttonLabels(backendSection(gone.cards[0].component({ t: gone.t, view: 'page' }))).includes('彻底卸载'), false, '目录不在时不显示');
});

test('彻底卸载二次确认：弹窗说明会删整个目录且不可撤销', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, rootExists: true, root: 'D:/dsh/autostart-opencode2api', version: {}, history: [] }, { confirming: 'purge' }),
  );
  const tree = render(cards[0].component({ t, view: 'page' }));
  const texts = collectText(tree);

  assert.ok(texts.includes('彻底卸载后端？'));
  assert.ok(texts.some((text) => text.includes('D:/dsh/autostart-opencode2api') && text.includes('账号凭证')), '应说明删哪个目录、含凭证');
  assert.ok(texts.some((text) => text.includes('无法撤销')));
  assert.equal(texts.includes('卸载后端？'), false, '不能弹成卸载的确认');
  const labels = buttonLabels(tree);
  assert.ok(labels.includes('确认彻底卸载'));
  assert.ok(labels.includes('取消'));
});

test('卸载二次确认：未点开时不出现确认界面', () => {
  const { cards, t } = boot(backendStates({ exeExists: true, version: {}, history: [] }));
  const texts = collectText(cards[0].component({ t, view: 'page' }));
  assert.equal(texts.includes('卸载后端？'), false);
});

// ---- 插件自身更新区（仅官方接口） ----

function collect(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (Array.isArray(node.children)) collect(node.children, predicate, out);
  return out;
}

const buttons = (tree) => collect(tree, (node) => node.type === 'button');
const buttonByLabel = (tree, label) => buttons(tree).find((node) => collectText(node.children).join('') === label);

const noop = () => {};
const actions = { checkUpdate: noop, startUpdate: noop, copyInstallSpec: noop };

test('插件更新区：首屏（hooks 状态尚未就绪）显示检查中，且排在后端版本区之后', () => {
  const { cards, t } = boot(backendStates({ exeExists: true, version: { tag: 'v1.13.0' }, history: [] }));
  const tree = cards[0].component({ t, view: 'page' });
  assert.ok(collectText(tree).includes('正在检查更新…'));
  const sections = collectByType(tree, 'div').filter((node) => node.props.className === 'dsm-oc-backend');
  assert.deepEqual(
    sections.map((node) => collectText(node)[0]),
    ['后端版本', '插件更新'],
    '插件更新区应在后端版本区之后，两块各自独立',
  );
});

function updateModel(overrides = {}) {
  return {
    version: { phase: 'ready', ok: true, currentVersion: '26.10.11', latestVersion: '26.10.12', updateAvailable: true },
    manager: { phase: 'ready', candidate: '26.10.12', registry: 'https://registry.npmjs.org/', installedVersion: '26.10.11' },
    busy: false,
    ...overrides,
  };
}

const VERSION_ROUTE = '/plugins/dsh-opencode2api/version';
const MARKET_ROUTE = '/dsh-market/api/v1';
const UP_TO_DATE = { phase: 'ready', ok: true, currentVersion: '26.10.12', latestVersion: '26.10.12', updateAvailable: false };
const text = (tree) => collectText(tree).join('|');
const pinnedOf = (tree) => collect(tree, (node) => node.type === 'details' && node.props.key === 'pinnedInstall')[0];
const hasUpdateButton = (tree) => buttons(tree).some((node) => collectText(node.children).join('').startsWith('更新到'));
/** 让挂起的 promise 链跑完（setImmediate 不在 mock.timers 的接管范围内）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** rc.3 的插件管理器：listBundles 带安装来源，没有 listVersions / updateBundle。 */
function legacyManager(extra = {}) {
  const bundle = { name: PACKAGE_NAME, version: '26.10.11', source: `${PACKAGE_NAME}@26.10.11`, availability: 'profile', official: false, ...extra };
  return { bundle, manager: { listBundles: async () => ({ ok: true, value: [bundle] }) } };
}

function updaterHarness({ manager, result, versions, bundle, crypto, version, market } = {}) {
  const calls = [];
  const events = new Map();
  const versionPayload = version ?? { ...updateModel().version };
  const fetcher = async (path, options = {}) => {
    calls.push(['fetch', path, options.method ?? 'GET', ...(options.body === undefined ? [] : [JSON.parse(options.body)])]);
    if (path.startsWith(VERSION_ROUTE)) {
      assert.match(path, /^\/plugins\/dsh-opencode2api\/version(?:\?force=1)?$/);
      return { ok: true, status: 200, json: async () => versionPayload };
    }
    if (path.startsWith(MARKET_ROUTE)) {
      // 没装 dshmarket 时宿主对这条路径答 404 且不是 JSON
      const [status, payload] = market?.(options.method ?? 'GET', path) ?? [404, undefined];
      return { ok: status >= 200 && status < 300, status, json: async () => { if (payload === undefined) throw new Error('not json'); return payload; } };
    }
    throw new Error('Unexpected fetch: ' + path);
  };
  const { module } = boot([], { fetchImpl: fetcher, crypto });
  const remote = {
    $on: (event, listener) => { events.set(event, listener); return () => events.delete(event); },
    pluginManager: manager ?? {
      listBundles: async () => ({ ok: true, value: [bundle ?? { name: PACKAGE_NAME, version: '26.10.11', source: PACKAGE_NAME + '@26.10.11', availability: 'profile', updatable: true }] }),
      listVersions: async (name, options) => {
        calls.push(['listVersions', name, options]);
        return { ok: true, value: versions ?? { status: 'listed', installed: '26.10.11', registry: 'https://registry.example/', versions: [
          { version: '26.10.12', bundle: true, prerelease: false, tags: ['latest'] },
        ] } };
      },
      updateBundle: async (...args) => {
        calls.push(['updateBundle', ...args]);
        return typeof result === 'function' ? result(...args) : { ok: true, value: result ?? {
          from: '26.10.11', to: '26.10.12', step: 'install',
          result: { changed: true, application: 'restart-required', version: '26.10.12' },
        } };
      },
    },
  };
  return { module, updater: module.createPluginUpdater(remote), remote, calls, events, versionPayload };
}

const fetched = (calls) => calls.filter((call) => call[0] === 'fetch').map((call) => call[1]);

test('旧宿主：缺少官方接口时探测 dshmarket，市场不在时不提交更新', async () => {
  for (const variant of ['none', 'legacy', 'throws']) {
    const h = updaterHarness({ manager: variant === 'legacy' ? legacyManager().manager : {} });
    if (variant === 'throws') {
      // 宿主没有 remote.pluginManager 命名空间时，cordis 取值直接抛错
      Object.defineProperty(h.remote, 'pluginManager', { get: () => { throw new Error('cannot get property without inject'); } });
    }
    await h.updater.check();
    const snapshot = h.updater.getSnapshot();
    assert.equal(snapshot.manager.phase, 'unsupported');
    assert.equal(snapshot.market.phase, 'absent');
    assert.equal(snapshot.version.latestVersion, '26.10.12');
    await h.updater.startUpdate();
    assert.deepEqual(fetched(h.calls), [VERSION_ROUTE, MARKET_ROUTE + '/capabilities']);
    assert.equal(h.calls.some((call) => call[0] !== 'fetch'), false);
    await h.updater.check(true);
    assert.ok(fetched(h.calls).includes(`${VERSION_ROUTE}?force=1`));
  }
});

test('官方更新：明确版本和查询注册表传给宿主，重复点击只提交一次，进度按 requestId 隔离', async () => {
  let finish;
  const h = updaterHarness({ result: () => new Promise(resolve => { finish = resolve; }) });
  await h.updater.check();
  const first = h.updater.startUpdate();
  assert.equal(h.updater.startUpdate(), first);
  await flush();
  const call = h.calls.find(c => c[0] === 'updateBundle');
  assert.equal(call[1], PACKAGE_NAME);
  assert.equal(call[2], '26.10.12');
  assert.deepEqual(Object.keys(call[3]).sort(), ['registry', 'requestId']);
  assert.equal(call[3].registry, 'https://registry.example/');
  assert.match(call[3].requestId, /^[0-9a-f-]{36}$/);
  const emit = h.events.get('plugin-manager/update-state');
  emit({ requestId: 'other', step: 'restoring' });
  assert.equal(h.updater.getSnapshot().operation.step, 'checking');
  emit({ requestId: call[3].requestId, step: 'installing' });
  assert.equal(h.updater.getSnapshot().operation.step, 'installing');
  finish({ ok: true, value: { from: '26.10.11', to: '26.10.12', step: 'install',
    result: { application: 'restart-required', version: '26.10.12' } } });
  await first;
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
  assert.equal(h.updater.getSnapshot().operation.outcome.restartRequired, true);
  assert.equal(h.updater.getSnapshot().manager.candidate, undefined);
  assert.equal(h.events.size, 0);
  assert.equal(h.calls.filter(c => c[0] === 'updateBundle').length, 1);
  assert.equal(h.calls.some((c) => c[1]?.startsWith?.('/dsh-market/')), false, '有官方接口时不探测市场');
});

test('官方更新：卡片取消订阅不取消宿主操作，新卡片能读共享进度与结果', async () => {
  let finish;
  const h = updaterHarness({ result: () => new Promise(resolve => { finish = resolve; }) });
  await h.updater.check();
  let observed = 0;
  const off = h.updater.subscribe(() => observed++);
  const pending = h.updater.startUpdate();
  off();
  await flush();
  assert.equal(h.updater.getSnapshot().busy, true);
  const seen = observed;
  finish({ ok: true, value: { from: '26.10.11', to: '26.10.12', step: 'install', result: { application: 'applied', version: '26.10.12' } } });
  await pending;
  assert.equal(observed, seen);
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
});

test('官方更新：非安全 HTTP 页面没有 randomUUID 时仍能提交合法请求 ID', async () => {
  const h = updaterHarness({ crypto: { getRandomValues: value => webcrypto.getRandomValues(value) } });
  await h.updater.check();
  await h.updater.startUpdate();
  const call = h.calls.find(c => c[0] === 'updateBundle');
  assert.match(call[3].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
});

test('官方更新：版本路由识别为本地安装时，不查询候选版本或提交更新', async () => {
  const version = { ok: true, currentVersion: '26.10.11', installSource: 'local', updateAvailable: false };
  for (const manager of [undefined, {}, legacyManager().manager]) {
    const h = updaterHarness({ manager, version });
    await h.updater.check(true);
    assert.equal(h.updater.getSnapshot().manager.local, true);
    assert.equal(h.updater.getSnapshot().manager.phase, 'blocked');
    await h.updater.startUpdate();
    assert.deepEqual(h.calls, [['fetch', VERSION_ROUTE + '?force=1', 'GET']]);
  }
});

test('官方更新：宿主拒绝资格或查询错误时不回退市场，也不提交安装', async () => {
  for (const [reply, phase] of [
    [{ status: 'refused', problem: 'not-updatable', reason: 'local install' }, 'blocked'],
    [{ status: 'refused', problem: 'registry-error', reason: 'offline' }, 'error'],
  ]) {
    const h = updaterHarness({ versions: reply });
    await h.updater.check();
    assert.equal(h.updater.getSnapshot().manager.phase, phase);
    await h.updater.startUpdate();
    assert.deepEqual(fetched(h.calls), [VERSION_ROUTE]);
    assert.equal(h.calls.some(call => call[0] === 'updateBundle'), false);
  }
});

test('官方更新：插件卸载后不再提交已排队的写操作或向旧卡片广播', async () => {
  const h = updaterHarness();
  await h.updater.check();
  let observed = 0;
  h.updater.subscribe(() => observed++);
  const pending = h.updater.startUpdate();
  const seen = observed;
  h.updater.dispose();
  await pending;
  await h.updater.startUpdate();
  await h.updater.check(true);
  assert.equal(observed, seen);
  assert.equal(h.calls.some(call => call[0] === 'updateBundle'), false);
  assert.deepEqual(fetched(h.calls), [VERSION_ROUTE]);
});

test('官方更新：本地、托管及不可更新安装不查询可用版本，也不提交更新', async () => {
  for (const extra of [{ source: 'file:D:/source', updatable: false }, { official: true, availability: 'installation', updatable: false }, { updatable: false }]) {
    const h = updaterHarness({ bundle: { name: PACKAGE_NAME, version: '26.10.11', ...extra } });
    await h.updater.check();
    assert.equal(h.updater.getSnapshot().manager.phase, 'blocked');
    await h.updater.startUpdate();
    assert.deepEqual(h.calls.map(c => c[0]), ['fetch']);
  }
});

test('官方更新：跳过不兼容、弃用、预发布、非 bundle 版本，采用宿主兼容正式版', async () => {
  const versions = { status: 'listed', installed: '26.10.11', registry: null, versions: [
    { version: '27.1.1', bundle: true, prerelease: false, incompatible: {} },
    { version: '26.11.2', bundle: true, prerelease: false, deprecated: 'retired' },
    { version: '26.11.1-rc.1', bundle: true, prerelease: true },
    { version: '26.10.31', bundle: false, prerelease: false },
    { version: '26.10.12', bundle: true, prerelease: false },
  ] };
  const h = updaterHarness({ versions });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().manager.candidate, '26.10.12');
  versions.versions.pop();
  await h.updater.check(true);
  assert.equal(h.updater.getSnapshot().manager.candidate, undefined);
  await h.updater.startUpdate();
  assert.equal(h.calls.some(c => c[0] === 'updateBundle'), false);
});

test('官方更新：版本列表按已装版本缓存；npm 已是最新时不列，「检查更新」照样去列', async () => {
  const listed = (h) => h.calls.filter((call) => call[0] === 'listVersions').length;
  const h = updaterHarness();
  await h.updater.check();
  await h.updater.check();
  assert.equal(listed(h), 1, '重新挂载复用缓存，不在宿主上再跑一串 pnpm view');
  await h.updater.check(true);
  assert.equal(listed(h), 2);

  const quiet = updaterHarness({ version: { ...UP_TO_DATE, currentVersion: '26.10.11', latestVersion: '26.10.11' } });
  await quiet.updater.check();
  assert.equal(listed(quiet), 0);
  assert.equal(quiet.updater.getSnapshot().manager.phase, 'ready');
  assert.equal(quiet.updater.getSnapshot().manager.candidate, undefined);
  await quiet.updater.check(true);
  assert.equal(listed(quiet), 1);
  assert.equal(quiet.updater.getSnapshot().manager.candidate, '26.10.12', 'npm 落后于宿主注册表时，手动检查仍能找到新版本');
  await quiet.updater.check();
  assert.equal(listed(quiet), 1);
  assert.equal(quiet.updater.getSnapshot().manager.candidate, '26.10.12', '缓存期内重新挂载不丢掉刚查到的版本');
});

test('官方更新：查询失败与不支持分开显示，恢复连接后可以重新检查', async () => {
  const versions = { status: 'refused', problem: 'network', reason: 'offline' };
  const h = updaterHarness({ versions });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().manager.phase, 'error');
  assert.equal(h.updater.getSnapshot().manager.reason, 'offline');
  await h.updater.startUpdate();
  assert.equal(h.calls.some(c => c[0] === 'updateBundle'), false);
  Object.assign(versions, { status: 'listed', installed: '26.10.11', versions: [], registry: null });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().manager.phase, 'ready');
});

test('官方更新：失败、取消、回滚成功、回滚失败、版本不符与连接中断不会误报成功', async () => {
  const failed = { application: 'failed', error: { diagnostic: 'install failed' } };
  const cases = [
    [{ from: '26.10.11', step: 'install', result: failed }, 'failed'],
    [{ from: '26.10.11', step: 'install', result: { application: 'cancelled' } }, 'cancelled'],
    [{ from: '26.10.11', step: 'install', result: failed, restore: { application: 'applied', version: '26.10.11' } }, 'rolled-back'],
    [{ from: '26.10.11', step: 'install', result: failed, restore: failed }, 'failed'],
    [{ from: '26.10.11', step: 'install', result: { application: 'applied', version: '26.10.10' } }, 'failed'],
    [{ from: '26.10.11', step: 'remove', result: { application: 'applied', version: '26.10.12' } }, 'failed'],
  ];
  for (const [result, state] of cases) {
    const h = updaterHarness({ result });
    await h.updater.check();
    await h.updater.startUpdate();
    assert.equal(h.updater.getSnapshot().operation.state, state);
    assert.equal(h.updater.getSnapshot().busy, false);
    if (result.restore?.application === 'failed') assert.equal(h.updater.getSnapshot().operation.restoreFailure, 'install failed');
  }
  for (const result of [async () => { throw new Error('connection reset'); }, async () => ({ ok: false, error: { message: 'host lost' } })]) {
    const h = updaterHarness({ result });
    await h.updater.check();
    await h.updater.startUpdate();
    assert.equal(h.updater.getSnapshot().operation.unknown, true);
    assert.equal(h.updater.getSnapshot().operation.state, 'failed');
  }
});

test('官方更新：重新检查以实际安装版本为准，不沿用外部重装之前的成功状态', async () => {
  const bundle = { name: PACKAGE_NAME, version: '26.10.11', updatable: true };
  const versions = { status: 'listed', installed: '26.10.11', registry: null, versions: [
    { version: '26.10.12', bundle: true, prerelease: false },
  ] };
  const h = updaterHarness({ bundle, versions });
  await h.updater.check();
  await h.updater.startUpdate();
  bundle.version = versions.installed = '26.10.12';
  versions.versions = [];
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
  bundle.version = versions.installed = '26.10.11';
  versions.versions = [{ version: '26.10.12', bundle: true, prerelease: false }];
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().operation, undefined);
  assert.equal(h.updater.getSnapshot().manager.candidate, '26.10.12');
});

test('官方更新：插件管理器广播变更时静默重读；宿主不认识该事件也不影响卡片注册', async () => {
  const h = updaterHarness();
  await h.updater.check();
  const pending = h.updater.refresh();
  assert.equal(h.updater.getSnapshot().version.phase, 'ready', '静默重读不把区块切成"正在检查"');
  assert.equal(h.updater.getSnapshot().manager.phase, 'ready');
  await pending;
  assert.equal(h.updater.getSnapshot().manager.candidate, '26.10.12');

  const { events } = boot();
  assert.equal(typeof events.get('plugin-manager/changed'), 'function');
  const original = console.warn;
  console.warn = () => {};
  try {
    const { cards } = boot([], { $on: (event) => {
      if (event === 'plugin-manager/changed') throw new Error('unknown event');
      return () => {};
    } });
    assert.equal(cards.length, 2);
  } finally {
    console.warn = original;
  }
});

test('插件更新 UI：官方接口只给宿主确认的兼容正式版；本地、托管与不可更新安装不给按钮，也不给指定版本安装', () => {
  const { module, t } = boot();
  const view = (overrides) => render(module.renderUpdateSection(updateModel(overrides), actions, t));
  const current = view();
  assert.ok(buttonByLabel(current, '更新到 v26.10.12'));
  assert.match(text(current), /当前运行版本：\|v26\.10\.11/);
  assert.match(text(current), /npm 最新版本：\|v26\.10\.12/);
  assert.equal(pinnedOf(current), undefined);
  for (const [manager, hint] of [
    [{ phase: 'blocked', local: true }, /从本地目录安装/],
    [{ phase: 'blocked', managed: true }, /由 DSH 统一管理/],
    [{ phase: 'blocked' }, /不支持更新此安装/],
    [{ phase: 'ready' }, /暂未提供可更新的兼容正式版/],
    [{ phase: 'ready', candidate: '26.10.11', installedVersion: '26.10.11' }, /暂未提供可更新的兼容正式版/],
  ]) {
    const tree = view({ manager });
    assert.equal(hasUpdateButton(tree), false);
    assert.match(text(tree), hint);
    assert.equal(pinnedOf(tree), undefined, '官方已给出结论时不建议绕过它的更新资格');
  }
  const failed = view({ manager: { phase: 'error', reason: 'offline' } });
  assert.match(text(failed), /官方插件管理器检查失败：offline/);
  assert.equal(pinnedOf(failed).props.open, false);
});

test('插件更新 UI：已是最新时不显示"为什么不能一键更新"的说明', () => {
  const { module, t } = boot();
  const view = (overrides) => render(module.renderUpdateSection(updateModel(overrides), actions, t));
  for (const overrides of [
    { manager: { phase: 'unsupported' }, market: { phase: 'absent' } },
    { manager: { phase: 'blocked', managed: true } },
    { manager: { phase: 'blocked' } },
    { manager: { phase: 'ready' } },
  ]) {
    const unavailable = (tree) => collect(tree, (node) => node.props.key === 'unavailable');
    assert.equal(unavailable(view(overrides)).length, 1);
    const latest = view({ ...overrides, version: UP_TO_DATE });
    assert.equal(unavailable(latest).length, 0);
    assert.equal(pinnedOf(latest), undefined);
    assert.match(text(latest), /已是最新/);
  }
});

test('插件更新 UI：官方更新显示宿主阶段、重启提示与恢复失败；不给强制更新和重启按钮', () => {
  const { module, t } = boot();
  const view = (overrides) => render(module.renderUpdateSection(updateModel(overrides), actions, t));
  const running = view({ busy: true, operation: { channel: 'official', state: 'running', step: 'restoring' } });
  assert.match(text(running), /正在恢复旧版本/);
  assert.equal(buttonByLabel(running, '检查更新').props.disabled, true);
  const done = view({ operation: { channel: 'official', state: 'succeeded', installedVersion: '26.10.12', outcome: { restartRequired: true } } });
  assert.match(text(done), /等待重启/);
  assert.match(text(done), /重启 DSH 后生效/);
  assert.equal(hasUpdateButton(done), false);
  const rolledBack = view({ operation: { channel: 'official', state: 'rolled-back', installedVersion: '26.10.11', failure: { message: 'install error' }, outcome: {} } });
  assert.match(text(rolledBack), /更新失败：install error 更新已回滚，插件保持在 v26\.10\.11。/);
  const failed = view({ operation: { channel: 'official', state: 'failed', failure: { message: 'install error' }, restoreFailure: 'offline', unknown: true } });
  assert.match(text(failed), /恢复旧版本失败：offline/);
  assert.match(text(failed), /未能确认更新结果/);
  for (const tree of [running, done, rolledBack, failed]) {
    assert.equal(buttonByLabel(tree, '立即重启 DSH'), undefined);
    assert.equal(buttonByLabel(tree, '强制更新'), undefined);
  }
});

test('官方更新 UI：npm latest 滞后不隐藏官方新版本；两处卡片共享更新器', () => {
  const { module, t, cards } = boot();
  assert.equal(cards[0].spec.inject().api.updater, cards[1].spec.inject().api.updater);
  const tree = render(module.renderUpdateSection(updateModel({ version: {
    phase: 'ready', currentVersion: '26.10.11', latestVersion: '26.10.11', updateAvailable: false,
  } }), actions, t));
  assert.match(text(tree), /有新版本/);
  assert.ok(buttonByLabel(tree, '更新到 v26.10.12'));
});

test('插件更新 UI：已是最新 / 检查失败', () => {
  const { module, t } = boot();
  const latest = render(module.renderUpdateSection(updateModel({ version: UP_TO_DATE, manager: { phase: 'ready', installedVersion: '26.10.12' } }), actions, t));
  assert.match(text(latest), /已是最新/);
  assert.equal(hasUpdateButton(latest), false);

  const failed = render(module.renderUpdateSection(updateModel({ version: { phase: 'error', currentVersion: '26.10.11', reason: '连不上注册表' } }), actions, t));
  assert.match(text(failed), /检查更新失败：连不上注册表/);
  assert.match(text(failed), /当前运行版本：\|v26\.10\.11/);
  assert.equal(buttonByLabel(failed, '检查更新').props.disabled, false);
});

test('旧宿主 UI：没有市场时提示装 dshmarket、升级 DSH 或指定版本安装，没有强制更新和重启入口', () => {
  const { module, t } = boot();
  const tree = module.renderUpdateSection(updateModel({ manager: { phase: 'unsupported' }, market: { phase: 'absent' } }), actions, t);
  assert.match(text(tree), /还没有官方插件更新接口/);
  assert.match(text(tree), /dshmarket/);
  assert.match(text(tree), /升级 DSH/);
  assert.doesNotMatch(text(tree), /强制更新|立即重启/);
  assert.equal(hasUpdateButton(tree), false);
  assert.equal(pinnedOf(tree).props.open, true);
  const input = collectByType(pinnedOf(tree), 'input')[0];
  assert.equal(input.props.value, PACKAGE_NAME + '@26.10.12');
  assert.equal(input.props.readOnly, true);
});

test('本地安装显示渠道说明，不报 npm 检查错误，也不提供 npm 更新按钮', () => {
  const { module, t } = boot();
  const tree = module.renderUpdateSection(updateModel({
    version: { phase: 'ready', ok: true, currentVersion: '26.10.15', installSource: 'local', updateAvailable: false },
  }), actions, t);
  assert.match(text(tree), /本地安装/);
  assert.match(text(tree), /更新源码/);
  assert.match(text(tree), /v26\.10\.15/);
  assert.doesNotMatch(text(tree), /检查更新失败|npm 最新版本|undefined|已是最新/);
  assert.equal(buttons(tree).length, 0);
});

test('指定版本安装：版本规格校验与卡片复制动作，剪贴板失败时保留手动复制', async () => {
  const { module } = boot();
  assert.equal(module.pinnedInstallSpec('v26.10.17'), PACKAGE_NAME + '@26.10.17');
  assert.equal(module.pinnedInstallSpec('27.1.1-rc.1+build.2'), `${PACKAGE_NAME}@27.1.1-rc.1+build.2`);
  for (const value of [undefined, 'latest', '^26.10.17', '26.10.17.1', 'https://example.com/pkg.tgz', '26.10.17 --force']) assert.equal(module.pinnedInstallSpec(value), undefined);
  for (const clipboard of [{ writeText: async value => { assert.equal(value, PACKAGE_NAME + '@26.10.12'); } }, undefined]) {
    const update = updateModel({ manager: { phase: 'unsupported' } });
    // 13 个模型/后端状态之后，是共享插件更新快照和复制提示。
    const app = boot([...backendStates({}), update, undefined], { clipboard });
    const view = () => render(app.renderCard());
    await buttonByLabel(view(), '复制包名和版本').props.onClick();
    assert.match(text(view()), clipboard ? /已复制/ : /手动复制/);
  }
});

test('第二后端选择与专用访问密钥按钮显示在卡片中',()=>{
  const states=['loading',[],{},'',new Set(),new Set(),false,undefined,{gateway:'tiara',gateways:['jasonxu','tiara'],exeExists:false,version:{},history:[]}];
  const {cards}=boot(states);const tree=cards[0].component({t:boot().t,view:'page'});
  const text=collectText(tree).join(' ');
  assert.match(text,/后端网关/);assert.match(text,/TiaraBasori/);assert.match(text,/复制面板访问密钥/);
  const buttons=collectByType(tree,'button');
  assert.equal(buttons.find(node=>collectText(node).join('')==='TiaraBasori').props.disabled,true);
  assert.equal(buttons.find(node=>collectText(node).join('')==='jasonxu114514（默认）').props.disabled,false);
});

test('切换等待跨过旧路由与短暂失败，新网关未安装时直接返回',async()=>{
  let calls=0;
  const ready=boot([],{fetchImpl:async(url)=>{
    calls++;
    if(calls===1)throw new Error('restarting');
    const body=String(url).endsWith('/backend')?{backend:{gateway:calls<3?'jasonxu':'tiara',exeExists:true}}:{ok:true};
    return {ok:true,status:200,json:async()=>body};
  }});
  assert.equal(await ready.module.waitForGateway('tiara',{waitMs:100,pollMs:1,sleep:async()=>{}}),'ready');assert.ok(calls>=4);
  const absent=boot([],{fetchImpl:async()=>({ok:true,status:200,json:async()=>({backend:{gateway:'tiara',exeExists:false}})})});
  assert.equal(await absent.module.waitForGateway('tiara',{waitMs:100,pollMs:1,sleep:async()=>{}}),'not-installed');
});

test('切换后端按钮自动刷新并保存同步，完成前不宣告成功，保留宿主选择', async () => {
  for (const sync of [{ state: 'updated' }, { state: 'failed', reason: '保存 DSH 凭据失败' }]) {
    const calls = [];
    const backend = { gateway: 'jasonxu', gateways: ['jasonxu', 'tiara'], exeExists: true, version: {}, history: [] };
    const inventory = { ok: true, enabled: true, only: ['saved-model'], models: ROWS };
    const app = boot(backendStates(backend), { fetchImpl: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method, body });
      const payload = path.endsWith('/backend')
        ? options.method === 'POST' ? { ok: true, state: 'switched' } : { ok: true, backend: { ...backend, gateway: 'tiara' } }
        : options.method === 'GET' ? inventory : { ok: true, sync };
      return { ok: true, json: async () => payload };
    } });
    await button(collectByType(app.renderCard(), 'button'), 'TiaraBasori').props.onClick();
    assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.body), [
      { action: 'gateway', gateway: 'tiara' }, { gateway: 'tiara', enabled: true },
    ], '只传同步开关，让宿主读取已有完整白名单');
    const text = collectText(app.renderCard()).join('|');
    if (sync.state === 'failed') {
      assert.match(text, /后端已切换，但自动同步未完成：保存 DSH 凭据失败/);
      assert.doesNotMatch(text, /模型、地址和凭据已自动保存并同步/);
    } else assert.match(text, /已切换到 TiaraBasori，模型、地址和凭据已自动保存并同步/);
  }
});

test('切换后自动同步保持关闭状态，目录或保存失败时报告失败', async () => {
  for (const [inventory, saved, expected] of [
    [{ ok: true, enabled: false }, undefined, 'disabled'],
    [{ ok: false, reason: '目录读取失败' }, undefined, 'failed'],
    [{ ok: true, enabled: true }, { ok: false, reason: 'profile locked' }, 'failed'],
    [{ ok: true, enabled: true }, { ok: true, sync: { state: 'skipped', reason: '白名单没有匹配项' } }, 'failed'],
  ]) {
    const calls = [];
    const { module } = boot([], { fetchImpl: async (_path, options) => {
      calls.push(options.method);
      return { ok: true, json: async () => options.method === 'GET' ? inventory : saved };
    } });
    assert.equal((await module.syncGatewayModels('tiara')).state, expected);
    assert.deepEqual(calls, saved ? ['GET', 'POST'] : ['GET']);
  }
});

test('返回安装页面恢复进度：显示下载字节、用时和后台提示，隐藏未安装红字', () => {
  const states = ['error', [], {}, 'backend-not-installed', new Set(), new Set(), false, undefined,
    { gateway: 'tiara', gateways: ['jasonxu', 'tiara'], exeExists: false, version: {}, history: [] },
    undefined, 'install'];
  states[17] = { id: 'ongoing', gateway: 'tiara', action: 'install', state: 'running',
    startedAt: new Date(Date.now() - 30000).toISOString(), progress: { stage: 'runtime', detail: '下载 OpenCode 运行时', received: 1048576, total: 2097152 } };
  const { cards, t } = boot(states), tree = cards[0].component({ t, view: 'page' });
  const text = collectText(tree).join(' ');
  assert.match(text, /下载 OpenCode 运行时/); assert.match(text, /1.0 MB \/ 2.0 MB \(50%\)/);
  assert.match(text, /已用时 30 秒/); assert.match(text, /可以离开此页面/);
  assert.doesNotMatch(text, /后端还没有安装/);
  assert.equal(collectByType(tree, 'button').find(node => collectText(node).join('') === '处理中…').props.disabled, true);
});

test('后端区：自动更新开关与状态行（待装 / 已自动更新 / 失败 / 冷却期 / 回滚跳过 / 检查失败 / Tiara 不适用）', () => {
  const { module, t } = boot();
  const toggled = [];
  const render = (auto, tag = 'v1.0.0', busy) => module.renderAutoUpdate(auto, tag, { busy, onToggle: (value) => toggled.push(value) }, t);
  const text = (nodes) => collectText(nodes).join('\n');
  const base = { enabled: true, available: true, unavailable: null, delayHours: 24, pending: null, failed: null, last: null, lastCheck: null };

  assert.deepEqual(render(undefined), [], '老宿主的快照没有 autoUpdate 字段时什么都不显示');

  const idle = render(base);
  const box = collectByType(idle, 'input')[0];
  assert.equal(box.props.checked, true);
  assert.equal(box.props.disabled, false);
  box.props.onChange({ target: { checked: false } });
  assert.deepEqual(toggled, [false]);
  assert.match(text(idle), /自动更新后端/);
  assert.match(text(idle), /发布满 24 小时/);

  assert.match(text(render({ ...base, pending: { tag: 'v1.1.0' } })), /已下载 v1\.1\.0，下次启动 DSH 时自动安装/);
  const last = { from: 'v0.9.0', to: 'v1.0.0', at: '2026-10-19T00:00:00Z' };
  assert.match(text(render({ ...base, last })), /从 v0\.9\.0 更新到 v1\.0\.0/);
  assert.doesNotMatch(text(render({ ...base, last }, 'v0.9.0')), /更新到 v1\.0\.0/, '回滚之后不再说"已自动更新"');
  assert.match(text(render({ ...base, failed: { tag: 'v1.1.0', reason: '/healthz 返回 500' } })), /自动更新到 v1\.1\.0 没成功（\/healthz 返回 500）/);
  assert.doesNotMatch(text(render({ ...base, failed: { tag: 'v1.0.0', reason: 'x' } })), /没成功/, '手动装上了失败过的版本就不再提');
  assert.match(
    text(render({ ...base, lastCheck: { state: 'skipped', reason: 'too-fresh', tag: 'v1.1.0', readyAt: '2026-10-20T00:00:00Z' } })),
    /上游 v1\.1\.0 发布未满 24 小时/,
  );
  assert.match(text(render({ ...base, lastCheck: { state: 'skipped', reason: 'rolled-back', tag: 'v1.1.0' } })), /你从 v1\.1\.0 回滚过/);
  assert.match(text(render({ ...base, lastCheck: { state: 'error', reason: 'fetch failed' } })), /上次自动检查更新失败：fetch failed/);
  assert.doesNotMatch(text(render({ ...base, lastCheck: { state: 'skipped', reason: 'up-to-date', tag: 'v1.0.0' } })), /v1\.0\.0/, '已是最新不多说');

  assert.doesNotMatch(text(render({ ...base, enabled: false, pending: { tag: 'v1.1.0' } })), /已下载/, '关着时不显示状态行');
  const custom = render({ ...base, available: false, unavailable: 'custom-exe' });
  assert.equal(collectByType(custom, 'input')[0].props.disabled, true);
  assert.match(text(custom), /自动更新不生效/);
  const tiara = render({ ...base, available: false, unavailable: 'unsupported-gateway' }, 'main-aaaaaaaaaaaa');
  assert.equal(collectByType(tiara, 'input')[0].props.disabled, true);
  assert.match(text(tiara), /Tiara 没有正式发布版本/);
  assert.equal(collectByType(render(base, 'v1.0.0', 'update'), 'input')[0].props.disabled, true, '有操作在进行时禁用开关');

  // 卡片里：装了才显示（首次安装永远由用户点），位置在后端版本区里。
  const auto = { ...base, pending: { tag: 'v1.1.0' } };
  const installed = boot(backendStates({ exeExists: true, version: { tag: 'v1.0.0' }, history: [], autoUpdate: auto }));
  assert.match(collectText(backendSection(installed.renderCard())).join('\n'), /已下载 v1\.1\.0/);
  const missing = boot(backendStates({ exeExists: false, version: {}, history: [], autoUpdate: auto }));
  assert.doesNotMatch(collectText(missing.renderCard()).join('\n'), /自动更新后端/);
});

/** 装了 dshmarket 的旧宿主：capabilities、安装来源、提交与任务查询都按给定答复走。 */
function marketHost({ operations = [], capabilities = {} } = {}) {
  return (method, path) => {
    if (path === `${MARKET_ROUTE}/capabilities`) {
      return [200, { schema: 'dsh-market/update-api/v1', bootId: 'boot', features: { update: true }, ...capabilities }];
    }
    if (path.startsWith(`${MARKET_ROUTE}/updates?name=`)) return [200, { package: { source: 'npm' } }];
    if (method === 'POST' && path === `${MARKET_ROUTE}/updates`) return [202, { operation: { operationId: 'boot-1', state: 'queued' } }];
    if (path.startsWith(`${MARKET_ROUTE}/operations?operationId=boot-1`)) return [200, { operation: operations.shift() }];
    if (method === 'POST' && path === `${MARKET_ROUTE}/restart`) return [202, {}];
    return undefined;
  };
}

test('dshmarket 兜底：旧宿主装了市场时提交纯包名、轮询到成功，Web 版给重启按钮', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = updaterHarness({
    manager: legacyManager().manager,
    market: marketHost({
      capabilities: { restart: { supported: true } },
      operations: [{ state: 'running', progress: { percent: 40 } }, { state: 'succeeded', installedVersion: '26.10.12', outcome: { restartRequired: true } }],
    }),
  });
  const { t: tr, module } = boot();
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().market.phase, 'ready');
  assert.ok(hasUpdateButton(module.renderUpdateSection(h.updater.getSnapshot(), actions, tr)));
  await h.updater.startUpdate();
  const posted = h.calls.find((call) => call[2] === 'POST');
  assert.deepEqual(posted[3], { packageName: PACKAGE_NAME });
  t.mock.timers.tick(1000);
  await flush();
  assert.match(text(module.renderUpdateSection(h.updater.getSnapshot(), actions, tr)), /正在更新… 40%/);
  t.mock.timers.tick(1000);
  await flush();
  const done = module.renderUpdateSection(h.updater.getSnapshot(), actions, tr);
  assert.match(text(done), /已更新到 v26\.10\.12/);
  assert.ok(buttonByLabel(done, '立即重启 DSH'));
  await h.updater.restart();
  assert.equal(h.updater.getSnapshot().restart.phase, 'done');
});

test('dshmarket 兜底：市场报 bundle-in-use 时说明原因并展开手动重装；冷却期给强制更新', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of [{ message: 'exit=1 err=这个插件正在使用中 (bundle-in-use)' }, { code: 'RELEASE_TOO_FRESH', message: 'too fresh' }]) {
    const h = updaterHarness({ manager: legacyManager().manager, market: marketHost({ operations: [{ state: 'failed', failure }, { state: 'failed', failure }] }) });
    const { t: tr, module } = boot();
    await h.updater.check();
    await h.updater.startUpdate();
    t.mock.timers.tick(1000);
    await flush();
    const tree = module.renderUpdateSection(h.updater.getSnapshot(), { ...actions, startUpdate: (force) => h.updater.startUpdate(force) }, tr);
    assert.equal(pinnedOf(tree).props.open, true);
    const force = buttonByLabel(tree, '强制更新');
    if (failure.code) {
      assert.match(text(tree), /发布冷却期/);
      await force.props.onClick();
      assert.equal(h.calls.filter((call) => call[2] === 'POST').at(-1)[3].force, true);
    } else {
      assert.equal(h.updater.getSnapshot().operation.inUse, true);
      assert.match(text(tree), /无法在本插件运行时卸下它/);
      assert.equal(force, undefined);
    }
  }
});

test('官方更新：宿主卸不下运行中的本插件时说明原因、补回被移出的启用状态，并给指定版本重装', async () => {
  const refusal = { from: '26.10.11', to: '26.10.12', step: 'remove', result: { application: 'failed', error: { code: 'bundle-in-use' } } };
  for (const [variant, expected] of [['applied', undefined], ['failed', 'lock-timeout'], ['missing', 'setBundleEnabled unavailable'], ['enabled', undefined]]) {
    const enabled = [];
    const h = updaterHarness({ result: refusal, bundle: { name: PACKAGE_NAME, version: '26.10.11', source: PACKAGE_NAME + '@26.10.11', availability: 'profile', updatable: true, enabled: variant === 'enabled' } });
    if (variant !== 'missing') {
      h.remote.pluginManager.setBundleEnabled = async (...args) => {
        enabled.push(args);
        return { ok: true, value: variant === 'failed' ? { application: 'failed', error: { code: 'lock-timeout' } } : { application: 'applied' } };
      };
    }
    const { t: tr, module } = boot();
    await h.updater.check();
    await h.updater.startUpdate();
    const { operation } = h.updater.getSnapshot();
    assert.equal(operation.inUse, true);
    assert.equal(operation.reselectFailure, expected);
    assert.equal(enabled.length, ['applied', 'failed'].includes(variant) ? 1 : 0, variant);
    if (enabled.length) assert.deepEqual(enabled[0], [PACKAGE_NAME, true]);
    const tree = module.renderUpdateSection(h.updater.getSnapshot(), actions, tr);
    assert.match(text(tree), /bundle-in-use/);
    assert.equal(/自动补回失败/.test(text(tree)), Boolean(expected));
    assert.equal(pinnedOf(tree).props.open, true);
    assert.match(text(pinnedOf(tree)), /先关闭「OpenCode API」组件/);
  }
});
