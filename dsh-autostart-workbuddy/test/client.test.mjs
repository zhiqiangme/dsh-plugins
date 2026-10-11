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
const ROW_ID = 'dsh-autostart-workbuddy';
const NAMESPACE = 'settings.dsh-autostart-workbuddy';

/** 把 bundle 放进沙箱执行，拿回它注册进 __ModuleLoader__ 的 registration 与注入的样式。 */
function loadBundle() {
  let registration;
  const styles = [];
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (element) => styles.push(element) },
  };
  // eslint-disable-next-line no-new-func -- 故意在沙箱里跑浏览器 bundle
  new Function('window', 'document', 'console', SOURCE)(window, document, console);
  assert.ok(registration, 'bundle 应调用 window.__ModuleLoader__.load');
  assert.equal(registration.id, PACKAGE_NAME);
  return { registration, styles };
}

/** 替身 React：createElement 产出普通对象；useState 按调用顺序喂预设状态。 */
function makeReact(states) {
  let index = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [states[index++], () => {}],
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
function boot(states = [], { withPrimitives = true } = {}) {
  const { registration, styles } = loadBundle();
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
  assert.equal(module.name, 'dsh-autostart-workbuddy-client');
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
    'backendInstall', 'backendInstalled', 'backendLatest', 'backendNoHistory', 'backendRollback',
    'backendTitle', 'backendUninstall', 'backendUninstalled', 'backendUnmanaged', 'backendUpdate',
    'backendUpdated', 'backendUpToDate', 'backendWorking', 'backendRolledBack', 'cancel',
    'clearAll', 'count', 'description', 'disabledHint', 'emptyBackend', 'emptyHint', 'loading',
    'panelHint', 'patchPath', 'refresh', 'retry', 'save', 'saveFailed', 'savedNoSync', 'savedSync',
    'saving', 'selectAll', 'summary', 'title', 'uninstallConfirm', 'uninstallDesc', 'uninstallKept',
    'uninstallTitle', 'vision',
  ];
  assert.deepEqual(Object.keys(entry.zh).sort(), expected.sort());
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
  assert.ok(texts.includes('x0.11'), '应显示倍率徽章');
  assert.ok(texts.includes('xFree'), '免费模型显示 xFree');
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
  assert.match(css, /\.dsm-wb-btn-primary:disabled\{[^}]*color:var\(--dsw-alias-label-dimmed/);
  assert.equal(/\.dsm-wb-btn:disabled\{[^}]*opacity/.test(css), false, '禁用态不要只靠 opacity');

  // 主按钮走反色：label-primary 当底、bg-layer-3 当字。
  assert.match(css, /\.dsm-wb-btn-primary\{[^}]*background:var\(--dsw-alias-label-primary/);
});

test('渲染：后端面板地址是外链（target=_blank，宿主会交给默认浏览器）', () => {
  const { cards, t } = boot([
    'ready', ROWS, {}, '', new Set(), new Set(), false, undefined,
    { version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [], panelUrl: 'http://127.0.0.1:7863/panel' },
    undefined, undefined, undefined,
  ]);

  const anchors = collectByType(cards[0].component({ t, view: 'page' }), 'a');
  assert.equal(anchors.length, 1, '应渲染一个链接');
  assert.equal(anchors[0].props.href, 'http://127.0.0.1:7863/panel');
  assert.equal(anchors[0].props.target, '_blank', '外链必须走 target=_blank 才会被宿主 openExternal');
  assert.match(anchors[0].props.rel ?? '', /noopener/);
  // 显示文本去掉协议头，和用户看到的写法一致
  assert.deepEqual(collectText(anchors[0]), ['127.0.0.1:7863/panel']);
});

test('渲染：宿主没给面板地址时回退到默认值', () => {
  const { cards, t } = boot([
    'ready', ROWS, {}, '', new Set(), new Set(), false, undefined,
    { version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] },
    undefined, undefined, undefined,
  ]);
  const anchors = collectByType(cards[0].component({ t, view: 'page' }), 'a');
  assert.equal(anchors[0].props.href, 'http://127.0.0.1:7863/panel');
});

/** 组件里 useState 的取值顺序：phase/rows/meta/reason/picked/savedPicked/saving/notice/backend/check/busy/notice/confirming。 */
function backendStates(backend, { check, confirming } = {}) {
  return ['ready', ROWS, {}, '', new Set(), new Set(), false, undefined, backend, check, undefined, undefined, confirming];
}

/** 渲染后把按钮的文字标签取出来。 */
function buttonLabels(tree) {
  return collectByType(tree, 'button').map((node) => collectText(node).join(''));
}

test('后端区（已安装）：显示 更新/卸载/回滚，不显示 安装；卸载是危险色', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] }),
  );
  const tree = cards[0].component({ t, view: 'page' });
  const labels = buttonLabels(tree);

  assert.ok(labels.includes('更新'), '已安装应显示更新');
  assert.ok(labels.includes('卸载'), '已安装应显示卸载');
  assert.ok(labels.includes('回滚'), '已安装应显示回滚');
  assert.equal(labels.includes('安装'), false, '已安装不该显示安装（与卸载互斥）');

  // 顺序：更新 → 回滚 → 卸载（卸载放最后，离"检查更新"最远，减少误点）
  assert.deepEqual(labels.slice(-4), ['检查更新', '更新', '回滚', '卸载'], '后端按钮顺序应为 更新 → 回滚 → 卸载');

  const uninstall = collectByType(tree, 'button').find((node) => collectText(node).join('') === '卸载');
  assert.match(uninstall.props.className, /dsm-wb-btn-danger/, '卸载按钮用危险色');
});

test('后端区（未安装）：显示 安装，不显示 更新/卸载/回滚', () => {
  const { cards, t } = boot(backendStates({ exeExists: false, version: {}, history: [] }));
  const labels = buttonLabels(cards[0].component({ t, view: 'page' }));

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
  assert.ok(collectByType(tree, 'div').some((node) => node.props.className === 'dsm-wb-confirm'), '应走行内确认');
});

test('卸载二次确认：未点开时不出现确认界面', () => {
  const { cards, t } = boot(backendStates({ exeExists: true, version: {}, history: [] }));
  const texts = collectText(cards[0].component({ t, view: 'page' }));
  assert.equal(texts.includes('卸载后端？'), false);
});
