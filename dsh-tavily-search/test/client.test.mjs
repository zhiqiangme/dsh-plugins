/**
 * 客户端半侧的契约测试（在 Node 里跑，不需要浏览器）。
 *
 * 卡片在浏览器里出问题时只会整块消失，看不到原因。这里把 bundle 放进沙箱执行，钉住：
 *   1) 文案字典的值必须是字符串、中英文 key 一致（DSH 的 t() 只做 `{name}` 插值）；
 *   2) 两个 slot 的 key 逐字正确（写错不报错，只是卡片不出现）；
 *   3) 凭据只经 remote.credentials 写入，卡片没有任何读回密钥值的路径；
 *   4) renderCard 在各状态下的关键输出（接入/未接入、端口冲突、只读 key、测试结果）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const NAMESPACE = 'settings.dsh-tavily-search';

/** 替身 React：createElement 产出普通对象；hooks 走最简实现（useState 返回初值）。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
};

function loadModule({ withPrimitives = true } = {}) {
  let registration;
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  // eslint-disable-next-line no-new-func -- 故意在沙箱里跑浏览器 bundle
  new Function('window', 'document', 'console', SOURCE)(window, document, console);
  assert.equal(registration.id, 'dsh-tavily-search');
  const primitives = { SettingsSecretField: (props) => React.createElement('host-secret-field', props) };
  return registration.factory((id) => {
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (withPrimitives) return primitives;
      throw new Error('not available');
    }
    throw new Error(`未预期的 require：${id}`);
  });
}

/** 跑一遍 apply，收集字典、卡片注册、凭据调用。 */
function boot(options) {
  const module = loadModule(options);
  const dicts = new Map();
  const cards = [];
  const calls = [];
  const form = {
    getSnapshot: () => ({ status: 'loading' }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  };
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
    configForms: { get: (ns) => (ns === 'web-search-deepseek' ? form : undefined) },
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

/** 一份"一切就绪"的基准 model，各用例在此基础上改。 */
function readyModel(overrides = {}) {
  return {
    status: {
      phase: 'ready',
      endpoint: 'http://127.0.0.1:8787/v1',
      apiKeyRef: 'TAVILY_API_KEY',
      server: { state: 'listening', reason: '' },
    },
    key: { phase: 'ready', configured: true, writable: true },
    draft: '',
    keyBusy: undefined,
    confirmClear: false,
    keyNotice: undefined,
    web: { phase: 'ready', baseURL: 'http://127.0.0.1:8787/v1', overridden: true, writable: true, keyConfigured: true },
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
      ['plugins.bundle.config', 'dsh-tavily-search'],
      ['plugins.row.config', 'dsh-tavily-search#dsh-tavily-search'],
    ],
  );
  assert.equal(module.name, 'dsh-tavily-search-client');
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']);
});

test('注入给卡片的 api 只有写凭据与描述的能力，没有读值路径', async () => {
  const { cards, calls } = boot();
  const { api } = cards[0].spec.inject();
  assert.deepEqual(Object.keys(api).sort(), ['describe', 'onCredentialUpdated', 'setKey', 'unsetKey', 'webForm']);
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

  const slash = render(
    module.renderCard(
      readyModel({ web: { phase: 'ready', baseURL: 'http://127.0.0.1:8787/v1/', overridden: true, writable: true } }),
      actions,
      t,
    ),
  );
  assert.match(collectText(slash).join('|'), /已接入/);
});

test('已接入但网页搜索页的 API Key 为空：提示填任意非空值', () => {
  const { module, t } = boot();
  const tree = render(
    module.renderCard(
      readyModel({ web: { phase: 'ready', baseURL: 'http://127.0.0.1:8787/v1', overridden: true, writable: true, keyConfigured: false } }),
      actions,
      t,
    ),
  );
  assert.match(collectText(tree).join('|'), /填任意非空字符串即可/);
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

test('API Key：草稿为空时保存禁用；只读时显示原因、无清除按钮；未配置时给出申请链接', () => {
  const { module, t } = boot();
  const empty = render(module.renderCard(readyModel(), actions, t));
  assert.equal(buttonByLabel(empty, '保存').props.disabled, true);
  assert.ok(buttonByLabel(empty, '清除密钥'));

  const typed = render(module.renderCard(readyModel({ draft: 'tvly-new' }), actions, t));
  assert.equal(buttonByLabel(typed, '保存').props.disabled, false);

  const readOnly = render(module.renderCard(readyModel({ key: { phase: 'ready', configured: true, writable: false } }), actions, t));
  assert.equal(buttonByLabel(readOnly, '清除密钥'), undefined);
  assert.match(collectText(readOnly).join('|'), /由启动环境变量提供/);

  const unset = render(module.renderCard(readyModel({ key: { phase: 'ready', configured: false, writable: true } }), actions, t));
  const text = collectText(unset).join('|');
  assert.match(text, /未配置密钥/);
  const links = collect(unset, (node) => node.type === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.target, '_blank');
  assert.match(links[0].props.href, /^https:\/\/app\.tavily\.com/);
});

test('清除密钥需要二次确认', () => {
  const { module, t } = boot();
  const asking = render(module.renderCard(readyModel({ confirmClear: true }), actions, t));
  assert.match(collectText(asking).join('|'), /确定清除/);
  assert.ok(buttonByLabel(asking, '确认清除'));
  assert.ok(buttonByLabel(asking, '取消'));
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
    { phase: 'ready', baseURL: 'http://x/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', overridden: true, writable: true },
  );
  assert.equal(module.webModel({ status: 'ready', value: {}, user: {}, writable: true }).overridden, false);
  assert.equal(module.webModel({ status: 'ready', value: { apiKeyEnv: 'K' }, writable: false }).apiKeyEnv, 'K');
});
