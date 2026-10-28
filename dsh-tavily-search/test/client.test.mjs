/**
 * 客户端半侧的契约测试（在 Node 里跑，不需要浏览器）。
 *
 * 卡片在浏览器里出问题时只会整块消失，看不到原因。这里把 bundle 放进沙箱执行，钉住：
 *   1) 文案字典的值必须是字符串、中英文 key 一致（DSH 的 t() 只做 `{name}` 插值）；
 *   2) 两个 slot 的 key 逐字正确（写错不报错，只是卡片不出现）；
 *   3) 凭据只经 remote.credentials 写入，卡片没有任何读回密钥值的路径；
 *   4) renderCard 在各状态下的关键输出（接入/未接入、端口冲突、只读 key、测试结果、插件更新）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/** 宿主按 npm 包名登记客户端模块、寻址插件页卡片；行 id 则沿用改作用域包之前的名字。 */
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
const ROW_ID = 'dsh-tavily-search';
const NAMESPACE = 'settings.dsh-tavily-search';

/** 替身 React：createElement 产出普通对象；hooks 走最简实现（useState 返回初值）。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
};

function loadModule({ withPrimitives = true, react = React, fetchImpl = globalThis.fetch, clipboard, crypto = webcrypto, sessionStorage } = {}) {
  let registration;
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } }, navigator: { clipboard }, crypto, sessionStorage };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  // eslint-disable-next-line no-new-func -- 故意在沙箱里跑浏览器 bundle
  new Function('window', 'document', 'console', 'fetch', SOURCE)(window, document, console, fetchImpl);
  assert.equal(registration.id, PACKAGE_NAME);
  const primitives = { SettingsSecretField: (props) => react.createElement('host-secret-field', props) };
  return registration.factory((id) => {
    if (id === 'react') return react;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (withPrimitives) return primitives;
      throw new Error('not available');
    }
    throw new Error(`未预期的 require：${id}`);
  });
}

/**
 * 跑一遍 apply，收集字典、卡片注册、凭据调用。
 * options.webSnapshot / options.apiSnapshot / options.selectionSnapshot 给三个设置命名空间的快照；
 * selectionSnapshot 为 undefined 时 `web` 命名空间不存在（模拟 0.2.1-rc.1 及更早），
 * apiSnapshot 缺省时 web-deepseek-api 未加载。
 */
function boot(options = {}) {
  const module = loadModule(options);
  const dicts = new Map();
  const cards = [];
  const calls = [];
  const events = new Map();
  const formOf = (snapshot) => ({
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  });
  const form = formOf(options.webSnapshot ?? { status: 'loading' });
  const forms = { 'web-search-deepseek': form, 'web-deepseek-api': formOf(options.apiSnapshot ?? { status: 'unavailable' }) };
  if (options.selectionSnapshot) forms.web = formOf(options.selectionSnapshot);
  const ctx = {
    effect: (factory) => factory(),
    locale: {
      register: (ns, dict) => {
        dicts.set(ns, dict);
        return () => {};
      },
      bind: (ns) => (key, params) => interpolate(dicts.get(ns)?.zh?.[key], params),
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => {
        cards.push({ spec, component });
        return () => {};
      },
    },
    remote: {
      // options.$on 可模拟宿主不认识某个事件；默认记下订阅，测试可取出监听器
      $on: options.$on ?? ((event, listener) => {
        events.set(event, listener);
        return () => events.delete(event);
      }),
      credentials: {
        describe: async (refs) => {
          calls.push(['describe', refs]);
          return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])) };
        },
        set: async (ref, value) => {
          calls.push(['set', ref, value]);
          return { ok: true, value: undefined };
        },
        unset: async (ref) => {
          calls.push(['unset', ref]);
          return { ok: true, value: undefined };
        },
      },
    },
    configForms: { get: (ns) => forms[ns] },
  };
  module.apply(ctx);
  const t = (key, params) => interpolate(dicts.get(NAMESPACE)?.zh?.[key], params);
  return { module, dicts, cards, calls, events, t, form };
}

function interpolate(value, params) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (params && key in params ? String(params[key]) : match));
}

/** 展开函数组件（替身 React 不执行组件），再收集文本。 */
function render(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }));
  if (Array.isArray(node.children)) return { ...node, children: node.children.map(render) };
  return node;
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.props?.label === 'string') out.push(node.props.label);
    if (typeof node.props?.stateLabel === 'string') out.push(node.props.stateLabel);
    if (typeof node.props?.hint === 'string') out.push(node.props.hint);
    if (Array.isArray(node.children)) collectText(node.children, out);
  }
  return out;
}

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

/**
 * keys 路由形状的槽位列表（共 10 个）：tails 里第 i 项非空 → 第 i 个槽位已配置、末 4 位为该值；
 * 传对象可覆盖该槽位的其它字段（如 writable:false）。
 */
function slots(tails = []) {
  return Array.from({ length: 10 }, (_, index) => {
    const ref = index === 0 ? 'TAVILY_API_KEY' : `TAVILY_API_KEY_${index + 1}`;
    const item = tails[index];
    if (!item) return { ref, configured: false, writable: true, tail: '' };
    return typeof item === 'string'
      ? { ref, configured: true, writable: true, tail: item }
      : { ref, configured: true, writable: true, tail: '', ...item };
  });
}

/** 接入时网页搜索改读的占位凭据引用（与 lib/client.js 一致）。 */
const SHIM_REF = 'DSH_TAVILY_SEARCH_PLACEHOLDER';
/** 本插件的两个接口地址（与 lib/config.js 默认值一致）。 */
const ENDPOINT = 'http://127.0.0.1:8787/v1';
const API_ENDPOINT = 'http://127.0.0.1:8787/v1/tools';
/** 完整接入后的网页搜索快照（旧版 Messages 协议）：接口地址与凭据引用都由本插件覆盖，占位凭据有值。 */
const WIRED_WEB = {
  phase: 'ready',
  baseURL: ENDPOINT,
  apiKeyEnv: SHIM_REF,
  overridden: true,
  keyRefOverridden: true,
  writable: true,
  keyConfigured: true,
};
/** 完整接入后的新版 Search API 快照（web-deepseek-api）：只有基础地址不同。 */
const WIRED_API = { ...WIRED_WEB, baseURL: API_ENDPOINT };
/** 部署默认（base 层）的提供方选择，与 DSH 自带 bundle 一致。 */
const SELECTION_BASE = { searchProvider: 'deepseek-official', fetchProvider: 'http' };
/** 旧版 Messages 搜索的选择（开关关闭时的状态）。 */
const MESSAGES_SELECTION = {
  phase: 'ready',
  searchProvider: 'deepseek-official',
  fetchProvider: 'http',
  base: SELECTION_BASE,
  writable: true,
};
/** 新版开关打开、且还没由本插件修过抓取提供方的选择。 */
const API_SELECTION = {
  phase: 'ready',
  searchProvider: 'deepseek-search-api',
  fetchProvider: 'deepseek-fetch-api',
  base: SELECTION_BASE,
  writable: true,
};
/** 新版开关打开、并按本插件要求把抓取改回本地 HTTP 之后的选择（完全接入态）。 */
const API_WIRED_SELECTION = { ...API_SELECTION, fetchProvider: 'http' };

/** 一份"一切就绪"的基准 model，各用例在此基础上改。 */
function readyModel(overrides = {}) {
  return {
    status: {
      phase: 'ready',
      endpoint: 'http://127.0.0.1:8787/v1',
      apiEndpoint: 'http://127.0.0.1:8787/v1/tools',
      apiKeyRef: 'TAVILY_API_KEY',
      server: { state: 'listening', reason: '' },
    },
    keys: { phase: 'ready', slots: slots(['abcd']) },
    draft: '',
    keyBusy: undefined,
    confirmRemove: undefined,
    keyNotice: undefined,
    web: WIRED_WEB,
    api: { phase: 'unavailable' },
    selection: MESSAGES_SELECTION,
    webBusy: false,
    webNotice: undefined,
    test: { busy: false, result: undefined },
    ...overrides,
  };
}

const noop = () => {};
const actions = new Proxy({}, { get: () => noop });

test('字典：值全是字符串，中英文 key 一致', () => {
  const { dicts } = boot();
  const { zh, en } = dicts.get(NAMESPACE);
  for (const [lang, dict] of Object.entries({ zh, en })) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${lang}.${key} 必须是字符串`);
    }
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('卡片注册到两个 slot，key 逐字等于包名与行 id', () => {
  const { cards, module } = boot();
  assert.deepEqual(
    cards.map((card) => [card.spec.name, card.spec.key]),
    [
      ['plugins.bundle.config', PACKAGE_NAME],
      ['plugins.row.config', `${PACKAGE_NAME}#${ROW_ID}`],
    ],
  );
  assert.equal(module.name, 'dsh-tavily-search-client');
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']);
});

test('注入给卡片的 api 只有写凭据与描述的能力，没有读值路径', async () => {
  const { cards, calls } = boot();
  const { api } = cards[0].spec.inject();
  assert.deepEqual(Object.keys(api).sort(), ['apiForm', 'describe', 'onCredentialUpdated', 'selectionForm', 'setKey', 'unsetKey', 'updater', 'webForm']);
  await api.setKey('TAVILY_API_KEY', 'tvly-x');
  await api.unsetKey('TAVILY_API_KEY');
  assert.deepEqual(calls, [
    ['set', 'TAVILY_API_KEY', 'tvly-x'],
    ['unset', 'TAVILY_API_KEY'],
  ]);
});

test('首屏（全部加载中）能渲染，不抛错', () => {
  const { cards, t } = boot();
  const { component, spec } = cards[0];
  const tree = render(component({ ...spec.inject(), view: 'page' }));
  const text = collectText(tree).join('|');
  assert.match(text, /Tavily 联网搜索/);
  assert.match(text, /正在读取插件状态/);
  assert.match(text, /正在读取网页搜索设置/);
  assert.match(text, /正在检查更新/);
  assert.equal(typeof t('title'), 'string');
});

test('summary 视图只给一句话', () => {
  const { cards } = boot();
  const { component, spec } = cards[0];
  const tree = component({ ...spec.inject(), view: 'summary' });
  assert.deepEqual(collectText(tree), ['用 Tavily 给 DSH 的网页搜索供数。']);
});

test('密钥输入框优先用宿主的 SettingsSecretField，拿不到时退回自带输入框', () => {
  const withHost = boot();
  const hostTree = render(withHost.module.renderCard(readyModel(), actions, withHost.t));
  assert.equal(collect(hostTree, (node) => node.type === 'host-secret-field').length, 1);

  const fallback = boot({ withPrimitives: false });
  const fallbackTree = render(fallback.module.renderCard(readyModel(), actions, fallback.t));
  const inputs = collect(fallbackTree, (node) => node.type === 'input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.type, 'password');
  assert.equal(inputs[0].props.autoComplete, 'new-password');
});

test('已接入：显示"已接入"与"恢复默认"，不显示"接入网页搜索"', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel(), actions, t));
  const text = collectText(tree).join('|');
  assert.match(text, /已接入/);
  assert.ok(buttonByLabel(tree, '恢复默认'));
  assert.equal(buttonByLabel(tree, '接入网页搜索'), undefined);
});

test('未接入：显示"接入网页搜索"与将要写入的地址；末尾斜杠不影响判断', () => {
  const { module, t } = boot();
  const notWired = render(
    module.renderCard(readyModel({ web: { phase: 'ready', baseURL: '', overridden: false, writable: true } }), actions, t),
  );
  assert.ok(buttonByLabel(notWired, '接入网页搜索'));
  assert.match(collectText(notWired).join('|'), /默认（DeepSeek 官方接口）/);
  assert.match(collectText(notWired).join('|'), /接口地址改为 http:\/\/127\.0\.0\.1:8787\/v1/);

  assert.match(collectText(notWired).join('|'), /改读本插件的占位凭据 DSH_TAVILY_SEARCH_PLACEHOLDER/);

  const slash = render(module.renderCard(readyModel({ web: { ...WIRED_WEB, baseURL: 'http://127.0.0.1:8787/v1/' } }), actions, t));
  assert.match(collectText(slash).join('|'), /已接入/);
});

test('旧版接入（只改了接口地址、仍读 DEEPSEEK_API_KEY）：标"待修复"，给"修复接入"并说明会与聊天 key 混用', () => {
  const { module, t } = boot();
  const calls = [];
  const spy = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const legacy = { ...WIRED_WEB, apiKeyEnv: 'DEEPSEEK_API_KEY', keyRefOverridden: false, keyConfigured: false };
  const tree = render(module.renderCard(readyModel({ web: legacy }), spy, t));
  const text = collectText(tree).join('|');
  assert.match(text, /待修复/);
  assert.doesNotMatch(text, /已接入/);
  assert.match(text, /仍读凭据 DEEPSEEK_API_KEY/);
  buttonByLabel(tree, '修复接入').props.onClick();
  assert.deepEqual(calls, [['wire']]);
  assert.ok(buttonByLabel(tree, '恢复默认'), '接口地址仍是本插件写的，可以撤销');
});

test('已改读占位凭据但它被清空：标"待修复"，提示重新写入', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel({ web: { ...WIRED_WEB, keyConfigured: false } }), actions, t));
  const text = collectText(tree).join('|');
  assert.match(text, /待修复/);
  assert.match(text, /占位凭据 DSH_TAVILY_SEARCH_PLACEHOLDER 是空的/);
  assert.ok(buttonByLabel(tree, '修复接入'));
});

test('wireWebSearch（旧版 Messages）：占位凭据为空时先写入，再一次 mutate 改凭据引用与接口地址', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    describe: async (refs) => (calls.push(['describe', refs]), { ok: true, value: { [SHIM_REF]: { configured: false } } }),
    setKey: async (ref, value) => (calls.push(['setKey', ref, value]), { ok: true, value: undefined }),
    webForm: { mutate: async (ops) => (calls.push(['mutate', ops]), true) },
  };
  assert.equal(await module.wireWebSearch(api, { mode: 'messages', endpoint: ENDPOINT, apiEndpoint: API_ENDPOINT, selection: MESSAGES_SELECTION }), true);
  assert.deepEqual(calls, [
    ['describe', [SHIM_REF]],
    ['setKey', SHIM_REF, 'dsh-tavily-search'],
    [
      'mutate',
      [
        { op: 'set', path: ['apiKeyEnv'], value: SHIM_REF },
        { op: 'set', path: ['baseURL'], value: ENDPOINT },
      ],
    ],
  ]);
});

test('wireWebSearch：占位凭据已有值时不覆盖；表单没有 mutate 时逐个 set，被拒即停', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    describe: async () => ({ ok: true, value: { [SHIM_REF]: { configured: true } } }),
    setKey: async (...args) => (calls.push(['setKey', ...args]), { ok: true }),
    webForm: { set: async (field, value) => (calls.push(['set', field, value]), field !== 'apiKeyEnv') },
  };
  assert.equal(
    await module.wireWebSearch(api, { mode: 'messages', endpoint: 'http://e/v1', apiEndpoint: 'http://e/v1/tools', selection: MESSAGES_SELECTION }),
    false,
  );
  assert.deepEqual(calls, [['set', 'apiKeyEnv', SHIM_REF]], '不写占位凭据；apiKeyEnv 被拒后不再改接口地址');
});

test('wireWebSearch（新版 Search API）：写基础地址与占位凭据，并把抓取提供方从 deepseek-fetch-api 改回本地 HTTP', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    describe: async () => ({ ok: true, value: { [SHIM_REF]: { configured: true } } }),
    setKey: async () => ({ ok: true }),
    webForm: { mutate: async (ops) => (calls.push(['web-search-deepseek', ops]), true) },
    apiForm: { mutate: async (ops) => (calls.push(['web-deepseek-api', ops]), true) },
    selectionForm: { mutate: async (ops) => (calls.push(['web', ops]), true) },
  };
  assert.equal(await module.wireWebSearch(api, { mode: 'api', endpoint: ENDPOINT, apiEndpoint: API_ENDPOINT, selection: API_SELECTION }), true);
  assert.deepEqual(calls, [
    [
      'web-deepseek-api',
      [
        { op: 'set', path: ['apiKeyEnv'], value: SHIM_REF },
        { op: 'set', path: ['baseURL'], value: API_ENDPOINT },
      ],
    ],
    ['web', [{ op: 'unset', path: ['fetchProvider'] }]],
  ]);

  // 基础地址被拒：不再动提供方选择，免得抓取被迫切走而搜索又没接好
  calls.length = 0;
  api.apiForm.mutate = async (ops) => (calls.push(['web-deepseek-api', ops]), false);
  assert.equal(await module.wireWebSearch(api, { mode: 'api', endpoint: ENDPOINT, apiEndpoint: API_ENDPOINT, selection: API_SELECTION }), false);
  assert.deepEqual(calls.map(([ns]) => ns), ['web-deepseek-api']);

  // 搜索提供方被别的插件占着时，接入新版还要把 searchProvider 改到 deepseek-search-api
  calls.length = 0;
  api.apiForm.mutate = async (ops) => (calls.push(['web-deepseek-api', ops]), true);
  const other = { ...API_SELECTION, searchProvider: 'brave', fetchProvider: 'http' };
  assert.equal(await module.wireWebSearch(api, { mode: 'api', endpoint: ENDPOINT, apiEndpoint: API_ENDPOINT, selection: other }), true);
  assert.deepEqual(calls, [
    [
      'web-deepseek-api',
      [
        { op: 'set', path: ['apiKeyEnv'], value: SHIM_REF },
        { op: 'set', path: ['baseURL'], value: API_ENDPOINT },
      ],
    ],
    ['web', [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }]],
  ]);
});

test('restoreWebSearch：只撤销本插件写的覆盖，撤销凭据引用后删掉占位凭据；没东西可撤销时不写', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    unsetKey: async (ref) => (calls.push(['unsetKey', ref]), { ok: true }),
    webForm: { mutate: async (ops) => (calls.push(['mutate', ops]), true) },
  };
  const ownedOf = (messages, searchApi = { web: false, webKeyRef: false }, extra = {}) => ({
    messages,
    api: searchApi,
    any: messages.web || messages.webKeyRef || searchApi.web || searchApi.webKeyRef,
    deletePlaceholder: messages.webKeyRef || searchApi.webKeyRef,
    restoreFetch: false,
    ...extra,
  });
  assert.equal(await module.restoreWebSearch(api, ownedOf({ web: true, webKeyRef: true }), MESSAGES_SELECTION), true);
  assert.deepEqual(calls, [
    ['mutate', [{ op: 'unset', path: ['baseURL'] }, { op: 'unset', path: ['apiKeyEnv'] }]],
    ['unsetKey', SHIM_REF],
  ]);

  calls.length = 0;
  assert.equal(await module.restoreWebSearch(api, ownedOf({ web: true, webKeyRef: false }), MESSAGES_SELECTION), true);
  assert.deepEqual(calls, [['mutate', [{ op: 'unset', path: ['baseURL'] }]]], '凭据引用不是本插件写的就不碰，也不删占位凭据');

  calls.length = 0;
  assert.equal(await module.restoreWebSearch(api, ownedOf({ web: false, webKeyRef: false }), MESSAGES_SELECTION), undefined);
  assert.deepEqual(calls, []);
});

test('restoreWebSearch（新版）：撤销 Search API 覆盖，并把抓取提供方改回开关配对的 deepseek-fetch-api', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    unsetKey: async (ref) => (calls.push(['unsetKey', ref]), { ok: true }),
    webForm: { mutate: async (ops) => (calls.push(['web-search-deepseek', ops]), true) },
    apiForm: { mutate: async (ops) => (calls.push(['web-deepseek-api', ops]), true) },
    selectionForm: { mutate: async (ops) => (calls.push(['web', ops]), true) },
  };
  const owned = {
    messages: { web: false, webKeyRef: false },
    api: { web: true, webKeyRef: true },
    any: true,
    deletePlaceholder: true,
    restoreFetch: true,
  };
  assert.equal(await module.restoreWebSearch(api, owned, API_WIRED_SELECTION), true);
  assert.deepEqual(calls, [
    ['web-deepseek-api', [{ op: 'unset', path: ['baseURL'] }, { op: 'unset', path: ['apiKeyEnv'] }]],
    ['web', [{ op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' }]],
    ['unsetKey', SHIM_REF],
  ]);

  // 抓取提供方被用户换成了别的（不是开关配对的 deepseek-fetch-api）：恢复时不碰
  calls.length = 0;
  await module.restoreWebSearch({ ...api, selectionForm: undefined }, owned, API_WIRED_SELECTION);
  assert.deepEqual(calls.map(([name]) => name), ['web-deepseek-api', 'unsetKey']);
});

test('网页搜索插件未加载 / 设置只读', () => {
  const { module, t } = boot();
  const unavailable = render(module.renderCard(readyModel({ web: { phase: 'unavailable' } }), actions, t));
  assert.match(collectText(unavailable).join('|'), /网页搜索插件当前未加载/);

  const readOnly = render(
    module.renderCard(readyModel({ web: { phase: 'ready', baseURL: '', overridden: false, writable: false } }), actions, t),
  );
  assert.equal(buttonByLabel(readOnly, '接入网页搜索').props.disabled, true);
  assert.match(collectText(readOnly).join('|'), /设置为只读/);
});

test('端口被占用：显示原因，测试按钮禁用；外部实例时仍可测试', () => {
  const { module, t } = boot();
  const conflict = render(
    module.renderCard(
      readyModel({
        status: { ...readyModel().status, server: { state: 'conflict', reason: '端口 8787 已被其它程序占用' } },
      }),
      actions,
      t,
    ),
  );
  const text = collectText(conflict).join('|');
  assert.match(text, /端口被占用/);
  assert.match(text, /端口 8787 已被其它程序占用/);
  assert.equal(buttonByLabel(conflict, '测试搜索').props.disabled, true);

  const external = render(
    module.renderCard(readyModel({ status: { ...readyModel().status, server: { state: 'external', reason: 'x' } } }), actions, t),
  );
  assert.equal(buttonByLabel(external, '测试搜索').props.disabled, false);
});

test('API Key：多个 key 逐个列出（末 4 位 + 引用名），每个各有删除按钮，并提示轮流使用', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel({ keys: { phase: 'ready', slots: slots(['aaaa', '', 'cccc']) } }), actions, t));
  const rows = collect(tree, (node) => node.type === 'li' && node.props.className === 'dsm-tv-keyrow');
  assert.deepEqual(
    rows.map((row) => collectText(row.children).join('|')),
    ['#1|…aaaa|TAVILY_API_KEY|删除', '#3|…cccc|TAVILY_API_KEY_3|删除'],
  );
  const text = collectText(tree).join('|');
  assert.match(text, /2 个/);
  assert.match(text, /轮流使用/);
  // 中间空出来的 _2 是下一个添加位置
  assert.match(text, /存入 DSH 凭据库（TAVILY_API_KEY_2）/);
});

test('API Key：删除某个 key 只确认那一个；删最后一个时警告搜索会失败', () => {
  const { module, t } = boot();
  const calls = [];
  const spy = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const two = render(
    module.renderCard(readyModel({ keys: { phase: 'ready', slots: slots(['aaaa', 'bbbb']) }, confirmRemove: 'TAVILY_API_KEY_2' }), spy, t),
  );
  const rows = collect(two, (node) => node.type === 'li');
  assert.equal(collect(rows[0], (node) => node.props?.className === 'dsm-tv-confirm').length, 0);
  assert.match(collectText(rows[1].children).join('|'), /删除 …bbbb？/);
  buttonByLabel(rows[1], '确认删除').props.onClick();
  buttonByLabel(rows[0], '删除').props.onClick();
  assert.deepEqual(calls, [
    ['removeKey', 'TAVILY_API_KEY_2'],
    ['askRemove', 'TAVILY_API_KEY'],
  ]);

  const last = render(module.renderCard(readyModel({ confirmRemove: 'TAVILY_API_KEY' }), actions, t));
  assert.match(collectText(last).join('|'), /…abcd 是最后一个 key/);
});

test('API Key：草稿为空时添加禁用；写入第一个空槽位；只读 key 无删除按钮；申请链接常驻描述下方；满了不能再加', () => {
  const { module, t } = boot();
  const empty = render(module.renderCard(readyModel(), actions, t));
  assert.equal(buttonByLabel(empty, '添加').props.disabled, true);

  const added = [];
  const typed = render(
    module.renderCard(readyModel({ draft: 'tvly-new' }), { ...actions, addKey: (ref) => added.push(ref) }, t),
  );
  const add = buttonByLabel(typed, '添加');
  assert.equal(add.props.disabled, false);
  add.props.onClick();
  assert.deepEqual(added, ['TAVILY_API_KEY_2']);

  const readOnly = render(module.renderCard(readyModel({ keys: { phase: 'ready', slots: slots([{ writable: false, source: 'env' }]) } }), actions, t));
  assert.equal(buttonByLabel(readOnly, '删除'), undefined);
  assert.match(collectText(readOnly).join('|'), /启动环境变量提供/);

  const unset = render(module.renderCard(readyModel({ keys: { phase: 'ready', slots: slots([]) } }), actions, t));
  const text = collectText(unset).join('|');
  assert.match(text, /未配置密钥/);
  assert.match(text, /存入 DSH 凭据库（TAVILY_API_KEY）/);
  // 有没有 key 都给申请链接（加第二个 key 也要去控制台拿），且只出现一次
  for (const tree of [unset, empty]) {
    const links = collect(tree, (node) => node.type === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.target, '_blank');
    assert.equal(links[0].props.href, 'https://app.tavily.com/home');
    assert.match(collectText(tree).join('|'), /获取 Tavily API Key：/);
  }

  const full = render(
    module.renderCard(readyModel({ draft: 'x', keys: { phase: 'ready', slots: slots(Array(10).fill('zzzz')) } }), actions, t),
  );
  assert.equal(buttonByLabel(full, '添加').props.disabled, true);
  assert.match(collectText(full).join('|'), /已达到上限（10 个）/);

  const failed = render(module.renderCard(readyModel({ keys: { phase: 'error', slots: [], reason: 'HTTP 500' } }), actions, t));
  assert.match(collectText(failed).join('|'), /读取密钥列表失败：HTTP 500/);
  assert.equal(buttonByLabel(failed, '添加').props.disabled, true);
});

test('测试结果：成功列出条数与标题，失败显示原因', () => {
  const { module, t } = boot();
  const ok = render(
    module.renderCard(
      readyModel({ test: { busy: false, result: { ok: true, query: 'DeepSeek', count: 5, elapsedMs: 321, titles: ['A', 'B'] } } }),
      actions,
      t,
    ),
  );
  const okText = collectText(ok).join('|');
  assert.match(okText, /「DeepSeek」返回 5 条结果，用时 321 ms/);
  assert.match(okText, /\|A\|B/);

  const failed = render(
    module.renderCard(readyModel({ test: { busy: false, result: { ok: false, reason: 'Tavily 返回 HTTP 401' } } }), actions, t),
  );
  assert.match(collectText(failed).join('|'), /搜索失败：Tavily 返回 HTTP 401/);
});

test('webModel：按用户层"有没有这个键"判断覆盖，缺省凭据引用回到 DEEPSEEK_API_KEY', () => {
  const { module } = boot();
  assert.deepEqual(module.webModel(undefined), { phase: 'loading' });
  assert.deepEqual(module.webModel({ status: 'unavailable' }), { phase: 'unavailable' });
  assert.deepEqual(
    module.webModel({ status: 'ready', value: { baseURL: 'http://x/v1' }, user: { baseURL: 'http://x/v1' }, writable: true }),
    { phase: 'ready', baseURL: 'http://x/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', overridden: true, keyRefOverridden: false, writable: true },
  );
  assert.equal(module.webModel({ status: 'ready', value: { apiKeyEnv: SHIM_REF }, user: { apiKeyEnv: SHIM_REF } }).keyRefOverridden, true);
  assert.equal(module.webModel({ status: 'ready', value: {}, user: {}, writable: true }).overridden, false);
  assert.equal(module.webModel({ status: 'ready', value: { apiKeyEnv: 'K' }, writable: false }).apiKeyEnv, 'K');
});

/** 「插件更新」区块的基准状态：宿主有官方更新接口、列出了兼容新版本，没有进行中的任务。 */
function updateModel(overrides = {}) {
  return readyModel({
    update: {
      version: { phase: 'ready', ok: true, currentVersion: '26.10.11', latestVersion: '26.10.12', updateAvailable: true },
      manager: { phase: 'ready', candidate: '26.10.12', registry: 'https://registry.npmjs.org/', installedVersion: '26.10.11' },
      market: { phase: 'idle' },
      busy: false,
      ...overrides,
    },
  });
}

/** 旧宿主（没有官方更新接口）退回 dshmarket 时的基准状态：装了市场、从 npm 安装。 */
function marketModel(overrides = {}) {
  return updateModel({
    manager: { phase: 'unsupported', local: false, managed: false, installedVersion: '26.10.11' },
    market: { phase: 'ready', restartSupported: false, endpoints: {}, source: 'npm', updatable: true },
    ...overrides,
  });
}

const VERSION_ROUTE = '/plugins/dsh-tavily-search/version';
const OPERATION_KEY = 'dsh-tavily-search:update-operation';
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
  const versionPayload = version ?? { ...updateModel().update.version };
  const fetcher = async (path, options = {}) => {
    calls.push(['fetch', path, options.method ?? 'GET']);
    if (path.startsWith(VERSION_ROUTE)) {
      assert.match(path, /^\/plugins\/dsh-tavily-search\/version(?:\?force=1)?$/);
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
  const module = loadModule({ fetchImpl: fetcher, crypto, sessionStorage });
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
    const { cards } = boot({ $on: (event) => {
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
  const view = () => render(h.module.renderCard(readyModel({ update: h.updater.getSnapshot() }), actions, translate));
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
  const view = (overrides) => render(module.renderCard(updateModel(overrides), actions, t));
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
  const view = (overrides) => render(module.renderCard(updateModel(overrides), actions, t));
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
  const view = (overrides) => render(module.renderCard(updateModel(overrides), actions, t));
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
  const tree = render(module.renderCard(updateModel({ version: {
    phase: 'ready', currentVersion: '26.10.11', latestVersion: '26.10.11', updateAvailable: false,
  } }), actions, t));
  assert.match(text(tree), /有新版本/);
  assert.ok(buttonByLabel(tree, '更新到 v26.10.12'));
});

test('插件更新 UI：已是最新 / 检查失败', () => {
  const { module, t } = boot();
  const latest = render(module.renderCard(updateModel({ version: UP_TO_DATE, manager: { phase: 'ready', installedVersion: '26.10.12' } }), actions, t));
  assert.match(text(latest), /已是最新/);
  assert.equal(hasUpdateButton(latest), false);

  const failed = render(module.renderCard(updateModel({ version: { phase: 'error', currentVersion: '26.10.11', reason: '连不上注册表' } }), actions, t));
  assert.match(text(failed), /检查更新失败：连不上注册表/);
  assert.match(text(failed), /当前运行版本：\|v26\.10\.11/);
  assert.equal(buttonByLabel(failed, '检查更新').props.disabled, false);
});

test('市场兜底 UI：装了市场 → 按 npm 最新版给按钮，普通更新不带 force；没装市场只提示并展开指定版本安装', () => {
  const { module, t } = boot();
  const started = [];
  const tree = render(module.renderCard(marketModel(), { ...actions, startUpdate: (force) => started.push(force) }, t));
  const update = buttonByLabel(tree, '更新到 v26.10.12');
  assert.equal(update.props.disabled, false);
  update.props.onClick();
  assert.deepEqual(started, [false], '普通更新不带 force');
  assert.equal(pinnedOf(tree).props.open, false, '有一键更新时指定版本安装收起');

  const absent = render(module.renderCard(marketModel({ market: { phase: 'absent' } }), actions, t));
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
  const tree = render(module.renderCard(marketModel({ operation: {
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
  const view = (outcome, market) => render(module.renderCard(marketModel({
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
  const view = (installedVersion) => render(module.renderCard(marketModel({
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
    const tree = render(module.renderCard(
      marketModel({ operation: { channel: 'market', state: 'failed', failure: { code, message: 'x' } } }),
      { ...actions, startUpdate: (force) => started.push(force) },
      t,
    ));
    buttonByLabel(tree, '强制更新').props.onClick();
    assert.equal(pinnedOf(tree).props.open, true);
    if (code === 'RELEASE_TOO_FRESH') assert.match(text(tree), /发布冷却期/);
  }
  assert.deepEqual(started, [true, true]);

  const other = render(module.renderCard(marketModel({ operation: { channel: 'market', state: 'failed', failure: { code: 'UPDATE_FAILED', message: 'pnpm 退出码 1' } } }), actions, t));
  assert.match(text(other), /更新失败：pnpm 退出码 1/);
  assert.equal(buttonByLabel(other, '强制更新'), undefined);
});

test('市场兜底 UI：本地目录 / 桌面托管安装 → 不给更新按钮与指定版本安装，说明怎么更新', () => {
  const { module, t } = boot();
  const view = (overrides) => render(module.renderCard(marketModel(overrides), actions, t));
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
  const tree = render(module.renderCard(marketModel({
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
    const update = marketModel({ market: { phase: 'absent' } }).update;
    // 卡片自身有 12 个 useState（含 web/api/selection 三份设置快照），之后是 useUpdater 的快照与提示
    const states = new Array(12);
    states.push(update, undefined);
    let index = 0;
    const react = { ...React, useState: initial => {
      const slot = index++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
    } };
    const { cards } = boot({ react, clipboard });
    const view = () => { index = 0; return render(cards[0].component(cards[0].spec.inject())); };
    await buttonByLabel(view(), '复制包名和版本').props.onClick();
    assert.match(text(view()), clipboard ? /已复制/ : /手动复制/);
  }
});

/** 「清除插件数据」区块（没有时返回 undefined）。 */
function purgeSectionOf(tree) {
  return collect(tree, (node) => node.props?.className === 'dsm-tv-section').find((node) =>
    collectText(node).includes('清除插件数据'),
  );
}

test('清除插件数据：有可删的 key 或接口正指向本插件时显示危险色按钮；都没有时整块不出现', () => {
  const { module, t } = boot();
  const calls = [];
  const spy = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const tree = render(module.renderCard(readyModel(), spy, t));
  const section = purgeSectionOf(tree);
  assert.ok(section, '已配 key 且已接入时应显示');
  const purge = buttonByLabel(section, '清除插件数据');
  assert.match(purge.props.className, /dsm-tv-btn-danger/);
  assert.match(collectText(section).join('|'), /卸载前点一下/);
  purge.props.onClick();
  assert.deepEqual(calls, [['askPurge']]);

  // 没有 key、网页搜索也没指向本插件：没东西可清。
  const nothing = render(
    module.renderCard(
      readyModel({ keys: { phase: 'ready', slots: slots([]) }, web: { phase: 'ready', baseURL: '', overridden: false, writable: true } }),
      actions,
      t,
    ),
  );
  assert.equal(purgeSectionOf(nothing), undefined);

  // 只有接口指向本插件（没 key）也要显示：卸载后网页搜索会连不上。
  const webOnly = render(module.renderCard(readyModel({ keys: { phase: 'ready', slots: slots([]) } }), actions, t));
  assert.ok(purgeSectionOf(webOnly));
});

test('清除插件数据二次确认：列出要删的 key 数与接口恢复，确认时带上目标', () => {
  const { module, t } = boot();
  const calls = [];
  const spy = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const model = readyModel({
    keys: { phase: 'ready', slots: slots(['aaaa', { writable: false, source: 'env' }, 'cccc']) },
    confirmPurge: true,
  });
  const section = purgeSectionOf(render(module.renderCard(model, spy, t)));
  const text = collectText(section).join('|');
  assert.match(text, /清除插件数据？/);
  assert.match(text, /删除 2 个 Tavily API Key/, '只读来源的 key 不算在内');
  assert.match(text, /恢复为 DSH 默认/);
  buttonByLabel(section, '确认清除').props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'purge');
  const targets = calls[0][1];
  assert.deepEqual(targets.refs, ['TAVILY_API_KEY', 'TAVILY_API_KEY_3']);
  assert.equal(targets.readOnly, 1);
  assert.deepEqual(targets.owned.messages, { web: true, webKeyRef: true });
  assert.deepEqual(targets.owned.api, { web: false, webKeyRef: false });
});

test('purgePluginData：逐个删 key、单个失败不打断，接口指向本插件时恢复默认', async () => {
  const { module } = boot();
  const unset = [];
  const webCalls = [];
  const api = {
    unsetKey: async (ref) => {
      unset.push(ref);
      return ref === 'TAVILY_API_KEY_2' ? { ok: false, error: { message: 'locked' } } : { ok: true, value: true };
    },
    webForm: { unset: async (key) => (webCalls.push(key), true) },
  };
  const ownedOf = (messages, searchApi = { web: false, webKeyRef: false }, extra = {}) => ({
    messages,
    api: searchApi,
    any: messages.web || messages.webKeyRef || searchApi.web || searchApi.webKeyRef,
    deletePlaceholder: messages.webKeyRef || searchApi.webKeyRef,
    restoreFetch: false,
    ...extra,
  });
  const result = await module.purgePluginData({
    api,
    targets: {
      refs: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'TAVILY_API_KEY_3'],
      readOnly: 0,
      owned: ownedOf({ web: true, webKeyRef: false }),
      selection: MESSAGES_SELECTION,
    },
  });
  assert.deepEqual(unset, ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'TAVILY_API_KEY_3'], '一个失败后仍继续删后面的');
  assert.deepEqual(result.removed, ['TAVILY_API_KEY', 'TAVILY_API_KEY_3']);
  assert.deepEqual(result.failed, [{ ref: 'TAVILY_API_KEY_2', reason: 'locked' }]);
  assert.equal(result.restored, true);
  assert.deepEqual(webCalls, ['baseURL']);

  // 接口没指向本插件：不碰网页搜索设置。
  webCalls.length = 0;
  const keysOnly = await module.purgePluginData({
    api,
    targets: { refs: [], readOnly: 0, owned: ownedOf({ web: false, webKeyRef: false }), selection: MESSAGES_SELECTION },
  });
  assert.equal(keysOnly.restored, false);
  assert.deepEqual(webCalls, []);

  // 凭据引用也是本插件写的：一并恢复，并删掉占位凭据。
  unset.length = 0;
  const both = await module.purgePluginData({
    api,
    targets: { refs: [], readOnly: 0, owned: ownedOf({ web: true, webKeyRef: true }), selection: MESSAGES_SELECTION },
  });
  assert.equal(both.restored, true);
  assert.deepEqual(webCalls, ['baseURL', 'apiKeyEnv']);
  assert.deepEqual(unset, [SHIM_REF]);
});

test('清除插件数据：清完后仍显示结果提示（引导去卸载），不再给按钮', () => {
  const { module, t } = boot();
  const nothingLeft = { keys: { phase: 'ready', slots: slots([]) }, web: { phase: 'ready', baseURL: '', overridden: false, writable: true } };
  const ok = render(module.renderCard(readyModel({ ...nothingLeft, purgeNotice: { kind: 'ok', text: '已删除 1 个 API Key。 现在可以去「插件」页卸载本插件。' } }), actions, t));
  const section = purgeSectionOf(ok);
  assert.ok(section, '清完之后仍要显示结果');
  assert.equal(buttonByLabel(section, '清除插件数据'), undefined, '没东西可清时不再给按钮');
  assert.match(collectText(section).join('|'), /去「插件」页卸载/);
});

// ---- DSH 0.2.1-rc.2：网页搜索页的提供方选择（`web` 命名空间）——新版 Search API / Messages 两套接入 ----

test('selectionModel：没下发 / 加载中 / 就绪，空串当没配', () => {
  const { module } = boot();
  assert.deepEqual(module.selectionModel(undefined), { phase: 'loading' });
  assert.deepEqual(module.selectionModel({ status: 'unavailable' }), { phase: 'unavailable' });
  assert.deepEqual(
    module.selectionModel({
      status: 'ready',
      value: { searchProvider: 'deepseek-search-api', fetchProvider: '' },
      base: SELECTION_BASE,
      user: { searchProvider: 'deepseek-search-api' },
      writable: false,
    }),
    { phase: 'ready', searchProvider: 'deepseek-search-api', fetchProvider: undefined, base: SELECTION_BASE, writable: false },
  );
});

test('webMode：按 searchProvider 区分新版 / 旧版 / 被别的插件占用', () => {
  const { module } = boot();
  assert.equal(module.webMode(undefined), 'messages');
  assert.equal(module.webMode({ phase: 'loading' }), 'messages');
  assert.equal(module.webMode(MESSAGES_SELECTION), 'messages');
  assert.equal(module.webMode({ ...MESSAGES_SELECTION, searchProvider: undefined }), 'messages');
  assert.equal(module.webMode(API_SELECTION), 'api');
  assert.equal(module.webMode({ ...API_SELECTION, searchProvider: 'brave' }), 'other');
});

test('新版开关打开且已接入：显示"已接入"与"恢复默认"，不提示绕过', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel({ api: WIRED_API, selection: API_WIRED_SELECTION }), actions, t));
  const text = collectText(tree).join('|');
  assert.match(text, /新版 Web 搜索 API/);
  assert.match(text, /已接入/);
  assert.doesNotMatch(text, /已被占用/);
  assert.ok(buttonByLabel(tree, '恢复默认'));
  assert.equal(buttonByLabel(tree, '接入网页搜索'), undefined);
  assert.match(text, /Search API 基础地址：\|http:\/\/127\.0\.0\.1:8787\/v1\/tools/);
});

test('新版开关打开但还没接入：给"接入网页搜索"，说明会改 Search API 基础地址并保留本地 HTTP 抓取', () => {
  const { module, t } = boot();
  const model = readyModel({ api: { phase: 'ready', baseURL: '', overridden: false, writable: true }, selection: API_SELECTION });
  const tree = render(module.renderCard(model, actions, t));
  const text = collectText(tree).join('|');
  assert.match(text, /未接入/);
  assert.ok(buttonByLabel(tree, '接入网页搜索'));
  assert.match(text, /Search API 基础地址改为 http:\/\/127\.0\.0\.1:8787\/v1\/tools/);
  assert.match(text, /网页抓取保持本地 HTTP 抓取/);
});

test('新版开关打开、抓取提供方还是 deepseek-fetch-api：标"待修复"并说明抓取会被转给本插件', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel({ api: WIRED_API, selection: API_SELECTION }), actions, t));
  const text = collectText(tree).join('|');
  assert.match(text, /待修复/);
  assert.match(text, /抓取请求会被送到本插件/);
  assert.ok(buttonByLabel(tree, '修复接入'));
});

test('新版接入只改了基础地址、仍读 DEEPSEEK_API_KEY / 占位凭据为空：标"待修复"', () => {
  const { module, t } = boot();
  const legacy = render(
    module.renderCard(
      readyModel({
        api: { ...WIRED_API, apiKeyEnv: 'DEEPSEEK_API_KEY', keyRefOverridden: false, keyConfigured: false },
        selection: API_WIRED_SELECTION,
      }),
      actions,
      t,
    ),
  );
  assert.match(collectText(legacy).join('|'), /仍读凭据 DEEPSEEK_API_KEY/);
  const empty = render(
    module.renderCard(readyModel({ api: { ...WIRED_API, keyConfigured: false }, selection: API_WIRED_SELECTION }), actions, t),
  );
  assert.match(collectText(empty).join('|'), /占位凭据 DSH_TAVILY_SEARCH_PLACEHOLDER 是空的/);
});

test('新版搜索插件未加载：提示无法接入新版 API', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel({ api: { phase: 'unavailable' }, selection: API_SELECTION }), actions, t));
  assert.match(collectText(tree).join('|'), /新版搜索插件（web-deepseek-api）当前未加载/);
});

test('搜索提供方是别的插件：标"已被占用"，点名提供方并给接入按钮', () => {
  const { module, t } = boot();
  const calls = [];
  const spy = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const selection = { ...API_SELECTION, searchProvider: 'brave', fetchProvider: 'http' };
  const tree = render(module.renderCard(readyModel({ selection }), spy, t));
  const text = collectText(tree).join('|');
  assert.match(text, /已被占用/);
  assert.match(text, /搜索提供方被设为 brave/);
  buttonByLabel(tree, '接入网页搜索').props.onClick();
  assert.deepEqual(calls, [['wire']]);
});

test('旧版 DSH（没有 web 命名空间）/ 选择仍在加载 / 选的就是 Messages：照旧显示"已接入"', () => {
  const { module, t } = boot();
  for (const selection of [
    undefined,
    { phase: 'unavailable' },
    { phase: 'loading' },
    MESSAGES_SELECTION,
    // 没配提供方时交给宿主自动挑，无从判断，不误报
    { ...MESSAGES_SELECTION, searchProvider: undefined },
  ]) {
    const text = collectText(render(module.renderCard(readyModel({ selection }), actions, t))).join('|');
    assert.match(text, /已接入/, JSON.stringify(selection));
    assert.doesNotMatch(text, /已被占用/);
    assert.match(text, /Messages 搜索（旧版）/);
  }
});

test('提供方选择只读：被别的插件占用时接入按钮禁用并提示只读', () => {
  const { module, t } = boot();
  const selection = { ...API_SELECTION, searchProvider: 'brave', fetchProvider: 'http', writable: false };
  const tree = render(module.renderCard(readyModel({ selection }), actions, t));
  assert.equal(buttonByLabel(tree, '接入网页搜索').props.disabled, true);
  assert.match(collectText(tree).join('|'), /设置为只读/);
});

test('卡片组件从 web 命名空间读选择：新版开关打开时渲染 Search API 一侧，rc.1 没有该命名空间时按 Messages 渲染', () => {
  const webSnapshot = {
    status: 'ready',
    value: { baseURL: ENDPOINT, apiKeyEnv: SHIM_REF },
    user: { baseURL: ENDPOINT, apiKeyEnv: SHIM_REF },
    writable: true,
  };
  const apiSnapshot = {
    status: 'ready',
    value: { baseURL: API_ENDPOINT, apiKeyEnv: SHIM_REF },
    user: { baseURL: API_ENDPOINT, apiKeyEnv: SHIM_REF },
    writable: true,
  };
  const selectionSnapshot = {
    status: 'ready',
    value: { searchProvider: 'deepseek-search-api', fetchProvider: 'http' },
    base: SELECTION_BASE,
    user: { searchProvider: 'deepseek-search-api' },
    writable: true,
  };
  const textOf = ({ cards }) => collectText(render(cards[0].component({ ...cards[0].spec.inject(), view: 'page' }))).join('|');
  const apiText = textOf(boot({ webSnapshot, apiSnapshot, selectionSnapshot }));
  assert.match(apiText, /新版 Web 搜索 API/);
  assert.match(apiText, /Search API 基础地址：\|http:\/\/127\.0\.0\.1:8787\/v1\/tools/);
  const legacy = textOf(boot({ webSnapshot }));
  assert.match(legacy, /Messages 搜索（旧版）/);
  assert.match(legacy, /网页搜索接入\|已接入/);
});

test('selectionWireOps：新版要求 searchProvider=deepseek-search-api 并把抓取从 deepseek-fetch-api 改回本地 HTTP；旧版改回 Messages', () => {
  const { module } = boot();
  const wire = module.selectionWireOps;
  assert.deepEqual(wire({ selection: API_SELECTION, mode: 'api' }), [{ op: 'unset', path: ['fetchProvider'] }]);
  assert.deepEqual(wire({ selection: { ...API_SELECTION, searchProvider: 'brave' }, mode: 'api' }), [
    { op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' },
    { op: 'unset', path: ['fetchProvider'] },
  ]);
  assert.deepEqual(wire({ selection: { ...API_SELECTION, fetchProvider: 'my-fetch' }, mode: 'api' }), [], '抓取不是开关配对写入的不碰');
  assert.deepEqual(wire({ selection: { ...API_SELECTION, base: {} }, mode: 'api' }), [
    { op: 'set', path: ['fetchProvider'], value: 'http' },
  ]);
  assert.deepEqual(wire({ selection: API_SELECTION, mode: 'messages' }), [
    { op: 'unset', path: ['searchProvider'] },
    { op: 'unset', path: ['fetchProvider'] },
  ]);
  assert.deepEqual(wire({ selection: { ...API_SELECTION, searchProvider: 'brave', fetchProvider: 'my-fetch' }, mode: 'messages' }), [
    { op: 'unset', path: ['searchProvider'] },
  ]);
  assert.deepEqual(wire({ selection: MESSAGES_SELECTION, mode: 'messages' }), []);
  assert.deepEqual(wire({ selection: { phase: 'unavailable' }, mode: 'api' }), []);
});

test('清除插件数据（新版接入）：撤销 Search API 覆盖，并把抓取提供方改回 deepseek-fetch-api', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    unsetKey: async (ref) => (calls.push(['unsetKey', ref]), { ok: true }),
    webForm: { mutate: async (ops) => (calls.push(['web-search-deepseek', ops]), true) },
    apiForm: { mutate: async (ops) => (calls.push(['web-deepseek-api', ops]), true) },
    selectionForm: { mutate: async (ops) => (calls.push(['web', ops]), true) },
  };
  const model = readyModel({
    keys: { phase: 'ready', slots: slots([]) },
    web: { phase: 'ready', baseURL: '', overridden: false, writable: true },
    api: WIRED_API,
    selection: API_WIRED_SELECTION,
  });
  const targets = module.purgeTargets(model, ENDPOINT, API_ENDPOINT);
  assert.equal(targets.refs.length, 0);
  assert.deepEqual(targets.owned.api, { web: true, webKeyRef: true });
  assert.equal(targets.owned.restoreFetch, true);
  const result = await module.purgePluginData({ api, targets });
  assert.equal(result.restored, true);
  assert.deepEqual(calls, [
    ['web-deepseek-api', [{ op: 'unset', path: ['baseURL'] }, { op: 'unset', path: ['apiKeyEnv'] }]],
    ['web', [{ op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' }]],
    ['unsetKey', SHIM_REF],
  ]);
});

test('恢复默认不碰提供方选择：本插件没有把标题以外的选择改掉时，不写 `web`', async () => {
  const { module } = boot();
  const selectionCalls = [];
  const selectionForm = new Proxy({}, { get: (_target, name) => (...args) => selectionCalls.push([name, ...args]) });
  const api = {
    unsetKey: async () => ({ ok: true }),
    webForm: { mutate: async () => true },
    selectionForm,
  };
  const owned = {
    messages: { web: true, webKeyRef: true },
    api: { web: false, webKeyRef: false },
    any: true,
    deletePlaceholder: true,
    restoreFetch: false,
  };
  await module.restoreWebSearch(api, owned, MESSAGES_SELECTION);
  await module.purgePluginData({ api, targets: { refs: ['TAVILY_API_KEY'], readOnly: 0, owned, selection: MESSAGES_SELECTION } });
  assert.deepEqual(selectionCalls, []);
});
