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

function loadModule({ withPrimitives = true, react = React, fetchImpl = globalThis.fetch, clipboard } = {}) {
  let registration;
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } }, navigator: { clipboard } };
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
 * options.webSnapshot / options.selectionSnapshot 给两个设置命名空间的快照；
 * selectionSnapshot 为 undefined 时 `web` 命名空间不存在（模拟 0.2.1-rc.1 及更早）。
 */
function boot(options = {}) {
  const module = loadModule(options);
  const dicts = new Map();
  const cards = [];
  const calls = [];
  const formOf = (snapshot) => ({
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  });
  const form = formOf(options.webSnapshot ?? { status: 'loading' });
  const forms = { 'web-search-deepseek': form };
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
      $on: () => () => {},
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
  return { module, dicts, cards, calls, t, form };
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
/** 完整接入后的网页搜索快照：接口地址与凭据引用都由本插件覆盖，占位凭据有值。 */
const WIRED_WEB = {
  phase: 'ready',
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKeyEnv: SHIM_REF,
  overridden: true,
  keyRefOverridden: true,
  writable: true,
  keyConfigured: true,
};

/** 一份"一切就绪"的基准 model，各用例在此基础上改。 */
function readyModel(overrides = {}) {
  return {
    status: {
      phase: 'ready',
      endpoint: 'http://127.0.0.1:8787/v1',
      apiKeyRef: 'TAVILY_API_KEY',
      server: { state: 'listening', reason: '' },
    },
    keys: { phase: 'ready', slots: slots(['abcd']) },
    draft: '',
    keyBusy: undefined,
    confirmRemove: undefined,
    keyNotice: undefined,
    web: WIRED_WEB,
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
  assert.deepEqual(Object.keys(api).sort(), ['describe', 'onCredentialUpdated', 'selectionForm', 'setKey', 'unsetKey', 'webForm']);
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

test('wireWebSearch：占位凭据为空时先写入，再一次 mutate 改凭据引用与接口地址', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    describe: async (refs) => (calls.push(['describe', refs]), { ok: true, value: { [SHIM_REF]: { configured: false } } }),
    setKey: async (ref, value) => (calls.push(['setKey', ref, value]), { ok: true, value: undefined }),
    webForm: { mutate: async (ops) => (calls.push(['mutate', ops]), true) },
  };
  assert.equal(await module.wireWebSearch(api, 'http://127.0.0.1:8787/v1'), true);
  assert.deepEqual(calls, [
    ['describe', [SHIM_REF]],
    ['setKey', SHIM_REF, 'dsh-tavily-search'],
    [
      'mutate',
      [
        { op: 'set', path: ['apiKeyEnv'], value: SHIM_REF },
        { op: 'set', path: ['baseURL'], value: 'http://127.0.0.1:8787/v1' },
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
  assert.equal(await module.wireWebSearch(api, 'http://e/v1'), false);
  assert.deepEqual(calls, [['set', 'apiKeyEnv', SHIM_REF]], '不写占位凭据；apiKeyEnv 被拒后不再改接口地址');
});

test('restoreWebSearch：只撤销本插件写的覆盖，撤销凭据引用后删掉占位凭据；没东西可撤销时不写', async () => {
  const { module } = boot();
  const calls = [];
  const api = {
    unsetKey: async (ref) => (calls.push(['unsetKey', ref]), { ok: true }),
    webForm: { mutate: async (ops) => (calls.push(['mutate', ops]), true) },
  };
  assert.equal(await module.restoreWebSearch(api, { web: true, webKeyRef: true }), true);
  assert.deepEqual(calls, [
    ['mutate', [{ op: 'unset', path: ['baseURL'] }, { op: 'unset', path: ['apiKeyEnv'] }]],
    ['unsetKey', SHIM_REF],
  ]);

  calls.length = 0;
  assert.equal(await module.restoreWebSearch(api, { web: true, webKeyRef: false }), true);
  assert.deepEqual(calls, [['mutate', [{ op: 'unset', path: ['baseURL'] }]]], '凭据引用不是本插件写的就不碰，也不删占位凭据');

  calls.length = 0;
  assert.equal(await module.restoreWebSearch(api, { web: false, webKeyRef: false }), undefined);
  assert.deepEqual(calls, []);
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

/** 「插件更新」区块的基准状态：有新版本、装了市场、没有进行中的任务。 */
function updateModel(overrides = {}) {
  return readyModel({
    update: {
      version: { phase: 'ready', ok: true, currentVersion: '26.10.11', latestVersion: '26.10.12', updateAvailable: true },
      market: { phase: 'ready', restartSupported: false, endpoints: {} },
      operation: undefined,
      target: undefined,
      busy: false,
      notice: undefined,
      restart: undefined,
      ...overrides,
    },
  });
}

/** 保留 hooks 状态，验证实际卡片按钮的异步动作，而不是只检查渲染文案。 */
function updateCard(overrides, options = {}) {
  const update = updateModel(overrides).update;
  const states = new Array(11);
  states.push(update.version, update.market, update.operation, update.target, update.busy, update.notice, update.restart);
  let index = 0;
  const react = {
    ...React,
    useState: (initial) => {
      const slot = index++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
    },
  };
  const { cards } = boot({ ...options, react });
  return () => {
    index = 0;
    const card = cards[0];
    const tree = render(card.component({ ...card.spec.inject(), view: 'page' }));
    return collect(tree, (node) => node.props.key === 'update')[0];
  };
}

test('指定版本安装：规范化 v 前缀，拒绝标签、范围和非版本输入', () => {
  const { module } = boot();
  assert.equal(module.pinnedInstallSpec('v26.10.17'), `${PACKAGE_NAME}@26.10.17`);
  assert.equal(module.pinnedInstallSpec('27.1.1-rc.1+build.2'), `${PACKAGE_NAME}@27.1.1-rc.1+build.2`);
  for (const value of [undefined, 'latest', '^26.10.17', '26.10.17.1', 'https://example.com/pkg.tgz', '26.10.17 --force']) {
    assert.equal(module.pinnedInstallSpec(value), undefined);
  }
});

test('指定版本安装：无需市场；冷却期或安装版本不足时展开，已装最新 / 本地 / 托管来源隐藏', () => {
  const { module, t } = boot();
  const section = (overrides) => collect(render(module.renderCard(updateModel(overrides), actions, t)), (node) => node.props.key === 'update')[0];
  const details = (tree) => collect(tree, (node) => node.type === 'details' && node.props.key === 'pinnedInstall')[0];
  const absent = section({ market: { phase: 'absent' } });
  const input = collect(absent, (node) => node.type === 'input')[0];
  assert.equal(input.props.value, `${PACKAGE_NAME}@26.10.12`);
  assert.equal(input.props.readOnly, true);
  let selected = false;
  input.props.onFocus({ currentTarget: { select: () => { selected = true; } } });
  assert.equal(selected, true);
  for (const code of ['RELEASE_TOO_FRESH', 'VERSION_UNCHANGED']) {
    assert.equal(details(section({ operation: { state: 'failed', failure: { code } } })).props.open, true);
  }
  assert.equal(details(section({ operation: { state: 'succeeded', installedVersion: '26.10.11' } })).props.open, true);
  for (const source of ['linked', 'generation']) {
    assert.equal(details(section({ market: { phase: 'ready', source, updatable: false } })), undefined);
  }
  assert.equal(details(section({ operation: { state: 'succeeded', installedVersion: '26.10.12' } })), undefined);
  assert.equal(details(section({ operation: { state: 'running' } })), undefined);
  assert.equal(details(section({ version: { phase: 'error', reason: 'offline' } })), undefined);
});

test('指定版本安装：复制最新规格；剪贴板不可用时仍保留可手动复制的完整规格', async () => {
  const copied = [];
  const section = updateCard({}, { clipboard: { writeText: async (value) => { copied.push(value); } } });
  await buttonByLabel(section(), '复制包名和版本').props.onClick();
  assert.deepEqual(copied, [`${PACKAGE_NAME}@26.10.12`]);
  assert.match(collectText(section()).join('|'), /已复制 @zhiqiangme\/dsh-tavily-search@26\.10\.12/);

  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    const fallback = updateCard({}, { clipboard });
    await buttonByLabel(fallback(), '复制包名和版本').props.onClick();
    assert.match(collectText(fallback()).join('|'), /手动复制/);
    assert.equal(collect(fallback(), (node) => node.type === 'input')[0].props.value, `${PACKAGE_NAME}@26.10.12`);
  }
});

test('指定版本安装不改变市场公开 API：普通一键更新仍发送纯包名', async () => {
  const requests = [];
  const section = updateCard({ market: { phase: 'ready', endpoints: { updates: '/market/updates' } } }, {
    fetchImpl: async (path, options) => {
      requests.push({ path, body: JSON.parse(options.body) });
      return { status: 202, json: async () => ({ operation: { operationId: 'b-1', state: 'running' } }) };
    },
  });
  await buttonByLabel(section(), '更新到 v26.10.12').props.onClick();
  assert.deepEqual(requests, [{ path: '/market/updates', body: { packageName: PACKAGE_NAME } }]);
});

test('插件更新：有新版本且装了市场 → 显示两个版本号与"更新到"按钮', () => {
  const { module, t } = boot();
  const started = [];
  const tree = render(module.renderCard(updateModel(), { ...actions, startUpdate: (force) => started.push(force) }, t));
  const text = collectText(tree).join('|');
  assert.match(text, /当前运行版本：\|v26\.10\.11/);
  assert.match(text, /npm 最新版本：\|v26\.10\.12/);
  assert.match(text, /有新版本/);
  const update = buttonByLabel(tree, '更新到 v26.10.12');
  assert.equal(update.props.disabled, false);
  update.props.onClick();
  assert.deepEqual(started, [false], '普通更新不带 force');
});

test('插件更新：没装市场 → 只提示有新版本，没有更新按钮', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(updateModel({ market: { phase: 'absent' } }), actions, t));
  assert.equal(buttonByLabel(tree, '更新到 v26.10.12'), undefined);
  assert.match(collectText(tree).join('|'), /dshmarket/);
  assert.ok(buttonByLabel(tree, '检查更新'));
});

test('插件更新：已是最新 / 检查失败', () => {
  const { module, t } = boot();
  const latest = render(
    module.renderCard(
      updateModel({ version: { phase: 'ready', ok: true, currentVersion: '26.10.12', latestVersion: '26.10.12', updateAvailable: false } }),
      actions,
      t,
    ),
  );
  assert.match(collectText(latest).join('|'), /已是最新/);
  assert.equal(buttons(latest).some((node) => collectText(node.children).join('').startsWith('更新到')), false);

  const failed = render(
    module.renderCard(updateModel({ version: { phase: 'error', currentVersion: '26.10.11', reason: '连不上注册表' } }), actions, t),
  );
  const text = collectText(failed).join('|');
  assert.match(text, /检查更新失败：连不上注册表/);
  assert.match(text, /当前运行版本：\|v26\.10\.11/);
  assert.equal(buttonByLabel(failed, '检查更新').props.disabled, false);
});

test('插件更新：进行中显示进度，按钮全部禁用', () => {
  const { module, t } = boot();
  const tree = render(
    module.renderCard(
      updateModel({ operation: { operationId: 'b-update-1', state: 'running', progress: { percent: 40, detail: 'Progress: resolved 3' } } }),
      actions,
      t,
    ),
  );
  const text = collectText(tree).join('|');
  assert.match(text, /正在更新… 40%/);
  assert.match(text, /Progress: resolved 3/);
  assert.equal(buttonByLabel(tree, '检查更新').props.disabled, true);
  assert.equal(buttonByLabel(tree, '正在更新…').props.disabled, true);
});

test('插件更新：成功后按 restartRequired 提示重启；市场支持重启时才给重启按钮', () => {
  const { module, t } = boot();
  const operation = {
    operationId: 'b-update-1',
    state: 'succeeded',
    installedVersion: '26.10.12',
    outcome: { restartRequired: true, refreshRequired: false },
  };
  const desktop = render(module.renderCard(updateModel({ operation, target: '26.10.12' }), actions, t));
  const text = collectText(desktop).join('|');
  assert.match(text, /已更新到 v26\.10\.12。 重启 DSH 后生效。/);
  assert.equal(buttonByLabel(desktop, '立即重启 DSH'), undefined, '桌面版的重启归桌面壳管');
  assert.doesNotMatch(text, /注意：装上的是/);

  const web = render(
    module.renderCard(updateModel({ operation, target: '26.10.12', market: { phase: 'ready', restartSupported: true } }), actions, t),
  );
  assert.ok(buttonByLabel(web, '立即重启 DSH'));
});

test('插件更新：成功后徽章显示"等待重启/等待刷新"，且不再给"更新到"按钮', () => {
  // 更新成功后当前运行版本仍是旧版，单看版本号会永远说"有新版本"并留着更新按钮，
  // 再点只会重装同一版。徽章要改口，按钮要收走。
  const { module, t } = boot();
  const base = { installedVersion: '26.10.12' };
  const restart = render(
    module.renderCard(
      updateModel({ operation: { ...base, state: 'succeeded', outcome: { restartRequired: true } }, target: '26.10.12' }),
      actions,
      t,
    ),
  );
  const restartText = collectText(restart).join('|');
  assert.match(restartText, /等待重启/);
  assert.doesNotMatch(restartText, /有新版本/);
  assert.equal(buttonByLabel(restart, '更新到 v26.10.12'), undefined);
  assert.ok(buttonByLabel(restart, '检查更新'), '重新检查仍然可用');

  const refresh = render(
    module.renderCard(
      updateModel({ operation: { ...base, state: 'succeeded', outcome: { refreshRequired: true } }, target: '26.10.12' }),
      actions,
      t,
    ),
  );
  assert.match(collectText(refresh).join('|'), /等待刷新/);
  assert.equal(buttonByLabel(refresh, '更新到 v26.10.12'), undefined);

  const live = render(
    module.renderCard(updateModel({ operation: { ...base, state: 'succeeded', outcome: {} }, target: '26.10.12' }), actions, t),
  );
  const liveText = collectText(live).join('|');
  assert.match(liveText, /已是最新/);
  assert.doesNotMatch(liveText, /等待重启/);
});

test('插件更新：成功后重新检查发现更高版本，恢复徽章和可用的更新按钮', async () => {
  for (const outcome of [{ restartRequired: true }, { refreshRequired: true }, {}]) {
    const update = updateModel({
      operation: { state: 'succeeded', installedVersion: '26.10.12', outcome },
      target: '26.10.12',
    }).update;
    // 卡片自身的 11 个 state 后，才是 useUpdater 的 7 个 state；空槽按初值初始化。
    const states = new Array(11);
    states.push(update.version, update.market, update.operation, update.target, update.busy, update.notice, update.restart);
    let index = 0;
    const react = {
      ...React,
      useState: (initial) => {
        const slot = index++;
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
        return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
      },
    };
    const requests = [];
    const { cards } = boot({
      react,
      fetchImpl: async (path, options) => {
        requests.push({ path, method: options.method });
        return {
          ok: true,
          json: async () => ({ ok: true, currentVersion: '26.10.11', latestVersion: '26.10.13', updateAvailable: true }),
        };
      },
    });
    const section = () => {
      index = 0;
      const card = cards[0];
      const tree = render(card.component({ ...card.spec.inject(), view: 'page' }));
      return collect(tree, (node) => node.props.key === 'update')[0];
    };
    assert.equal(buttonByLabel(section(), '更新到 v26.10.12'), undefined);

    buttonByLabel(section(), '检查更新').props.onClick();
    await new Promise((resolve) => setImmediate(resolve));

    const tree = section();
    const text = collectText(tree).join('|');
    assert.deepEqual(requests, [{ path: '/plugins/dsh-tavily-search/version?force=1', method: 'GET' }]);
    assert.match(text, /有新版本/);
    assert.doesNotMatch(text, /等待重启|等待刷新|已是最新/);
    assert.equal(buttonByLabel(tree, '更新到 v26.10.13')?.props.disabled, false);
    assert.match(text, /已更新到 v26\.10\.12/, '保留上次更新结果，不靠清空任务恢复入口');
  }
});

test('插件更新：装上的版本低于目标时警告并允许重试；高于目标不警告也不重复更新', () => {
  const { module, t } = boot();
  const below = render(
    module.renderCard(
      updateModel({ target: '26.10.12', operation: { state: 'succeeded', installedVersion: '26.10.11', outcome: {} } }),
      actions,
      t,
    ),
  );
  assert.match(collectText(below).join('|'), /注意：装上的是 v26\.10\.11，不是预期的 v26\.10\.12/);
  assert.match(collectText(below).join('|'), /有新版本/);
  assert.doesNotMatch(collectText(below).join('|'), /已是最新/);
  assert.equal(buttonByLabel(below, '更新到 v26.10.12')?.props.disabled, false);

  const above = render(
    module.renderCard(
      updateModel({ target: '26.10.12', operation: { state: 'succeeded', installedVersion: '26.10.13', outcome: {} } }),
      actions,
      t,
    ),
  );
  assert.doesNotMatch(collectText(above).join('|'), /注意：装上的是/);
  assert.match(collectText(above).join('|'), /已是最新/);
  assert.equal(buttonByLabel(above, '更新到 v26.10.12'), undefined);
});

test('插件更新：发布冷却期 / 版本未变时给"强制更新"，其它失败不给', () => {
  const { module, t } = boot();
  const started = [];
  const fresh = render(
    module.renderCard(
      updateModel({ operation: { state: 'failed', failure: { code: 'RELEASE_TOO_FRESH', message: 'x' } } }),
      { ...actions, startUpdate: (force) => started.push(force) },
      t,
    ),
  );
  assert.match(collectText(fresh).join('|'), /发布冷却期/);
  buttonByLabel(fresh, '强制更新').props.onClick();
  assert.deepEqual(started, [true]);

  const other = render(
    module.renderCard(updateModel({ operation: { state: 'failed', failure: { code: 'UPDATE_FAILED', message: 'pnpm 退出码 1' } } }), actions, t),
  );
  assert.match(collectText(other).join('|'), /更新失败：pnpm 退出码 1/);
  assert.equal(buttonByLabel(other, '强制更新'), undefined);
});

test('插件更新：本地目录安装（file:）→ 不给更新按钮，说明怎么更新', () => {
  const { module, t } = boot();
  const market = { phase: 'ready', restartSupported: false, endpoints: {}, source: 'linked', updatable: false };
  const tree = render(module.renderCard(updateModel({ market }), actions, t));
  assert.equal(buttonByLabel(tree, '更新到 v26.10.12'), undefined, 'dshmarket 会拒绝本地安装，按钮点了也只会失败');
  assert.match(collectText(tree).join('|'), /本地目录（file:）/);
  assert.ok(buttonByLabel(tree, '检查更新'));

  const managed = render(module.renderCard(updateModel({ market: { ...market, source: 'generation' } }), actions, t));
  assert.match(collectText(managed).join('|'), /DSH 桌面端统一管理/);

  const npm = render(module.renderCard(updateModel({ market: { ...market, source: 'npm', updatable: true } }), actions, t));
  assert.ok(buttonByLabel(npm, '更新到 v26.10.12'), 'npm 安装照常给按钮');
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
  assert.deepEqual(calls, [['purge', { refs: ['TAVILY_API_KEY', 'TAVILY_API_KEY_3'], readOnly: 1, web: true, webKeyRef: true }]]);
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
  const result = await module.purgePluginData({
    api,
    targets: { refs: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'TAVILY_API_KEY_3'], readOnly: 0, web: true },
  });
  assert.deepEqual(unset, ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'TAVILY_API_KEY_3'], '一个失败后仍继续删后面的');
  assert.deepEqual(result.removed, ['TAVILY_API_KEY', 'TAVILY_API_KEY_3']);
  assert.deepEqual(result.failed, [{ ref: 'TAVILY_API_KEY_2', reason: 'locked' }]);
  assert.equal(result.restored, true);
  assert.deepEqual(webCalls, ['baseURL']);

  // 接口没指向本插件：不碰网页搜索设置。
  webCalls.length = 0;
  const keysOnly = await module.purgePluginData({ api, targets: { refs: [], readOnly: 0, web: false } });
  assert.equal(keysOnly.restored, false);
  assert.deepEqual(webCalls, []);

  // 凭据引用也是本插件写的：一并恢复，并删掉占位凭据。
  unset.length = 0;
  const both = await module.purgePluginData({ api, targets: { refs: [], readOnly: 0, web: true, webKeyRef: true } });
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

// ---- DSH 0.2.1-rc.2：网页搜索页的「启用新版 Web 搜索 API」开关（`web` 命名空间的提供方选择）----

/** 部署默认（base 层）的提供方选择，与 DSH 自带 bundle 一致。 */
const SELECTION_BASE = { searchProvider: 'deepseek-official', fetchProvider: 'http' };
/** 开关打开后的选择：用户层写了 Search / Fetch API。 */
const API_SELECTION = {
  phase: 'ready',
  searchProvider: 'deepseek-search-api',
  fetchProvider: 'deepseek-fetch-api',
  base: SELECTION_BASE,
  writable: true,
};

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

test('新版 Search API 开关打开：接入齐全也标"已被绕过"，给"修复接入"并说明会关掉开关；"恢复默认"仍在', () => {
  const { module, t } = boot();
  const calls = [];
  const spy = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const tree = render(module.renderCard(readyModel({ selection: API_SELECTION }), spy, t));
  const text = collectText(tree).join('|');
  assert.match(text, /已被绕过/);
  assert.doesNotMatch(text, /已接入/);
  assert.match(text, /搜索提供方：\|deepseek-search-api/);
  assert.match(text, /打开了「启用新版 Web 搜索 API」/);
  assert.match(text, /点「修复接入」会关掉这个开关/);
  buttonByLabel(tree, '修复接入').props.onClick();
  assert.deepEqual(calls, [['wire']]);
  assert.ok(buttonByLabel(tree, '恢复默认'), '接口地址与凭据引用仍是本插件写的，可以撤销');
});

test('新版开关打开且还没接入：按钮是"接入网页搜索"，绕过提示与接入提示都给', () => {
  const { module, t } = boot();
  const model = readyModel({ web: { phase: 'ready', baseURL: '', overridden: false, writable: true }, selection: API_SELECTION });
  const tree = render(module.renderCard(model, actions, t));
  const text = collectText(tree).join('|');
  assert.match(text, /已被绕过/);
  assert.match(text, /点「接入网页搜索」会关掉这个开关/);
  assert.match(text, /接口地址改为 http:\/\/127\.0\.0\.1:8787\/v1/);
  assert.ok(buttonByLabel(tree, '接入网页搜索'));
});

test('搜索提供方是别的插件：同样算绕过，提示里点名提供方', () => {
  const { module, t } = boot();
  const selection = { ...API_SELECTION, searchProvider: 'brave', fetchProvider: 'http' };
  const text = collectText(render(module.renderCard(readyModel({ selection }), actions, t))).join('|');
  assert.match(text, /已被绕过/);
  assert.match(text, /搜索提供方被设为 brave/);
});

test('旧版 DSH（没有 web 命名空间）/ 选择仍在加载 / 选的就是 Messages：照常显示"已接入"', () => {
  const { module, t } = boot();
  for (const selection of [
    undefined,
    { phase: 'unavailable' },
    { phase: 'loading' },
    { ...API_SELECTION, searchProvider: 'deepseek-official', fetchProvider: 'http' },
    // 没配提供方时交给宿主自动挑，无从判断，不误报
    { ...API_SELECTION, searchProvider: undefined },
  ]) {
    const text = collectText(render(module.renderCard(readyModel({ selection }), actions, t))).join('|');
    assert.match(text, /已接入/, JSON.stringify(selection));
    assert.doesNotMatch(text, /已被绕过/);
  }
});

test('提供方选择只读：修复按钮禁用并提示只读', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(readyModel({ selection: { ...API_SELECTION, writable: false } }), actions, t));
  assert.equal(buttonByLabel(tree, '修复接入').props.disabled, true);
  assert.match(collectText(tree).join('|'), /设置为只读/);
});

test('卡片组件从 web 命名空间读选择：rc.2 开关打开时显示"已被绕过"，rc.1 没有该命名空间时不受影响', () => {
  const webSnapshot = {
    status: 'ready',
    value: { baseURL: 'http://127.0.0.1:8787/v1', apiKeyEnv: SHIM_REF },
    user: { baseURL: 'http://127.0.0.1:8787/v1', apiKeyEnv: SHIM_REF },
    writable: true,
  };
  const selectionSnapshot = {
    status: 'ready',
    value: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
    base: SELECTION_BASE,
    user: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
    writable: true,
  };
  const textOf = ({ cards }) => collectText(render(cards[0].component({ ...cards[0].spec.inject(), view: 'page' }))).join('|');
  assert.match(textOf(boot({ webSnapshot, selectionSnapshot })), /已被绕过/);
  const legacy = textOf(boot({ webSnapshot }));
  assert.doesNotMatch(legacy, /已被绕过/);
  assert.match(legacy, /网页搜索接入\|已接入/);
});

test('selectionResetOps：照宿主页关开关的写法，等于部署默认时清覆盖，否则显式写；单独选的抓取方式不碰', () => {
  const { module } = boot();
  assert.deepEqual(module.selectionResetOps(API_SELECTION), [
    { op: 'unset', path: ['searchProvider'] },
    { op: 'unset', path: ['fetchProvider'] },
  ]);
  assert.deepEqual(module.selectionResetOps({ ...API_SELECTION, base: {} }), [
    { op: 'set', path: ['searchProvider'], value: 'deepseek-official' },
    { op: 'set', path: ['fetchProvider'], value: 'http' },
  ]);
  assert.deepEqual(
    module.selectionResetOps({ ...API_SELECTION, fetchProvider: 'my-fetch' }),
    [{ op: 'unset', path: ['searchProvider'] }],
    '抓取不是开关配对写的 deepseek-fetch-api 时保持原样',
  );
  assert.deepEqual(module.selectionResetOps({ ...API_SELECTION, searchProvider: 'deepseek-official' }), []);
  assert.deepEqual(module.selectionResetOps({ phase: 'unavailable' }), []);
});

test('wireWebSearch：被新版开关绕过时，先改 Messages 的接口地址与凭据，再把提供方改回 Messages', async () => {
  const { module } = boot();
  const calls = [];
  const selectionSnapshot = {
    status: 'ready',
    value: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
    base: SELECTION_BASE,
    user: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
    writable: true,
  };
  const api = {
    describe: async () => ({ ok: true, value: { [SHIM_REF]: { configured: true } } }),
    setKey: async () => ({ ok: true }),
    webForm: { mutate: async (ops) => (calls.push(['web-search-deepseek', ops]), true) },
    selectionForm: { getSnapshot: () => selectionSnapshot, mutate: async (ops) => (calls.push(['web', ops]), true) },
  };
  assert.equal(await module.wireWebSearch(api, 'http://127.0.0.1:8787/v1'), true);
  assert.deepEqual(calls, [
    [
      'web-search-deepseek',
      [
        { op: 'set', path: ['apiKeyEnv'], value: SHIM_REF },
        { op: 'set', path: ['baseURL'], value: 'http://127.0.0.1:8787/v1' },
      ],
    ],
    ['web', [{ op: 'unset', path: ['searchProvider'] }, { op: 'unset', path: ['fetchProvider'] }]],
  ]);

  // Messages 那一侧被拒：不切提供方，免得切到一个没接好的接口
  calls.length = 0;
  api.webForm.mutate = async (ops) => (calls.push(['web-search-deepseek', ops]), false);
  assert.equal(await module.wireWebSearch(api, 'http://127.0.0.1:8787/v1'), false);
  assert.equal(calls.length, 1);

  // 没有 web 命名空间（旧版 DSH）或没下发：只写 Messages 一侧
  for (const selectionForm of [undefined, { getSnapshot: () => ({ status: 'unavailable' }) }]) {
    calls.length = 0;
    api.webForm.mutate = async (ops) => (calls.push(['web-search-deepseek', ops]), true);
    assert.equal(await module.wireWebSearch({ ...api, selectionForm }, 'http://e/v1'), true);
    assert.deepEqual(calls.map(([ns]) => ns), ['web-search-deepseek']);
  }
});

test('恢复默认 / 清除插件数据不碰提供方选择：本插件只写过 Messages 一侧的覆盖', async () => {
  const { module } = boot();
  const selectionCalls = [];
  const selectionForm = new Proxy({}, { get: (_target, name) => (...args) => selectionCalls.push([name, ...args]) });
  const api = {
    unsetKey: async () => ({ ok: true }),
    webForm: { mutate: async () => true },
    selectionForm,
  };
  await module.restoreWebSearch(api, { web: true, webKeyRef: true });
  await module.purgePluginData({ api, targets: { refs: ['TAVILY_API_KEY'], readOnly: 0, web: true, webKeyRef: true } });
  assert.deepEqual(selectionCalls, []);
});
