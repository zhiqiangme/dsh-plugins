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

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/** 宿主按 npm 包名登记客户端模块、寻址插件页卡片；行 id 则沿用改作用域包之前的名字。 */
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
const ROW_ID = 'dsh-opencode2api';
const NAMESPACE = 'settings.dsh-opencode2api';

/** 把 bundle 放进沙箱执行，拿回它注册进 __ModuleLoader__ 的 registration 与注入的样式。 */
function loadBundle({ fetchImpl = globalThis.fetch } = {}) {
  let registration;
  const styles = [];
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
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
    useState: () => {
      const slot = index++;
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
function boot(states = [], { withPrimitives = true, fetchImpl } = {}) {
  const { registration, styles } = loadBundle({ fetchImpl });
  const dicts = new Map();
  const cards = [];
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
        cards.push({ spec, component });
        return () => {};
      },
    },
  };

  module.apply(ctx);
  return {
    module,
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
  assert.deepEqual(module.inject, ['slots', 'locale']);
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
    'restartFailed', 'restartNow', 'restarting', 'updateAvailable', 'updateCancelled', 'updateCheck',
    'updateCheckFailed', 'updateChecking', 'updateCurrent', 'updateFailed', 'updateForce', 'updateLatestVersion',
    'updateLinked', 'updateLost', 'updateManaged', 'updateMismatch', 'updateNoMarket', 'updateNow', 'updatePendingRefresh',
    'updatePendingRestart', 'updateProgress', 'updateRefreshHint',
    'updateRestartHint', 'updateRolledBack', 'updateRunning', 'updateStartFailed', 'updateSucceeded',
    'updateTitle', 'updateTooFresh', 'updateUpToDate', 'updateLocal',
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
function buttonLabels(tree) {
  return collectByType(tree, 'button').map((node) => collectText(node).join(''));
}

/** 卡片 13 个 state + useUpdater 的 7 个之后，才是「复制初始管理密码」的 state。 */
function panelKeyStates(panelKey) {
  const backend = { exeExists: true, version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] };
  return [...backendStates(backend), ...Array(7).fill(undefined), panelKey];
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

test('清除后端数据：目录存在时单独一行显示危险色按钮，不打乱 更新/回滚/卸载 的顺序', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, rootExists: true, root: 'C:/Users/me/.dsh/autostart-opencode2api', version: {}, history: [] }),
  );
  const tree = cards[0].component({ t, view: 'page' });
  const labels = buttonLabels(backendSection(tree));
  assert.deepEqual(labels.slice(-5), ['检查更新', '更新', '回滚', '卸载', '清除后端数据']);

  const purge = collectByType(tree, 'button').find((node) => collectText(node).join('') === '清除后端数据');
  assert.match(purge.props.className, /dsm-oc-btn-danger/);
  assert.ok(collectText(tree).some((text) => text.includes('C:/Users/me/.dsh/autostart-opencode2api')), '提示里应写明会删哪个目录');

  // 后端没装但目录还在（只剩日志 / 凭证）时同样可以清。
  const leftover = boot(backendStates({ exeExists: false, rootExists: true, root: 'x', version: {}, history: [] }));
  assert.ok(buttonLabels(backendSection(leftover.cards[0].component({ t: leftover.t, view: 'page' }))).includes('清除后端数据'));

  const gone = boot(backendStates({ exeExists: false, rootExists: false, version: {}, history: [] }));
  assert.equal(buttonLabels(backendSection(gone.cards[0].component({ t: gone.t, view: 'page' }))).includes('清除后端数据'), false, '目录不在时不显示');
});

test('清除后端数据二次确认：弹窗说明会删整个目录且不可撤销', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, rootExists: true, root: 'D:/dsh/autostart-opencode2api', version: {}, history: [] }, { confirming: 'purge' }),
  );
  const tree = render(cards[0].component({ t, view: 'page' }));
  const texts = collectText(tree);

  assert.ok(texts.includes('清除后端数据？'));
  assert.ok(texts.some((text) => text.includes('D:/dsh/autostart-opencode2api') && text.includes('账号凭证')), '应说明删哪个目录、含凭证');
  assert.ok(texts.some((text) => text.includes('无法撤销')));
  assert.equal(texts.includes('卸载后端？'), false, '不能弹成卸载的确认');
  const labels = buttonLabels(tree);
  assert.ok(labels.includes('确认清除'));
  assert.ok(labels.includes('取消'));
});

test('卸载二次确认：未点开时不出现确认界面', () => {
  const { cards, t } = boot(backendStates({ exeExists: true, version: {}, history: [] }));
  const texts = collectText(cards[0].component({ t, view: 'page' }));
  assert.equal(texts.includes('卸载后端？'), false);
});

// ---- 插件自身更新区 ----

/** 「插件更新」区块的基准状态：有新版本、装了市场、没有进行中的任务。 */
function updateModel(overrides = {}) {
  return {
    version: { phase: 'ready', ok: true, currentVersion: '26.10.11', latestVersion: '26.10.12', updateAvailable: true },
    market: { phase: 'ready', restartSupported: false, endpoints: {} },
    operation: undefined,
    target: undefined,
    busy: false,
    notice: undefined,
    restart: undefined,
    ...overrides,
  };
}

const noop = () => {};
const updateActions = { checkUpdate: noop, startUpdate: noop, restart: noop };

/** 渲染更新区并给出文本与按钮。 */
function renderUpdate(model, actions = updateActions) {
  const { module, t } = boot();
  const section = module.renderUpdateSection(model, actions, t);
  return { section, text: collectText(section).join('|'), buttons: collectByType(section, 'button') };
}

const button = (buttons, label) => buttons.find((node) => collectText(node).join('') === label);

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

test('插件更新区：有新版本且装了市场 → 两个版本号与"更新到"按钮', () => {
  const started = [];
  const { text, buttons } = renderUpdate(updateModel(), { ...updateActions, startUpdate: (force) => started.push(force) });
  assert.match(text, /当前运行版本：\|v26\.10\.11/);
  assert.match(text, /npm 最新版本：\|v26\.10\.12/);
  assert.match(text, /有新版本/);
  const update = button(buttons, '更新到 v26.10.12');
  assert.equal(update.props.disabled, false);
  update.props.onClick();
  assert.deepEqual(started, [false], '普通更新不带 force');
});

test('本地安装显示渠道说明，不报 npm 检查错误，也不提供 npm 更新按钮', () => {
  const { text, buttons } = renderUpdate(updateModel({
    version: { phase: 'ready', ok: true, currentVersion: '26.10.15', installSource: 'local', updateAvailable: false },
  }));
  assert.match(text, /本地安装/);
  assert.match(text, /源码目录/);
  assert.match(text, /v26\.10\.15/);
  assert.doesNotMatch(text, /检查更新失败|npm 最新版本|undefined|已是最新/);
  assert.equal(buttons.length, 0);
});

test('插件更新区：没装市场 → 只提示，没有更新按钮', () => {
  const { text, buttons } = renderUpdate(updateModel({ market: { phase: 'absent' } }));
  assert.equal(button(buttons, '更新到 v26.10.12'), undefined);
  assert.match(text, /dshmarket/);
  assert.ok(button(buttons, '检查更新'));
});

test('插件更新区：已是最新 / 检查失败', () => {
  const latest = renderUpdate(
    updateModel({ version: { phase: 'ready', ok: true, currentVersion: '26.10.12', latestVersion: '26.10.12', updateAvailable: false } }),
  );
  assert.match(latest.text, /已是最新/);
  assert.equal(latest.buttons.length, 1, '只剩"检查更新"');

  const failed = renderUpdate(updateModel({ version: { phase: 'error', currentVersion: '26.10.11', reason: '连不上注册表' } }));
  assert.match(failed.text, /检查更新失败：连不上注册表/);
  assert.match(failed.text, /当前运行版本：\|v26\.10\.11/);
  assert.equal(button(failed.buttons, '检查更新').props.disabled, false);
});

test('插件更新区：进行中显示进度，按钮全部禁用', () => {
  const { text, buttons } = renderUpdate(
    updateModel({ operation: { operationId: 'b-update-1', state: 'running', progress: { percent: 40, detail: 'Progress: resolved 3' } } }),
  );
  assert.match(text, /正在更新… 40%/);
  assert.match(text, /Progress: resolved 3/);
  assert.ok(buttons.every((node) => node.props.disabled === true));
});

test('插件更新区：成功后按 restartRequired 提示重启；市场支持重启时才给重启按钮', () => {
  const operation = { state: 'succeeded', installedVersion: '26.10.12', outcome: { restartRequired: true } };
  const desktop = renderUpdate(updateModel({ operation, target: '26.10.12' }));
  assert.match(desktop.text, /已更新到 v26\.10\.12。 重启 DSH 后生效。/);
  assert.equal(button(desktop.buttons, '立即重启 DSH'), undefined, '桌面版的重启归桌面壳管');
  assert.doesNotMatch(desktop.text, /注意：装上的是/);

  const web = renderUpdate(updateModel({ operation, target: '26.10.12', market: { phase: 'ready', restartSupported: true } }));
  assert.ok(button(web.buttons, '立即重启 DSH'));
});

test('插件更新区：成功后徽章显示"等待重启/等待刷新"，且不再给"更新到"按钮', () => {
  // 更新成功后当前运行版本仍是旧版，单看版本号会永远说"有新版本"并留着更新按钮，
  // 再点只会重装同一版。徽章要改口，按钮要收走。
  const restart = renderUpdate(
    updateModel({ operation: { state: 'succeeded', installedVersion: '26.10.12', outcome: { restartRequired: true } }, target: '26.10.12' }),
  );
  assert.match(restart.text, /等待重启/);
  assert.doesNotMatch(restart.text, /有新版本/);
  assert.equal(button(restart.buttons, '更新到 v26.10.12'), undefined);
  assert.ok(button(restart.buttons, '检查更新'), '重新检查仍然可用');

  const refresh = renderUpdate(
    updateModel({ operation: { state: 'succeeded', installedVersion: '26.10.12', outcome: { refreshRequired: true } }, target: '26.10.12' }),
  );
  assert.match(refresh.text, /等待刷新/);
  assert.equal(button(refresh.buttons, '更新到 v26.10.12'), undefined);

  const live = renderUpdate(
    updateModel({ operation: { state: 'succeeded', installedVersion: '26.10.12', outcome: {} }, target: '26.10.12' }),
  );
  assert.match(live.text, /已是最新/);
  assert.doesNotMatch(live.text, /等待重启/);
});

test('插件更新区：成功后重新检查发现更高版本，恢复徽章和可用的更新按钮', async () => {
  for (const outcome of [{ restartRequired: true }, { refreshRequired: true }, {}]) {
    const model = updateModel({
      operation: { state: 'succeeded', installedVersion: '26.10.12', outcome },
      target: '26.10.12',
    });
    const requests = [];
    const { renderCard } = boot([
      ...backendStates({}),
      model.version, model.market, model.operation, model.target, model.busy, model.notice, model.restart,
    ], {
      fetchImpl: async (path, options) => {
        requests.push({ path, method: options.method });
        return {
          ok: true,
          json: async () => ({ ok: true, currentVersion: '26.10.11', latestVersion: '26.10.13', updateAvailable: true }),
        };
      },
    });
    const section = () => collectByType(renderCard(), 'div').find((node) => node.props.key === 'pluginUpdate');
    assert.equal(button(collectByType(section(), 'button'), '更新到 v26.10.12'), undefined);

    button(collectByType(section(), 'button'), '检查更新').props.onClick();
    await new Promise((resolve) => setImmediate(resolve));

    const tree = section();
    const text = collectText(tree).join('|');
    assert.deepEqual(requests, [{ path: '/plugins/dsh-opencode2api/version?force=1', method: 'GET' }]);
    assert.match(text, /有新版本/);
    assert.doesNotMatch(text, /等待重启|等待刷新|已是最新/);
    assert.equal(button(collectByType(tree, 'button'), '更新到 v26.10.13')?.props.disabled, false);
    assert.match(text, /已更新到 v26\.10\.12/, '保留上次更新结果，不靠清空任务恢复入口');
  }
});

test('插件更新区：装上的版本低于目标时警告并允许重试；高于目标不警告也不重复更新', () => {
  const below = renderUpdate(updateModel({ target: '26.10.12', operation: { state: 'succeeded', installedVersion: '26.10.11', outcome: {} } }));
  assert.match(below.text, /注意：装上的是 v26\.10\.11，不是预期的 v26\.10\.12/);
  assert.match(below.text, /有新版本/);
  assert.doesNotMatch(below.text, /已是最新/);
  assert.equal(button(below.buttons, '更新到 v26.10.12')?.props.disabled, false);
  const above = renderUpdate(updateModel({ target: '26.10.12', operation: { state: 'succeeded', installedVersion: '26.10.13', outcome: {} } }));
  assert.doesNotMatch(above.text, /注意：装上的是/);
  assert.match(above.text, /已是最新/);
  assert.equal(button(above.buttons, '更新到 v26.10.12'), undefined);
});

test('插件更新区：发布冷却期 / 版本未变时给"强制更新"，其它失败不给', () => {
  const started = [];
  const fresh = renderUpdate(
    updateModel({ operation: { state: 'failed', failure: { code: 'RELEASE_TOO_FRESH', message: 'x' } } }),
    { ...updateActions, startUpdate: (force) => started.push(force) },
  );
  assert.match(fresh.text, /发布冷却期/);
  button(fresh.buttons, '强制更新').props.onClick();
  assert.deepEqual(started, [true]);

  const other = renderUpdate(updateModel({ operation: { state: 'failed', failure: { code: 'UPDATE_FAILED', message: 'pnpm 退出码 1' } } }));
  assert.match(other.text, /更新失败：pnpm 退出码 1/);
  assert.equal(button(other.buttons, '强制更新'), undefined);
});

test('插件更新区：本地目录安装（file:）→ 不给更新按钮，说明怎么更新', () => {
  const market = { phase: 'ready', restartSupported: false, endpoints: {}, source: 'linked', updatable: false };
  const linked = renderUpdate(updateModel({ market }));
  assert.equal(button(linked.buttons, '更新到 v26.10.12'), undefined, 'dshmarket 会拒绝本地安装，按钮点了也只会失败');
  assert.match(linked.text, /本地目录（file:）/);
  assert.ok(button(linked.buttons, '检查更新'));

  assert.match(renderUpdate(updateModel({ market: { ...market, source: 'generation' } })).text, /DSH 桌面端统一管理/);
  assert.ok(button(renderUpdate(updateModel({ market: { ...market, source: 'npm', updatable: true } })).buttons, '更新到 v26.10.12'));
});
