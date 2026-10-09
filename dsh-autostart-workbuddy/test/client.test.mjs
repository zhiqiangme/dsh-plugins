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
const NAMESPACE = 'settings.dsh-autostart-workbuddy';

/** 把 bundle 放进沙箱执行，拿回它注册进 __ModuleLoader__ 的 registration。 */
function loadBundle() {
  let registration;
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild() {} },
  };
  // eslint-disable-next-line no-new-func -- 故意在沙箱里跑浏览器 bundle
  new Function('window', 'document', 'console', SOURCE)(window, document, console);
  assert.ok(registration, 'bundle 应调用 window.__ModuleLoader__.load');
  return registration;
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

/** 按 DSH 的约定插值；值不是字符串就原样返回，好让测试看出这类错误。 */
function interpolate(value, params) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (params && key in params ? String(params[key]) : match));
}

/**
 * 跑一遍模块与 apply。
 *
 * @param {unknown[]} states 组件渲染时 useState 按顺序返回的值
 */
function boot(states = []) {
  const registration = loadBundle();
  const dicts = new Map();
  const cards = [];
  const React = makeReact(states);

  const module = registration.factory((id) => {
    if (id === 'react') return React;
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
  return { module, dicts, cards, t: ctx.locale.bind(NAMESPACE) };
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
  assert.equal(bundle.spec.key, 'dsh-autostart-workbuddy');
  assert.equal(row.spec.key, 'dsh-autostart-workbuddy#dsh-autostart-workbuddy');
  assert.equal(typeof bundle.component, 'function');
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
    'clearAll', 'count', 'description', 'disabledHint', 'emptyBackend', 'emptyHint', 'loading',
    'patchPath', 'refresh', 'retry', 'save', 'saveFailed', 'savedNoSync', 'savedSync', 'saving',
    'selectAll', 'summary', 'title', 'vision',
  ];
  assert.deepEqual(Object.keys(entry.zh).sort(), expected.sort());
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
