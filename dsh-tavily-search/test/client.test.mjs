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
  assert.equal(registration.id, PACKAGE_NAME);
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

test('API Key：草稿为空时添加禁用；写入第一个空槽位；只读 key 无删除按钮；未配置时给出申请链接；满了不能再加', () => {
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
  const links = collect(unset, (node) => node.type === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.target, '_blank');
  assert.match(links[0].props.href, /^https:\/\/app\.tavily\.com/);

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
    { phase: 'ready', baseURL: 'http://x/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', overridden: true, writable: true },
  );
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

test('插件更新：有新版本且装了市场 → 显示两个版本号与"更新到"按钮', () => {
  const { module, t } = boot();
  const started = [];
  const tree = render(module.renderCard(updateModel(), { ...actions, startUpdate: (force) => started.push(force) }, t));
  const text = collectText(tree).join('|');
  assert.match(text, /当前运行版本：\|26\.10\.11/);
  assert.match(text, /npm 最新版本：\|26\.10\.12/);
  assert.match(text, /有新版本/);
  const update = buttonByLabel(tree, '更新到 26.10.12');
  assert.equal(update.props.disabled, false);
  update.props.onClick();
  assert.deepEqual(started, [false], '普通更新不带 force');
});

test('插件更新：没装市场 → 只提示有新版本，没有更新按钮', () => {
  const { module, t } = boot();
  const tree = render(module.renderCard(updateModel({ market: { phase: 'absent' } }), actions, t));
  assert.equal(buttonByLabel(tree, '更新到 26.10.12'), undefined);
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
  assert.match(text, /当前运行版本：\|26\.10\.11/);
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
  assert.match(text, /已更新到 26\.10\.12。 重启 DSH 后生效。/);
  assert.equal(buttonByLabel(desktop, '立即重启 DSH'), undefined, '桌面版的重启归桌面壳管');
  assert.doesNotMatch(text, /注意：装上的是/);

  const web = render(
    module.renderCard(updateModel({ operation, target: '26.10.12', market: { phase: 'ready', restartSupported: true } }), actions, t),
  );
  assert.ok(buttonByLabel(web, '立即重启 DSH'));
});

test('插件更新：装上的版本低于目标时额外警告；高于目标（latest 期间前移）不警告', () => {
  const { module, t } = boot();
  const below = render(
    module.renderCard(
      updateModel({ target: '26.10.12', operation: { state: 'succeeded', installedVersion: '26.10.11', outcome: {} } }),
      actions,
      t,
    ),
  );
  assert.match(collectText(below).join('|'), /注意：装上的是 26\.10\.11，不是预期的 26\.10\.12/);

  const above = render(
    module.renderCard(
      updateModel({ target: '26.10.12', operation: { state: 'succeeded', installedVersion: '26.10.13', outcome: {} } }),
      actions,
      t,
    ),
  );
  assert.doesNotMatch(collectText(above).join('|'), /注意：装上的是/);
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
