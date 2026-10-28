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
const ROW_ID = 'dsh-autostart-workbuddy';
const NAMESPACE = 'settings.dsh-autostart-workbuddy';

/** 把 bundle 放进沙箱执行，拿回它注册进 __ModuleLoader__ 的 registration 与注入的样式。 */
function loadBundle({ fetchImpl = globalThis.fetch, crypto = webcrypto, clipboard, sessionStorage } = {}) {
  let registration;
  const styles = [];
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } }, crypto, navigator: { clipboard }, sessionStorage };
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
function makeReact(states, effects) {
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
    useEffect: (effect) => { effects?.push(effect); },
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
function boot(states = [], { withPrimitives = true, fetchImpl, effects, crypto, clipboard, sessionStorage, $on } = {}) {
  const { registration, styles } = loadBundle({ fetchImpl, crypto, clipboard, sessionStorage });
  const dicts = new Map();
  const cards = [];
  const events = new Map();
  const React = makeReact(states, effects);

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
  { id: 'cn:alpha', label: 'Alpha CN 0.11', credits: '0.11', contextWindow: 1000000, vision: true, selected: true },
  { id: 'global:beta', label: 'Beta GL Free', credits: 'Free', contextWindow: 200000, vision: false, selected: false },
];

test('bundle 契约：模块名、注入的服务名、两个 slot 的 key', () => {
  const { module, cards } = boot();
  assert.equal(module.name, 'dsh-autostart-workbuddy-client');
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
  assert.deepEqual(module.orderedSelection([{ id: 'global:b' }], new Set(['cn:x', 'global:b'])), ['global:b', 'cn:x'], '保留网络故障时不可见的已选模型');
});

test('模型筛选按搜索、区域、免费、视觉与倍率组合，保留未知价格语义', () => {
  const { module } = boot();
  const rows = [...ROWS, { id: 'cn:unknown', label: 'Unknown', credits: 'Free', price: null }];
  assert.deepEqual(module.filterRows(rows, { freeOnly: true }).map((x) => x.id), ['global:beta']);
  assert.deepEqual(module.filterRows(rows, { query: 'alpha', region: 'cn', visionOnly: true, maxCredits: 0.2 }).map((x) => x.id), ['cn:alpha']);
  assert.deepEqual(module.filterRows(rows, { sort: 'credits' }).map((x) => x.id), ['global:beta', 'cn:alpha', 'cn:unknown']);
});

test('目录缺席项可见且能取消，不伪报倍率或后端模型数量', async () => {
  const missing = { id: 'cn:kimi-k3.1-pro', label: 'Kimi K3.1 Pro CN 0.97', selected: true, unavailable: true, price: null };
  const only = ['cn:alpha', missing.id];
  const states = ['ready', [...ROWS, missing], { enabled: true, savedEnabled: true, only }, '', new Set(only), new Set(only), false, undefined];
  const requests = [];
  const app = boot(states, { fetchImpl: async (_path, options) => {
    if (options.body) requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, enabled: true, only: ['cn:alpha'], models: ROWS, sync: { state: 'updated', count: 1 } }) };
  } });
  let tree = app.renderCard();
  const text = collectText(tree).join('\n');
  assert.match(text, /目录暂缺/);
  assert.match(text, /后端共 2 个模型，已勾选 2 个/);
  assert.match(text, /若这些模型已在 DSH 中，将暂缓更新清单/);
  assert.doesNotMatch(text, /xundefined|xnull/);
  const row = collectByType(tree, 'label').find((node) => node.props.title === missing.id);
  collectByType(row, 'input')[0].props.onChange();
  tree = app.renderCard();
  assert.doesNotMatch(collectText(tree).join('\n'), /若这些模型已在 DSH 中，将暂缓更新清单/);
  await button(collectByType(tree, 'button'), '保存并同步').props.onClick();
  assert.deepEqual(requests[0].only, ['cn:alpha']);

  assert.deepEqual(app.module.filterRows([missing], { freeOnly: true, visionOnly: true, maxCredits: 0 }).map((row) => row.id), [missing.id], '缺席不是符合规则，但必须仍能取消');
  assert.deepEqual(app.module.filterRows([missing], { region: 'global' }), []);
  assert.deepEqual(app.module.filterRows([missing], { query: 'other' }), []);
});

test('实时刷新保留跨区域勾选草稿、取消项与未保存的开关和规则', () => {
  const { module } = boot();
  const next = module.mergeLiveSnapshot({
    picked: new Set(['global:keep', 'global:added']), savedPicked: new Set(['global:keep', 'global:removed']),
    meta: { enabled: false, savedEnabled: true, rules: { freeOnly: true }, savedRules: { freeOnly: false } },
  }, { enabled: true, rules: { freeOnly: false }, realm: 'cn', only: ['global:removed'], models: [{ id: 'cn:new', selected: true }] });
  assert.ok(next.picked.has('global:added'));
  assert.ok(next.picked.has('global:keep'));
  assert.ok(next.picked.has('cn:new'));
  assert.equal(next.picked.has('global:removed'), false);
  assert.equal(next.meta.enabled, false);
  assert.equal(next.meta.rules.freeOnly, true);
  assert.equal(next.meta.realm, 'cn');
});

test('实时轮询刷新模型与后端状态，卸载卡片后停止', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const effects = [], requests = [];
  const app = boot(modelStates(true), { effects, fetchImpl: async (path) => {
    requests.push(path);
    return { ok: true, json: async () => path.includes('/backend') ? { backend: { modelStatus: { realm: 'cn', at: 'new' } } } :
      { ok: true, enabled: true, only: [], realm: 'cn', models: [{ id: 'cn:new', label: 'New CN Free', selected: true }] } };
  } });
  app.renderCard();
  const stop = effects.at(-1)();
  t.after(stop);
  t.mock.timers.tick(5000); await new Promise((done) => setImmediate(done));
  assert.equal(requests.length, 2);
  assert.ok(collectText(app.renderCard()).includes('New CN Free'));
  stop(); t.mock.timers.tick(20_000); await new Promise((done) => setImmediate(done));
  assert.equal(requests.length, 2);
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
    'modelUnavailable', 'missingSelected',
    'emptyFiltered', 'recoveryOff', 'recoveryExternal',
    'accountOverview', 'balanceOverview', 'balanceUnknown', 'balanceUnsupported', 'balanceUnavailable', 'balanceHint', 'balanceUpdated',
    'hubFollowKey',
    'hubKeySaved', 'hubKeyMissing', 'hubKeyEnvironment', 'hubKeyUnavailable', 'hubKeyKeep', 'hubSaving',
    'hubSettingsSaved', 'hubKeysSaved', 'hubSyncFailed', 'hubInventoryFailed',
    'hubDual', 'hubDualHint', 'hubCnKey', 'hubGlKey', 'hubApply', 'hubDualSaved', 'hubBoth',
    'modelSearch', 'regionAll', 'ruleFree', 'ruleVision', 'ruleMax', 'sortUpstream', 'sortName', 'sortCredits', 'ruleHint',
    'diagnose', 'diagnoseCopy', 'diagnoseCopied', 'diagnoseWorking',
    'backendStarted', 'recoveryStatus', 'recoveryIdle', 'recoveryWaiting', 'recoveryRestarting', 'recoveryRecovered', 'recoveryExhausted', 'recoveryRetry',
    'backendAvailable', 'backendBuilt', 'backendCheck', 'backendCurrent', 'backendHistory',
    'backendInstall', 'backendInstalled', 'backendLatest', 'backendNoAccounts', 'backendNoHistory', 'backendRollback',
    'backendTitle', 'backendUninstall', 'backendUninstalled', 'backendUnmanaged', 'backendUpdate',
    'backendUpdated', 'backendUpToDate', 'backendWorking', 'backendRolledBack', 'cancel',
    'clearAll', 'count', 'description', 'disabledHint', 'emptyBackend', 'emptyHint', 'loading',
    'panelHint', 'panelKeyCopied', 'panelKeyCopy', 'panelKeyManual', 'panelKeyNone', 'panelKeyWorking',
    'patchPath', 'refresh', 'retry', 'save', 'saveFailed', 'saveSync', 'savedDisabled', 'savedNoSync', 'savedSync',
    'saving', 'selectAll', 'summary', 'syncEnabled', 'syncHint', 'title', 'uninstallConfirm', 'uninstallDesc', 'uninstallKept',
    'uninstallTitle', 'vision',
    'modelsNotInstalled', 'modelsNoAccounts', 'backendPurge', 'backendPurgeHint', 'backendPurged', 'purgeConfirm', 'purgeDesc', 'purgeKept', 'purgeTitle',
    // 后端网关切换与 hub 专用文案
    'backendUninstalledHub', 'gatewayHub', 'gatewayHubHint', 'gatewayNotInstalled', 'gatewaySwitched', 'gatewaySwitching',
    'gatewayTimeout', 'gatewayTitle', 'gatewayWaiting', 'gatewayWb2api', 'panelPasswordChanged', 'panelPasswordCopied',
    'gatewaySynced', 'gatewaySyncFailed', 'gatewayCredentialFailed', 'gatewayNoAccounts',
    'panelPasswordCopy', 'uninstallHubConfirm', 'uninstallHubDesc', 'uninstallHubKept', 'uninstallHubTitle',
    // 插件自身更新区（与后端版本区无关）
    'restartFailed', 'restartNow', 'restarting', 'updateAvailable', 'updateCancelled', 'updateCheck',
    'updateCheckFailed', 'updateChecking', 'updateCurrent', 'updateFailed', 'updateForce', 'updateLatestVersion',
    'updateLinked', 'updateLost', 'updateManaged', 'updateMismatch', 'updateNoMarket', 'updateNow', 'updatePendingRefresh',
    'updatePendingRestart', 'updateProgress', 'updateRefreshHint',
    'updateRestartHint', 'updateRolledBack', 'updateRunning', 'updateStartFailed', 'updateSucceeded',
    'updateTitle', 'updateTooFresh', 'updateUpToDate',
    'updateCheckingTarget', 'updateManagerFailed', 'updateRestoreFailed', 'updateNoCompatible', 'updateNotUpdatable',
    'updatePinnedInstall', 'updatePinnedHint', 'updateCopySpec', 'updateSpecCopied', 'updateSpecCopyFailed',
    'updateUnknown', 'updateRemoving', 'updateInstalling', 'updateRestoring',
    // 后端自动更新
    'autoUpdateDrifted', 'autoUpdateError', 'autoUpdateFailed', 'autoUpdateHint', 'autoUpdateLabel', 'autoUpdateLast',
    'autoUpdatePending', 'autoUpdateRolledBack', 'autoUpdateUnavailable', 'autoUpdateUnknown', 'autoUpdateWaiting',
    // hub 出口
    'hubRealm',
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
  assert.ok(texts.includes('Alpha CN 0.11'), '应显示模型展示名');
  assert.ok(texts.includes('Beta GL Free'), '应显示模型展示名');
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

/** 开关与模型勾选维持独立草稿；用实际事件和请求验证只改开关也能保存。 */
function modelStates(enabled) {
  return ['ready', ROWS, { enabled, savedEnabled: enabled }, '', new Set(['cn:alpha']), new Set(['cn:alpha']), false, undefined];
}

function syncCheckbox(tree) {
  const label = collectByType(tree, 'label').find((node) => node.props.className === 'dsm-wb-sync');
  return collectByType(label, 'input')[0];
}

test('刷新会立即同步 DSH，沿用保存的选择；暂时消失的白名单模型不会在保存时丢失', async () => {
  const requests = [];
  const only = ['cn:alpha', 'global:beta'];
  const { renderCard } = boot(modelStates(true), {
    fetchImpl: async (path, options) => {
      requests.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, enabled: true, only, models: [ROWS[1]], sync: { state: 'updated', count: 1 } }) };
    },
  });
  await button(collectByType(renderCard(), 'button'), '刷新').props.onClick();
  assert.deepEqual(requests[0], { path: '/plugins/dsh-autostart-workbuddy/models', method: 'POST', body: { action: 'refresh' } });
  assert.ok(collectText(renderCard()).includes('后端共 1 个模型，已勾选 1 个'));
  await button(collectByType(renderCard(), 'button'), '保存并同步').props.onClick();
  assert.deepEqual(requests[1].body, { enabled: true, only: ['global:beta', 'cn:alpha'] });
  assert.equal(requests[2].method, 'GET', '保存已同步，之后只回读');
});

test('同步全部模型时重复保存仍保留空白名单，网络恢复后自动包含 CN', async () => {
  const requests = [];
  const { renderCard } = boot(modelStates(true), {
    fetchImpl: async (_path, options) => {
      requests.push(options.body && JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, enabled: true, only: [], models: [{ ...ROWS[1], selected: true }], sync: { state: 'updated', count: 1 } }) };
    },
  });
  await button(collectByType(renderCard(), 'button'), '刷新').props.onClick();
  await button(collectByType(renderCard(), 'button'), '保存并同步').props.onClick();
  assert.deepEqual(requests[1], { enabled: true, only: [] });
});

test('刷新能读取上游但同步失败时，面板显示同步错误', async () => {
  const { renderCard } = boot(modelStates(true), {
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, enabled: true, only: [], models: ROWS, sync: { state: 'failed', reason: 'write rejected' } }) }),
  });
  await button(collectByType(renderCard(), 'button'), '刷新').props.onClick();
  assert.ok(collectText(renderCard()).includes('write rejected'));
});

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

  assert.equal(requests[0].path, '/plugins/dsh-autostart-workbuddy/models');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), { enabled: true, only: ['cn:alpha'] });
  assert.equal(requests[1].method, 'GET');
  tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, true);
  assert.ok(collectText(tree).includes('已保存，并已重新生成模型清单：1 个模型。'));
  assert.equal(button(collectByType(tree, 'button'), '保存并同步').props.disabled, false, '成功后仍允许重新同步');
});

test('持续规则可从卡片保存，搜索与区域过滤不写入配置', async () => {
  const requests = [];
  const states = modelStates(true);
  states[2] = { enabled: true, savedEnabled: true, only: [], rules: {}, savedRules: {} };
  states[4] = new Set(ROWS.map((row) => row.id));
  states[5] = new Set(ROWS.map((row) => row.id));
  const { renderCard } = boot(states, { fetchImpl: async (_path, options) => {
    if (options.body) requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, enabled: true, only: [], rules: { freeOnly: true }, models: ROWS, sync: { state: 'updated', count: 1 } }) };
  } });
  const free = collectByType(renderCard(), 'label').find((node) => collectText(node).includes('只同步免费模型'));
  collectByType(free, 'input')[0].props.onChange({ target: { checked: true } });
  const search = collectByType(renderCard(), 'input').find((node) => node.props.type === 'search');
  search.props.onChange({ target: { value: 'Beta' } });
  const region = collectByType(renderCard(), 'select').find((node) => node.props['aria-label'] === '全部区域');
  region.props.onChange({ target: { value: 'global' } });
  const tree = renderCard();
  assert.ok(!collectText(tree).includes('Alpha CN 0.11'));
  assert.ok(collectText(tree).includes('Beta GL Free'));
  await button(collectByType(tree, 'button'), '保存并同步').props.onClick();
  assert.deepEqual(requests, [{ enabled: true, only: [], rules: { freeOnly: true } }]);
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

  // 没装后端时模型区给"去点安装"的提示，而不是状态码或裸的 fetch failed。
  const before = collectText(renderCard());
  assert.ok(before.some((text) => text.includes('后端还没有安装') && text.includes('「安装」')));
  assert.equal(before.includes('backend-not-installed'), false);

  await button(collectByType(renderCard(), 'button'), '安装').props.onClick();

  assert.deepEqual(requests.map((item) => `${item.method} ${item.path.split('/').pop()}`), ['POST backend', 'POST models', 'GET models']);
  assert.deepEqual(requests[1].body, { enabled: true }, '只开同步，不带 only，避免清空已有勾选');
  const tree = renderCard();
  assert.equal(syncCheckbox(tree).props.checked, true, '同步开关应已勾上');
  assert.ok(collectText(tree).includes('已保存，并已重新生成模型清单：2 个模型。'));
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
  states[8] = { exeExists: true, gateways: ['wb2api', 'hub'], gateway: 'wb2api', history: [] };
  const busy = boot(states).renderCard();
  assert.ok(collectByType(busy, 'input').every((node) => node.props.disabled === true));
  const toolbar = collectByType(busy, 'div').find((node) => node.props.className === 'dsm-wb-toolbar');
  assert.ok(collectByType(toolbar, 'button').every((node) => node.props.disabled === true));
  for (const label of ['更新', '回滚', '卸载', 'workbuddy2api-hub（默认）']) {
    const operation = button(collectByType(busy, 'button'), label);
    assert.ok(operation, `${label} 按钮存在`);
    assert.equal(operation.props.disabled, true, `${label} 在保存期间禁用`);
  }
});

test('搜索隐藏的勾选仍然生效，不误提示当前区域已选择全部', () => {
  const states = modelStates(true);
  states[2].realm = 'dual';
  const app = boot(states);
  const search = collectByType(app.renderCard(), 'input').find((node) => node.props.type === 'search');
  search.props.onChange({ target: { value: 'Beta' } });
  assert.ok(!collectText(app.renderCard()).includes(app.t('emptyHint')));
});

test('一键诊断通过 POST 获取报告，提供复制入口和可选择的报告文本', async () => {
  const requests = [];
  const app = boot(modelStates(true), { fetchImpl: async (_path, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, report: { gateway: 'hub', suggestions: ['检查账号'] } }) };
  } });
  await button(collectByType(app.renderCard(), 'button'), '一键诊断').props.onClick();
  assert.deepEqual(requests, [{ action: 'diagnose' }]);
  const tree = app.renderCard();
  assert.ok(collectText(tree).some((text) => String(text).includes('检查账号')));
  assert.ok(button(collectByType(tree, 'button'), '复制脱敏报告'));
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

test('账号积分概览区分真实零余额、未知余额与账号统计', () => {
  const app = boot(backendStates({ gateway: 'hub', version: {}, history: [], overview: { ready: 1, total: 2, balances: [
    { realm: 'cn', balance: 0, state: 'ready', accountsEnabled: 2, accountsKnown: 2 },
    { realm: 'intl', balance: null, state: 'unknown', accountsEnabled: 1, accountsKnown: 0 },
  ] } }));
  const text = collectText(app.renderCard()).join('\n');
  assert.match(text, /可用 1 \/ 总计 2/);
  assert.match(text, /CN 剩余积分：0/);
  assert.match(text, /GL 剩余积分：尚未获取/);
  assert.doesNotMatch(text, /GL 剩余积分：0/);
});

/** 渲染后把按钮的文字标签取出来。 */
function buttonLabels(tree) {
  return collectByType(tree, 'button').map((node) => collectText(node).join(''));
}

const button = (buttons, label) => buttons.find((node) => collectText(node).join('') === label);

/** 卡片 13 个 state + useUpdater 的 2 个之后，才是「复制访问密钥」的 state。 */
function panelKeyStates(panelKey) {
  const backend = { exeExists: true, version: { tag: 'v1.13.0', revision: 'd'.repeat(40) }, history: [] };
  return [...backendStates(backend), ...Array(2).fill(undefined), panelKey];
}

test('复制访问密钥：按钮挨着面板链接；复制成功给提示，剪贴板不可用时显示原文供手动复制', () => {
  const idle = boot(panelKeyStates(undefined));
  const panelLine = collectByType(idle.cards[0].component({ t: idle.t, view: 'page' }), 'p').find(
    (node) => node.props.className === 'dsm-wb-panel',
  );
  assert.ok(buttonLabels(panelLine).includes('复制访问密钥'), '按钮应在面板链接那一行');

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
    (node) => node.props.className === 'dsm-wb-backend' && collectText(node).includes('后端版本'),
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
  assert.match(uninstall.props.className, /dsm-wb-btn-danger/, '卸载按钮用危险色');
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
  assert.ok(collectByType(tree, 'div').some((node) => node.props.className === 'dsm-wb-confirm'), '应走行内确认');
});

test('彻底卸载：目录存在时紧跟在卸载右侧显示危险色按钮', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, rootExists: true, root: 'C:/Users/me/.dsh/autostart-workbuddy', version: {}, history: [] }),
  );
  const tree = cards[0].component({ t, view: 'page' });
  const labels = buttonLabels(backendSection(tree));
  assert.deepEqual(labels.slice(-5), ['检查更新', '更新', '回滚', '卸载', '彻底卸载']);

  const purge = collectByType(tree, 'button').find((node) => collectText(node).join('') === '彻底卸载');
  assert.match(purge.props.className, /dsm-wb-btn-danger/);
  assert.ok(collectText(tree).some((text) => text.includes('C:/Users/me/.dsh/autostart-workbuddy')), '提示里应写明会删哪个目录');

  const gone = boot(backendStates({ exeExists: false, rootExists: false, version: {}, history: [] }));
  assert.equal(buttonLabels(backendSection(gone.cards[0].component({ t: gone.t, view: 'page' }))).includes('彻底卸载'), false, '目录不在时不显示');
});

test('彻底卸载二次确认：弹窗说明会删整个目录且不可撤销', () => {
  const { cards, t } = boot(
    backendStates({ exeExists: true, rootExists: true, root: 'D:/dsh/autostart-workbuddy', version: {}, history: [] }, { confirming: 'purge' }),
  );
  const tree = render(cards[0].component({ t, view: 'page' }));
  const texts = collectText(tree);
  assert.ok(texts.includes('彻底卸载后端？'));
  assert.ok(texts.some((text) => text.includes('D:/dsh/autostart-workbuddy') && text.includes('账号凭证')));
  assert.ok(texts.some((text) => text.includes('无法撤销')));
  assert.equal(texts.includes('卸载后端？'), false, '不能弹成卸载的确认');
  assert.ok(buttonLabels(tree).includes('确认彻底卸载'));
});

test('卸载二次确认：未点开时不出现确认界面', () => {
  const { cards, t } = boot(backendStates({ exeExists: true, version: {}, history: [] }));
  const texts = collectText(cards[0].component({ t, view: 'page' }));
  assert.equal(texts.includes('卸载后端？'), false);
});

// ---- 后端网关切换 ----

/** 卡片 13 个 state + useUpdater 2 个 + 复制密钥 1 个之后，才是「切换网关」的 state。 */
function gatewayStates(backend, gatewaySwitch, { confirming } = {}) {
  return [...backendStates(backend, { confirming }), ...Array(2).fill(undefined), undefined, gatewaySwitch];
}

function hubKeyForm(app) {
  return collectByType(app.renderCard(), 'div').find((node) => node.props.key === 'hubMode');
}

test('区域 Key：重新打开仍显示各项保存状态，不回填密钥', () => {
  const app = boot(gatewayStates({ gateway: 'hub', hubSettings: { enabled: true, keys: { cn: 'saved', global: 'missing', follow: 'environment' } } }));
  const form = hubKeyForm(app);
  const text = collectText(form).join('|');
  assert.match(text, /CN 区域 Key（可选）\|已保存/);
  assert.match(text, /GL 区域 Key（可选）\|未单独保存，使用网关 Key/);
  assert.match(text, /已从环境配置/);
  assert.equal(collectByType(form, 'input')[0].props.checked, true);
  const passwords = collectByType(form, 'input').filter((node) => node.props.type === 'password');
  assert.ok(passwords.every((node) => node.props.value === ''));
  assert.match(passwords[0].props.placeholder, /已保存；留空保留/);
});

test('区域 Key：校验中有提示，成功后就近显示已保存并解释输入框清空', async () => {
  let finish;
  const posts = [];
  const settings = { enabled: false, keys: { cn: 'saved', global: 'saved', follow: 'saved' } };
  const app = boot(gatewayStates({ gateway: 'hub' }), { fetchImpl: async (_path, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return new Promise((done) => { finish = () => done({ ok: true, json: async () => ({ ok: true, enabled: false, settings, sync: { state: 'updated' } }) }); });
    }
    return { ok: true, json: async () => ({ ok: true, enabled: true, hubDual: false, models: ROWS, only: [] }) };
  } });
  const keys = ['cn-secret', 'gl-secret', 'follow-secret'];
  collectByType(hubKeyForm(app), 'input').filter((node) => node.props.type === 'password').forEach((node, index) => node.props.onChange({ target: { value: keys[index] } }));
  const pending = button(collectByType(hubKeyForm(app), 'button'), '应用区域模式').props.onClick();
  assert.equal(button(collectByType(hubKeyForm(app), 'button'), '正在校验并保存…').props.disabled, true);
  assert.ok(collectByType(hubKeyForm(app), 'input').filter((node) => node.props.type === 'password').every((node) => node.props.value));
  finish();
  await pending;
  assert.deepEqual(posts, [{ action: 'hubMode', enabled: false, cnKey: keys[0], globalKey: keys[1], followKey: keys[2] }]);
  const form = hubKeyForm(app);
  assert.equal(collectByType(form, 'span').filter((node) => node.props.className.includes('dsm-wb-key-state-saved')).length, 3);
  assert.ok(collectByType(form, 'input').filter((node) => node.props.type === 'password').every((node) => node.props.value === ''));
  const notice = collectByType(form, 'p').find((node) => node.props.role === 'status');
  assert.match(collectText(notice).join(''), /Key 已保存.*输入框已清空.*继续生效/);
  assert.doesNotMatch(collectText(form).join(''), /cn-secret|gl-secret|follow-secret/);
});

test('区域 Key：保存被拒时就近显示错误且保留输入，不能显示成功', async () => {
  const app = boot(gatewayStates({ gateway: 'hub' }), { fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, reason: 'CN 区域 Key 绑定错误' }) }) });
  const input = collectByType(hubKeyForm(app), 'input').find((node) => node.props.type === 'password');
  input.props.onChange({ target: { value: 'draft-secret' } });
  await button(collectByType(hubKeyForm(app), 'button'), '应用区域模式').props.onClick();
  const form = hubKeyForm(app);
  assert.match(collectText(form).join(''), /CN 区域 Key 绑定错误/);
  assert.doesNotMatch(collectText(form).join(''), /Key 已保存/);
  assert.equal(collectByType(form, 'input').find((node) => node.props.type === 'password').props.value, 'draft-secret');
  assert.ok(collectByType(form, 'p').some((node) => node.props.role === 'alert'));
});

test('区域 Key：保存后同步或回读失败，仍显示已保存状态并清空敏感草稿', async () => {
  for (const syncFailed of [true, false]) {
    const app = boot(gatewayStates({ gateway: 'hub', hubSettings: { enabled: true } }), { fetchImpl: async (_path, options) => {
      if (options.method === 'GET') throw new Error('network error');
      assert.equal(JSON.parse(options.body).enabled, true, '缺少模型快照时沿用后台模式');
      return { ok: true, json: async () => ({ ok: true, enabled: true, settings: { enabled: true, keys: { cn: 'saved', global: 'missing', follow: 'saved' } }, sync: syncFailed ? { state: 'failed', reason: '同步超时' } : { state: 'updated' } }) };
    } });
    collectByType(hubKeyForm(app), 'input').find((node) => node.props.type === 'password').props.onChange({ target: { value: 'cn-secret' } });
    await button(collectByType(hubKeyForm(app), 'button'), '应用区域模式').props.onClick();
    const form = hubKeyForm(app);
    const text = collectText(form).join('');
    assert.match(text, syncFailed ? /已保存，但模型同步未完成：同步超时/ : /Key 已保存.*模型列表暂时无法刷新/);
    assert.equal(collectByType(form, 'input').find((node) => node.props.type === 'password').props.value, '');
    assert.equal(collectByType(form, 'input')[0].props.checked, true);
  }
});

const GATEWAY_BACKEND = { exeExists: true, version: { tag: 'v1.7.14' }, history: [], gateways: ['wb2api', 'hub'] };

test('后端网关：两种网关各一个按钮，当前网关高亮且不可点，另一个可点', () => {
  const { renderCard } = boot(gatewayStates({ ...GATEWAY_BACKEND, gateway: 'wb2api' }));
  const buttons = collectByType(backendSection(renderCard()), 'button');
  const wb2api = button(buttons, 'wb2api');
  const hub = button(buttons, 'workbuddy2api-hub（默认）');
  assert.ok(wb2api && hub, '两种网关都应有按钮');
  assert.equal(wb2api.props.disabled, true);
  assert.match(wb2api.props.className, /dsm-wb-btn-primary/);
  assert.equal(hub.props.disabled, false);
  assert.match(hub.props.className, /dsm-wb-btn-outline/);
  assert.equal(collectText(renderCard()).some((text) => String(text).startsWith('hub 的模型 id')), false);
});

test('后端网关：老宿主快照没有 gateways 字段时不显示切换', () => {
  const { cards, t } = boot(gatewayStates({ exeExists: true, version: {}, history: [] }));
  const labels = buttonLabels(backendSection(cards[0].component({ t, view: 'page' })));
  assert.equal(labels.includes('workbuddy2api-hub（默认）'), false);
});

test('后端网关（hub）：给出模型 id 与出口的说明；卸载确认用 hub 的文案；切换结果显示提示', () => {
  const { renderCard } = boot(
    gatewayStates({ ...GATEWAY_BACKEND, gateway: 'hub' }, { kind: 'ok', text: '已切换到 workbuddy2api-hub' }, { confirming: 'uninstall' }),
  );
  const text = collectText(render(renderCard()));
  assert.ok(text.some((line) => String(line).startsWith('hub 一次只服务一个出口')), '应说明 hub 的出口开关与按出口分开的勾选');
  assert.ok(text.includes('卸载 hub？'), '卸载确认用 hub 的标题');
  assert.ok(text.includes('hub 的账号凭证、设置与用量（hub/data/）会保留。'));
  assert.ok(text.includes('已切换到 workbuddy2api-hub'));
  const labels = buttonLabels(backendSection(renderCard()));
  assert.ok(labels.includes('wb2api'), '可以切回 wb2api');
});

// ---- 插件自身更新区 ----

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
const actions = { checkUpdate: noop, startUpdate: noop, restart: noop, copyInstallSpec: noop };

test('插件更新区：首屏（hooks 状态尚未就绪）显示检查中，且排在后端版本区之后', () => {
  const { cards, t } = boot(backendStates({ exeExists: true, version: { tag: 'v1.13.0' }, history: [] }));
  const tree = cards[0].component({ t, view: 'page' });
  assert.ok(collectText(tree).includes('正在检查更新…'));
  const sections = collectByType(tree, 'div').filter((node) => node.props.className === 'dsm-wb-backend');
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
    market: { phase: 'idle' },
    busy: false,
    ...overrides,
  };
}

/** 旧宿主（没有官方更新接口）退回 dshmarket 时的基准状态：装了市场、从 npm 安装。 */
function marketModel(overrides = {}) {
  return updateModel({
    manager: { phase: 'unsupported', local: false, managed: false, installedVersion: '26.10.11' },
    market: { phase: 'ready', restartSupported: false, endpoints: {}, source: 'npm', updatable: true },
    ...overrides,
  });
}

const VERSION_ROUTE = '/plugins/dsh-autostart-workbuddy/version';
const OPERATION_KEY = 'dsh-autostart-workbuddy:update-operation';
const UP_TO_DATE = { phase: 'ready', ok: true, currentVersion: '26.10.12', latestVersion: '26.10.12', updateAvailable: false };
const text = (tree) => collectText(tree).join('|');
const pinnedOf = (tree) => collect(tree, (node) => node.type === 'details' && node.props.key === 'pinnedInstall')[0];
const hasUpdateButton = (tree) => buttons(tree).some((node) => collectText(node.children).join('').startsWith('更新到'));
/** 让挂起的 promise 链跑完（setImmediate 不在 mock.timers 的接管范围内）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/** rc.3 的插件管理器：listBundles 带安装来源，没有 listVersions / updateBundle。 */
function legacyManager(extra = {}) {
  const bundle = { name: PACKAGE_NAME, version: '26.10.11', source: `${PACKAGE_NAME}@26.10.11`, availability: 'profile', official: false, ...extra };
  return { bundle, manager: { listBundles: async () => ({ ok: true, value: [bundle] }) } };
}

/** dshmarket 公开更新 API v1 的替身；ops 依次作为每次任务查询的答复，用完答 404（任务已不在）。 */
function fakeMarket({ source = 'npm', bootId = 'b', restartSupported = false, submit, ops = [] } = {}) {
  const posted = [];
  const handle = (path, options) => {
    if (path === '/dsh-market/api/v1/capabilities') {
      return { status: 200, body: { schema: 'dsh-market/update-api/v1', features: { update: true }, bootId, restart: { supported: restartSupported } } };
    }
    if (path.startsWith('/dsh-market/api/v1/updates?name=')) return { status: 200, body: { package: { source } } };
    if (path === '/dsh-market/api/v1/updates' && options.method === 'POST') {
      posted.push(JSON.parse(options.body));
      return submit ?? { status: 202, body: { operation: { operationId: `${bootId}-1`, state: 'running' } } };
    }
    if (path.startsWith('/dsh-market/api/v1/operations?operationId=')) return ops.shift() ?? { status: 404 };
    if (path === '/dsh-market/api/v1/restart') return { status: 202, body: {} };
    return { status: 404 };
  };
  return { posted, handle };
}

/**
 * 直接驱动共享更新器：manager 缺省是带官方更新接口的新宿主；market 缺省不存在（capabilities 答 404）。
 * version 是 version 路由的答复，测试可以改它模拟 npm 上出了新版。
 */
function updaterHarness({ manager, result, versions, bundle, crypto, version, market, sessionStorage } = {}) {
  const calls = [];
  const events = new Map();
  const versionPayload = version ?? { ...updateModel().version };
  const fetcher = async (path, options = {}) => {
    calls.push(['fetch', path, options.method ?? 'GET']);
    if (path.startsWith(VERSION_ROUTE)) {
      assert.match(path, /^\/plugins\/dsh-autostart-workbuddy\/version(?:\?force=1)?$/);
      return { ok: true, status: 200, json: async () => versionPayload };
    }
    const answer = market ? market.handle(path, options) : { status: 404 };
    return {
      ok: answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError('Unexpected token < in JSON');
        return answer.body;
      },
    };
  };
  const { module } = boot([], { fetchImpl: fetcher, crypto, sessionStorage });
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

test('官方更新：宿主没有更新接口或取不到管理器时退回 dshmarket；市场不在时不提交任何更新', async () => {
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
    assert.deepEqual(fetched(h.calls), [VERSION_ROUTE, '/dsh-market/api/v1/capabilities']);
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

test('市场兜底：探测市场与安装来源，提交纯包名，按任务轮询到完成', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = memoryStorage();
  const market = fakeMarket({ ops: [
    { status: 200, body: { operation: { state: 'running', progress: { percent: 40, detail: 'resolved 3' } } } },
    { status: 200, body: { operation: { state: 'succeeded', installedVersion: '26.10.12', outcome: { restartRequired: true } } } },
  ] });
  const h = updaterHarness({ manager: legacyManager().manager, market, sessionStorage: storage });
  await h.updater.check();
  const { phase, source, updatable } = h.updater.getSnapshot().market;
  assert.deepEqual({ phase, source, updatable }, { phase: 'ready', source: 'npm', updatable: true });

  await h.updater.startUpdate();
  // 市场的公开 v1 API 只接受纯包名，不能拼 @版本
  assert.deepEqual(market.posted, [{ packageName: PACKAGE_NAME }]);
  assert.equal(h.updater.getSnapshot().operation.channel, 'market');
  assert.equal(h.updater.getSnapshot().target, '26.10.12');
  assert.deepEqual(JSON.parse(storage.getItem(OPERATION_KEY)), { operationId: 'b-1', target: '26.10.12' });

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updater.getSnapshot().operation.progress.percent, 40);
  assert.equal(h.updater.getSnapshot().operation.operationId, 'b-1');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
  assert.equal(storage.getItem(OPERATION_KEY), null);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(fetched(h.calls).filter((path) => path.includes('/operations?')).length, 2, '任务结束后不再轮询');
});

test('市场兜底：热重载后按 bootId 接着轮询，查不到任务时提示已结束；DSH 重启过的旧记录丢弃；卸载后停止轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stored = (operationId) => memoryStorage({ [OPERATION_KEY]: JSON.stringify({ operationId, target: '26.10.12' }) });

  const storage = stored('b-7');
  const h = updaterHarness({ manager: {}, market: fakeMarket(), sessionStorage: storage });
  await h.updater.check();
  assert.deepEqual(h.updater.getSnapshot().operation, { channel: 'market', operationId: 'b-7', state: 'running' });
  assert.equal(h.updater.getSnapshot().target, '26.10.12');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updater.getSnapshot().operation.state, 'lost');
  assert.equal(storage.getItem(OPERATION_KEY), null);

  const restarted = stored('old-7');
  const h2 = updaterHarness({ manager: {}, market: fakeMarket(), sessionStorage: restarted });
  await h2.updater.check();
  assert.equal(h2.updater.getSnapshot().operation, undefined);
  assert.equal(restarted.getItem(OPERATION_KEY), null);

  const h3 = updaterHarness({ manager: {}, market: fakeMarket(), sessionStorage: stored('b-8') });
  await h3.updater.check();
  h3.updater.dispose();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(fetched(h3.calls).some((path) => path.includes('/operations?')), false);
});

test('市场兜底：本地 / 托管安装不提交；force 只在显式选择时带上；提交被拒时记下原因；Web 版可请市场重启', async () => {
  for (const source of ['linked', 'generation']) {
    const market = fakeMarket({ source });
    const h = updaterHarness({ manager: {}, market });
    await h.updater.check();
    assert.equal(h.updater.getSnapshot().market.updatable, false);
    await h.updater.startUpdate();
    assert.deepEqual(market.posted, []);
  }
  // 插件列表说是本地目录安装时，即便市场答不上来源也不提交
  const local = fakeMarket();
  const hl = updaterHarness({ manager: legacyManager({ source: 'file:D:/source' }).manager, market: local });
  await hl.updater.check();
  await hl.updater.startUpdate();
  assert.deepEqual(local.posted, []);

  const forced = fakeMarket();
  const hf = updaterHarness({ manager: {}, market: forced });
  await hf.updater.check();
  await hf.updater.startUpdate(true);
  assert.deepEqual(forced.posted, [{ packageName: PACKAGE_NAME, force: true }]);
  hf.updater.dispose();

  const busy = fakeMarket({ submit: { status: 409, body: { failure: { message: '已有更新在进行' } } } });
  const hb = updaterHarness({ manager: {}, market: busy });
  await hb.updater.check();
  await hb.updater.startUpdate();
  assert.equal(hb.updater.getSnapshot().startFailure, '已有更新在进行');
  assert.equal(hb.updater.getSnapshot().busy, false);
  await hb.updater.check(true);
  assert.equal(hb.updater.getSnapshot().startFailure, undefined);

  const hw = updaterHarness({ manager: {}, market: fakeMarket({ restartSupported: true }) });
  await hw.updater.check();
  assert.equal(hw.updater.getSnapshot().market.restartSupported, true);
  await hw.updater.restart();
  assert.deepEqual(hw.updater.getSnapshot().restart, { phase: 'done' });
  assert.ok(hw.calls.some((call) => call[1] === '/dsh-market/api/v1/restart' && call[2] === 'POST'));
});

test('市场兜底：成功后重新检查发现更高版本，恢复徽章和可用的更新按钮，保留上次结果', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bundle, manager } = legacyManager();
  const market = fakeMarket({ ops: [
    { status: 200, body: { operation: { state: 'succeeded', installedVersion: '26.10.12', outcome: { restartRequired: true } } } },
  ] });
  const h = updaterHarness({ manager, market });
  const { t: translate } = boot();
  const view = () => render(h.module.renderUpdateSection(h.updater.getSnapshot(), actions, translate));
  await h.updater.check();
  await h.updater.startUpdate();
  t.mock.timers.tick(1000);
  await flush();
  bundle.version = '26.10.12';
  assert.match(text(view()), /等待重启/);
  assert.equal(hasUpdateButton(view()), false, '更新成功后再点只会重装同一版');

  h.versionPayload.latestVersion = '26.10.13';
  await h.updater.check(true);
  const tree = view();
  assert.match(text(tree), /有新版本/);
  assert.doesNotMatch(text(tree), /等待重启|等待刷新|已是最新/);
  assert.equal(buttonByLabel(tree, '更新到 v26.10.13')?.props.disabled, false);
  assert.match(text(tree), /已更新到 v26\.10\.12/, '保留上次更新结果，不靠清空任务恢复入口');
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
    { manager: { phase: 'blocked', local: true } },
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

test('市场兜底 UI：装了市场 → 按 npm 最新版给按钮，普通更新不带 force；没装市场只提示并展开指定版本安装', () => {
  const { module, t } = boot();
  const started = [];
  const tree = render(module.renderUpdateSection(marketModel(), { ...actions, startUpdate: (force) => started.push(force) }, t));
  const update = buttonByLabel(tree, '更新到 v26.10.12');
  assert.equal(update.props.disabled, false);
  update.props.onClick();
  assert.deepEqual(started, [false], '普通更新不带 force');
  assert.equal(pinnedOf(tree).props.open, false, '有一键更新时指定版本安装收起');

  const absent = render(module.renderUpdateSection(marketModel({ market: { phase: 'absent' } }), actions, t));
  assert.equal(hasUpdateButton(absent), false);
  assert.match(text(absent), /dshmarket/);
  const input = collect(pinnedOf(absent), (node) => node.type === 'input')[0];
  assert.equal(pinnedOf(absent).props.open, true);
  assert.equal(input.props.value, `${PACKAGE_NAME}@26.10.12`);
  assert.equal(input.props.readOnly, true);
  let selected = false;
  input.props.onFocus({ currentTarget: { select: () => { selected = true; } } });
  assert.equal(selected, true);
});

test('市场兜底 UI：进行中显示百分比与摘要，按钮全部禁用，不给指定版本安装', () => {
  const { module, t } = boot();
  const tree = render(module.renderUpdateSection(marketModel({ operation: {
    channel: 'market', operationId: 'b-update-1', state: 'running', progress: { percent: 40, detail: 'Progress: resolved 3' },
  } }), actions, t));
  assert.match(text(tree), /正在更新… 40%/);
  assert.match(text(tree), /Progress: resolved 3/);
  assert.equal(buttonByLabel(tree, '检查更新').props.disabled, true);
  assert.equal(buttonByLabel(tree, '正在更新…').props.disabled, true);
  assert.equal(pinnedOf(tree), undefined);
});

test('市场兜底 UI：成功后按 restartRequired / refreshRequired 改徽章与提示；市场支持重启时才给重启按钮', () => {
  const { module, t } = boot();
  const view = (outcome, market) => render(module.renderUpdateSection(marketModel({
    operation: { channel: 'market', state: 'succeeded', installedVersion: '26.10.12', outcome },
    target: '26.10.12',
    ...(market ? { market } : {}),
  }), actions, t));
  const desktop = view({ restartRequired: true });
  assert.match(text(desktop), /已更新到 v26\.10\.12。 重启 DSH 后生效。/);
  assert.match(text(desktop), /等待重启/);
  assert.doesNotMatch(text(desktop), /有新版本|注意：装上的是/);
  assert.equal(hasUpdateButton(desktop), false);
  assert.equal(buttonByLabel(desktop, '立即重启 DSH'), undefined, '桌面版的重启归桌面壳管');

  const web = view({ restartRequired: true }, { phase: 'ready', restartSupported: true, endpoints: {}, source: 'npm', updatable: true });
  assert.ok(buttonByLabel(web, '立即重启 DSH'));

  const refresh = view({ refreshRequired: true });
  assert.match(text(refresh), /等待刷新/);
  assert.match(text(refresh), /刷新页面后生效/);
  assert.match(text(view({})), /已是最新/);
});

test('市场兜底 UI：装上的版本低于目标时警告并允许重试；高于目标不警告也不重复更新', () => {
  const { module, t } = boot();
  const view = (installedVersion) => render(module.renderUpdateSection(marketModel({
    target: '26.10.12',
    operation: { channel: 'market', state: 'succeeded', installedVersion, outcome: {} },
  }), actions, t));
  const below = view('26.10.11');
  assert.match(text(below), /注意：装上的是 v26\.10\.11，不是预期的 v26\.10\.12/);
  assert.match(text(below), /有新版本/);
  assert.equal(buttonByLabel(below, '更新到 v26.10.12')?.props.disabled, false);
  assert.equal(pinnedOf(below).props.open, true, '装上的仍低于最新版时展开指定版本安装');

  const above = view('26.10.13');
  assert.doesNotMatch(text(above), /注意：装上的是/);
  assert.match(text(above), /已是最新/);
  assert.equal(hasUpdateButton(above), false);
});

test('市场兜底 UI：发布冷却期 / 版本未变时给"强制更新"并展开指定版本安装，其它失败不给', () => {
  const { module, t } = boot();
  const started = [];
  for (const code of ['RELEASE_TOO_FRESH', 'VERSION_UNCHANGED']) {
    const tree = render(module.renderUpdateSection(
      marketModel({ operation: { channel: 'market', state: 'failed', failure: { code, message: 'x' } } }),
      { ...actions, startUpdate: (force) => started.push(force) },
      t,
    ));
    buttonByLabel(tree, '强制更新').props.onClick();
    assert.equal(pinnedOf(tree).props.open, true);
    if (code === 'RELEASE_TOO_FRESH') assert.match(text(tree), /发布冷却期/);
  }
  assert.deepEqual(started, [true, true]);

  const other = render(module.renderUpdateSection(marketModel({ operation: { channel: 'market', state: 'failed', failure: { code: 'UPDATE_FAILED', message: 'pnpm 退出码 1' } } }), actions, t));
  assert.match(text(other), /更新失败：pnpm 退出码 1/);
  assert.equal(buttonByLabel(other, '强制更新'), undefined);
});

test('市场兜底 UI：本地目录 / 桌面托管安装 → 不给更新按钮与指定版本安装，说明怎么更新', () => {
  const { module, t } = boot();
  const view = (overrides) => render(module.renderUpdateSection(marketModel(overrides), actions, t));
  const market = { phase: 'ready', restartSupported: false, endpoints: {}, updatable: false };
  for (const [overrides, hint] of [
    [{ market: { ...market, source: 'linked' } }, /从本地目录安装/],
    [{ market: { ...market, source: 'generation' } }, /由 DSH 统一管理/],
    [{ manager: { phase: 'unsupported', local: true } }, /从本地目录安装/],
  ]) {
    const tree = view(overrides);
    assert.equal(hasUpdateButton(tree), false, 'dshmarket 会拒绝这类安装，按钮点了也只会失败');
    assert.match(text(tree), hint);
    assert.equal(pinnedOf(tree), undefined);
    assert.ok(buttonByLabel(tree, '检查更新'));
  }
});

test('市场兜底 UI：任务丢失、启动失败与重启失败都有提示', () => {
  const { module, t } = boot();
  const tree = render(module.renderUpdateSection(marketModel({
    operation: { channel: 'market', state: 'lost' },
    startFailure: 'HTTP 409',
    restart: { phase: 'error', reason: 'HTTP 500' },
  }), actions, t));
  assert.match(text(tree), /上次的更新任务已经结束或 DSH 已重启/);
  assert.match(text(tree), /没能开始更新：HTTP 409/);
  assert.match(text(tree), /重启失败：HTTP 500/);
});

test('指定版本安装：版本规格校验与卡片复制动作，剪贴板失败时保留手动复制', async () => {
  const { module } = boot();
  assert.equal(module.pinnedInstallSpec('v26.10.17'), PACKAGE_NAME + '@26.10.17');
  assert.equal(module.pinnedInstallSpec('27.1.1-rc.1+build.2'), `${PACKAGE_NAME}@27.1.1-rc.1+build.2`);
  for (const value of [undefined, 'latest', '^26.10.17', '26.10.17.1', 'https://example.com/pkg.tgz', '26.10.17 --force']) assert.equal(module.pinnedInstallSpec(value), undefined);
  for (const clipboard of [{ writeText: async value => { assert.equal(value, PACKAGE_NAME + '@26.10.12'); } }, undefined]) {
    const update = marketModel({ market: { phase: 'absent' } });
    // 13 个模型/后端状态之后，是共享插件更新快照和复制提示。
    const app = boot([...backendStates({}), update, undefined], { clipboard });
    const view = () => render(app.renderCard());
    await buttonByLabel(view(), '复制包名和版本').props.onClick();
    assert.match(text(view()), clipboard ? /已复制/ : /手动复制/);
  }
});

test('后端网关：选择区自成一块（有自己的容器），与「后端版本」标题行分开', () => {
  const { renderCard } = boot(gatewayStates({ ...GATEWAY_BACKEND, gateway: 'hub' }));
  const section = backendSection(renderCard());
  const block = collectByType(section, 'div').find((node) => node.props.className === 'dsm-wb-gateway');
  assert.ok(block, '网关选择应包在 dsm-wb-gateway 里');
  assert.ok(buttonLabels(block).includes('wb2api'));
  assert.equal(buttonLabels(block).includes('检查更新'), false, '后端版本的按钮不能挤进网关块');
});

test('后端网关（hub）：复制按钮改叫「复制面板密码」', () => {
  const { renderCard } = boot(gatewayStates({ ...GATEWAY_BACKEND, gateway: 'hub' }));
  assert.ok(buttonLabels(renderCard()).includes('复制面板密码'));
  const wb2api = boot(gatewayStates({ ...GATEWAY_BACKEND, gateway: 'wb2api' }));
  assert.ok(buttonLabels(wb2api.renderCard()).includes('复制访问密钥'));
});

/** 按调用顺序回放 BACKEND / MODELS 的应答；数组用完后重复最后一个。 */
function scriptedFetch(script) {
  const calls = [];
  const next = (path) => {
    const queue = script[path.endsWith('/backend') ? 'backend' : 'models'];
    const item = queue.length > 1 ? queue.shift() : queue[0];
    if (item instanceof Error) throw item;
    return { ok: true, json: async () => item };
  };
  return { calls, fetchImpl: async (path) => { calls.push(path); return next(path); } };
}

test('waitForGateway：等到快照换成新网关且模型区能答才算好；重启中的报错与旧快照都继续等', async () => {
  const { fetchImpl } = scriptedFetch({
    backend: [new Error('fetch failed'), { ok: true, backend: { gateway: 'hub' } }, { ok: true, backend: { gateway: 'wb2api', exeExists: true } }],
    models: [{ ok: false, reason: 'fetch failed' }, { ok: true, models: [] }],
  });
  const { module } = boot([], { fetchImpl });
  let sleeps = 0;
  const outcome = await module.waitForGateway('wb2api', { waitMs: 60_000, sleep: async () => { sleeps += 1; } });
  assert.equal(outcome, 'ready');
  assert.equal(sleeps, 3, '报错一轮、旧快照一轮、模型区未就绪一轮');
});

test('waitForGateway：新网关没装就不等；账号池为空也算网关已就绪；超时报 timeout', async () => {
  const notInstalled = boot([], { fetchImpl: scriptedFetch({ backend: [{ ok: true, backend: { gateway: 'hub', exeExists: false } }], models: [{}] }).fetchImpl });
  assert.equal(await notInstalled.module.waitForGateway('hub', { sleep: async () => {} }), 'not-installed');

  const empty = boot([], { fetchImpl: scriptedFetch({ backend: [{ ok: true, backend: { gateway: 'hub' } }], models: [{ ok: false, state: 'backend-no-accounts' }] }).fetchImpl });
  assert.equal(await empty.module.waitForGateway('hub', { sleep: async () => {} }), 'ready');

  const stuck = boot([], { fetchImpl: scriptedFetch({ backend: [{ ok: true, backend: { gateway: 'hub' } }], models: [{}] }).fetchImpl });
  assert.equal(await stuck.module.waitForGateway('wb2api', { waitMs: 30, sleep: (ms) => new Promise((r) => setTimeout(r, 5)) }), 'timeout');
});

test('后端切换按钮：等待就绪后自动刷新、保存同步、回读，沿用宿主保存的白名单', async () => {
  const calls = [];
  const inventory = { ok: true, enabled: true, only: ['cn:alpha', 'global:beta'], models: ROWS };
  const app = boot(gatewayStates({ ...GATEWAY_BACKEND, gateway: 'wb2api' }), {
    fetchImpl: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method, body });
      return { ok: true, json: async () => path.endsWith('/backend')
        ? options.method === 'POST' ? { ok: true, state: 'switched' } : { ok: true, backend: { ...GATEWAY_BACKEND, gateway: 'hub' } }
        : options.method === 'GET' ? inventory
          : body.action === 'refresh' ? { ...inventory, sync: { state: 'deferred' } }
            : { ok: true, sync: { state: 'updated', credential: 'kept' } } };
    },
  });
  await button(collectByType(app.renderCard(), 'button'), 'workbuddy2api-hub（默认）').props.onClick();
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.body), [
    { action: 'gateway', gateway: 'hub' }, { action: 'refresh', gateway: 'hub' }, { gateway: 'hub', enabled: true },
  ]);
  assert.equal(calls.at(-1).method, 'GET', '保存后回读最终目录');
  assert.match(collectText(app.renderCard()).join('|'), /已切换到 workbuddy2api-hub（默认），模型、地址和凭据已自动保存并同步/);
});

test('切换后的自动同步：关闭同步、空账号池和保存失败都有明确状态，不误报成功', async () => {
  for (const [refreshed, saved, expected] of [
    [{ ok: true, enabled: false }, undefined, 'disabled'],
    [{ ok: false, state: 'backend-no-accounts' }, undefined, 'no-accounts'],
    [{ ok: true, enabled: true }, { ok: false, reason: 'profile locked' }, 'failed'],
    [{ ok: true, enabled: true }, { ok: true, sync: { state: 'failed', reason: '401' } }, 'failed'],
    [{ ok: true, enabled: true }, { ok: true, sync: { state: 'updated', credential: 'failed' } }, 'credential-failed'],
    [{ ok: true, enabled: true }, { ok: true, sync: { state: 'updated', credential: 'skipped' } }, 'credential-failed'],
  ]) {
    const bodies = [];
    const { module } = boot([], { fetchImpl: async (_path, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      return { ok: true, json: async () => body.action === 'refresh' ? refreshed : saved };
    } });
    const result = await module.syncGatewayModels('wb2api');
    assert.equal(result.state, expected);
    assert.equal(bodies.length, saved ? 2 : 1, '关闭同步或账号池为空时不擅自保存启用');
  }
});

test('模型区（hub）：账号池为空时显示本地化提示与重试，不列模型', () => {
  // 卡片的 state 顺序：phase、rows、meta、reason……（见 backendStates 之前的 13 个）
  const { renderCard } = boot(['error', [], { accounts: 0 }, 'backend-no-accounts', new Set(), new Set()]);
  const text = collectText(renderCard()).join('|');
  assert.match(text, /hub 里还没有可用账号（共 0 个，可用 0）/);
  assert.ok(buttonLabels(renderCard()).includes('重试'));
});

test('后端区：自动更新开关与状态行（待装 / 已自动更新 / 失败 / 冷却期 / 回滚跳过 / 检查失败）', () => {
  const { module, t } = boot();
  const toggled = [];
  const render = (auto, tag = 'v1.0.0', busy) => module.renderAutoUpdate(auto, tag, { busy, onToggle: (value) => toggled.push(value) }, t);
  const text = (nodes) => collectText(nodes).join('\n');
  const base = { enabled: true, available: true, delayHours: 2, pending: null, failed: null, last: null, lastCheck: null };

  assert.deepEqual(render(undefined), [], '老宿主的快照没有 autoUpdate 字段时什么都不显示');

  const idle = render(base);
  const box = collectByType(idle, 'input')[0];
  assert.equal(box.props.checked, true);
  assert.equal(box.props.disabled, false);
  box.props.onChange({ target: { checked: false } });
  assert.deepEqual(toggled, [false]);
  assert.match(text(idle), /自动更新后端/);
  assert.match(text(idle), /发布满 2 小时/);
  assert.match(text(render({ ...base, delayHours: undefined })), /发布满 2 小时/, '缺少等待时间时界面同样默认 2 小时');

  assert.match(text(render({ ...base, pending: { tag: 'v1.1.0' } })), /已下载 v1\.1\.0，下次启动 DSH 时自动安装/);
  const last = { from: 'v0.9.0', to: 'v1.0.0', at: '2026-10-19T00:00:00Z' };
  assert.match(text(render({ ...base, last })), /从 v0\.9\.0 更新到 v1\.0\.0/);
  assert.doesNotMatch(text(render({ ...base, last }, 'v0.9.0')), /更新到 v1\.0\.0/, '回滚之后不再说"已自动更新"');
  assert.match(text(render({ ...base, failed: { tag: 'v1.1.0', reason: '/healthz 返回 500' } })), /自动更新到 v1\.1\.0 没成功（\/healthz 返回 500）/);
  assert.doesNotMatch(text(render({ ...base, failed: { tag: 'v1.0.0', reason: 'x' } })), /没成功/, '手动装上了失败过的版本就不再提');
  assert.match(
    text(render({ ...base, lastCheck: { state: 'skipped', reason: 'too-fresh', tag: 'v1.1.0', readyAt: '2026-10-20T00:00:00Z' } })),
    /上游 v1\.1\.0 发布未满 2 小时/,
  );
  assert.match(text(render({ ...base, lastCheck: { state: 'skipped', reason: 'rolled-back', tag: 'v1.1.0' } })), /你从 v1\.1\.0 回滚过/);
  assert.match(text(render({ ...base, lastCheck: { state: 'error', reason: 'fetch failed' } })), /上次自动检查更新失败：fetch failed/);
  assert.doesNotMatch(text(render({ ...base, lastCheck: { state: 'skipped', reason: 'up-to-date', tag: 'v1.0.0' } })), /v1\.0\.0/, '已是最新不多说');

  assert.doesNotMatch(text(render({ ...base, enabled: false, pending: { tag: 'v1.1.0' } })), /已下载/, '关着时不显示状态行');
  const unavailable = render({ ...base, available: false });
  assert.equal(collectByType(unavailable, 'input')[0].props.disabled, true);
  assert.match(text(unavailable), /自动更新不生效/);
  assert.equal(collectByType(render(base, 'v1.0.0', 'update'), 'input')[0].props.disabled, true, '有操作在进行时禁用开关');

  // 卡片里：装了才显示（首次安装永远由用户点），位置在后端版本区里。
  const auto = { ...base, pending: { tag: 'v1.1.0' } };
  const installed = boot(backendStates({ exeExists: true, version: { tag: 'v1.0.0' }, history: [], autoUpdate: auto }));
  assert.match(collectText(backendSection(installed.renderCard())).join('\n'), /已下载 v1\.1\.0/);
  const missing = boot(backendStates({ exeExists: false, version: {}, history: [], autoUpdate: auto }));
  assert.doesNotMatch(collectText(missing.renderCard()).join('\n'), /自动更新后端/);
});

test('模型区（hub）：说明当前出口；另一个出口的勾选不算，这个出口一个没勾时提示"全部"', () => {
  const rows = [{ id: 'cn:flash', label: 'Flash CN Free', credits: 'Free' }];
  const meta = { enabled: true, savedEnabled: true, only: ['global:gpt-5.5'], realm: 'cn' };
  const none = boot(['ready', rows, meta, '', new Set(['global:gpt-5.5']), new Set(['global:gpt-5.5'])]);
  const text = collectText(none.renderCard()).join('\n');
  assert.match(text, /hub 当前出口：CN/);
  assert.match(text, /一个都没勾/, 'CN 这一组一个没勾 = CN 全部');

  const some = boot(['ready', rows, meta, '', new Set(['global:gpt-5.5', 'cn:flash']), new Set(['global:gpt-5.5'])]);
  assert.doesNotMatch(collectText(some.renderCard()).join('\n'), /一个都没勾/);

  const wb = boot(['ready', [{ id: 'cn:alpha', label: 'Alpha CN Free', credits: 'Free' }], { enabled: true }, '', new Set(['global:beta']), new Set()]);
  const wbText = collectText(wb.renderCard()).join('\n');
  assert.doesNotMatch(wbText, /hub 当前出口/, 'wb2api 没有出口一说');
  assert.doesNotMatch(wbText, /一个都没勾/, 'wb2api 下白名单非空就不是"全部"');
});
