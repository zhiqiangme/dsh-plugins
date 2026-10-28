import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { clientHarness, button, field, nodes } from '../fixtures/client.mjs';
import { resolveConfig, PACKAGE_NAME } from '../lib/config.js';

const VERSION_ROUTE = '/plugins/dsh-magpie/version';
const OPERATION_KEY = 'dsh-magpie:update-operation';
// 卡片里 useUpdater 的状态位：排在模型草稿等 8 个状态与拖动 ref 之后。
const UPDATE_STATE = 9;
const version = { phase: 'ready', ok: true, currentVersion: '26.10.22', latestVersion: '26.10.23', updateAvailable: true };
const UP_TO_DATE = { ok: true, currentVersion: '26.10.23', latestVersion: '26.10.23', updateAvailable: false };
// 旧宿主（没有官方更新接口）退回 dshmarket 时的基准状态：装了市场、从 npm 安装。
const legacy = { phase: 'unsupported', local: false, managed: false, installedVersion: '26.10.22' };
const market = { phase: 'ready', restartSupported: false, endpoints: { updates: '/market/updates', operations: '/market/operations' } };
// 宿主有官方更新接口、列出了兼容新版本时的基准状态。
const official = { phase: 'ready', candidate: '26.10.23', registry: 'https://registry.npmjs.org/', installedVersion: '26.10.22' };
const initialView = () => ({ ok: true, config: resolveConfig({ models: [{ id: 'qoder-cn/dfmodel', name: 'DeepSeek-Flash' }] }), editable: true, nativeProviders: [] });
const noop = () => {};
const actions = { checkUpdate: noop, startUpdate: noop, restart: noop };
const text = (tree) => Array.isArray(tree) ? tree.map(text).join('|') : typeof tree === 'string' ? tree : tree?.children ? text(tree.children) : '';
const hasUpdateButton = (tree) => nodes(tree, (n) => n.type === 'button' && String(n.children[0]).startsWith('更新到')).length > 0;
/** 让挂起的 promise 链跑完（setImmediate 不在 mock.timers 的接管范围内）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function render(overrides = {}, callbacks = actions) {
  const client = clientHarness();
  const t = (key, values) => client.module.zh[key].replace(/\{(\w+)\}/g, (m, k) => values?.[k] ?? m);
  return client.module.renderUpdateSection({ version, manager: legacy, market, busy: false, ...overrides }, callbacks, t);
}

/** 渲染整张卡片并把更新器状态位换成给定快照；插件更新在「更新」标签页。 */
function setup(overrides = {}) {
  const client = clientHarness(initialView());
  client.render();
  client.states[UPDATE_STATE] = { version, manager: legacy, market, busy: false, ...overrides };
  return client;
}
const section = (client) => { client.tab('更新'); return nodes(client.render(), (n) => n.props.className === 'plugin-update')[0]; };

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
  const bundle = { name: PACKAGE_NAME, version: '26.10.22', source: `${PACKAGE_NAME}@26.10.22`, availability: 'profile', official: false, ...extra };
  return { bundle, manager: { listBundles: async () => ({ ok: true, value: [bundle] }) } };
}

/**
 * dshmarket 公开更新 API v1 的替身；endpoints 是 capabilities 答复里的自定义路由，
 * ops 依次作为每次任务查询的答复，用完答 404（任务已不在）。
 */
function fakeMarket({ source = 'npm', bootId = 'b', restartSupported = false, submit, ops = [], endpoints } = {}) {
  const posted = [];
  const routes = { updates: '/dsh-market/api/v1/updates', operations: '/dsh-market/api/v1/operations', restart: '/dsh-market/api/v1/restart', ...endpoints };
  const handle = (path, options) => {
    if (path === '/dsh-market/api/v1/capabilities') {
      return { status: 200, body: { schema: 'dsh-market/update-api/v1', features: { update: true }, bootId, restart: { supported: restartSupported }, endpoints } };
    }
    if (path.startsWith(`${routes.updates}?name=`)) return { status: 200, body: { package: { source } } };
    if (path === routes.updates && options.method === 'POST') {
      posted.push(JSON.parse(options.body));
      return submit ?? { status: 202, body: { operation: { operationId: `${bootId}-1`, state: 'running' } } };
    }
    if (path.startsWith(`${routes.operations}?operationId=`)) return ops.shift() ?? { status: 404 };
    if (path === routes.restart) return { status: 202, body: {} };
    return { status: 404 };
  };
  return { posted, handle };
}

/**
 * 经卡片的 apply 驱动共享更新器：manager 缺省是带官方更新接口的新宿主；market 缺省不存在（capabilities 答 404），
 * 可用 useMarket 换上。version 是 version 路由的答复，测试可以改它模拟 npm 上出了新版。
 */
function updaterHarness({ manager, result, versions, bundle, crypto, version: payload, market: initialMarket, sessionStorage, initial } = {}) {
  const calls = [];
  const events = new Map();
  const versionPayload = payload ?? { ok: true, currentVersion: '26.10.22', latestVersion: '26.10.23', updateAvailable: true };
  let currentMarket = initialMarket;
  const fetcher = async (path, options = {}) => {
    calls.push(['fetch', path, options.method ?? 'GET']);
    if (path.startsWith(VERSION_ROUTE)) {
      assert.match(path, /^\/plugins\/dsh-magpie\/version(?:\?force=1)?$/);
      return { ok: true, status: 200, json: async () => versionPayload };
    }
    const answer = currentMarket ? currentMarket.handle(path, options) : { status: 404 };
    return {
      ok: answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError('Unexpected token < in JSON');
        return answer.body;
      },
    };
  };
  const remote = {
    $on: (event, listener) => { events.set(event, listener); return () => events.delete(event); },
    pluginManager: manager ?? {
      listBundles: async () => ({ ok: true, value: [bundle ?? { name: PACKAGE_NAME, version: '26.10.22', source: `${PACKAGE_NAME}@26.10.22`, availability: 'profile', updatable: true }] }),
      listVersions: async (name, options) => {
        calls.push(['listVersions', name, options]);
        return { ok: true, value: versions ?? { status: 'listed', installed: '26.10.22', registry: 'https://registry.example/', versions: [
          { version: '26.10.23', bundle: true, prerelease: false, tags: ['latest'] },
        ] } };
      },
      updateBundle: async (...args) => {
        calls.push(['updateBundle', ...args]);
        return typeof result === 'function' ? result(...args) : { ok: true, value: result ?? {
          from: '26.10.22', to: '26.10.23', step: 'install',
          result: { changed: true, application: 'restart-required', version: '26.10.23' },
        } };
      },
    },
  };
  const client = clientHarness(initial, fetcher, { remote, crypto, sessionStorage });
  return { client, updater: client.pluginUpdater, remote, calls, events, versionPayload, useMarket: (next) => { currentMarket = next; } };
}

const fetched = (calls) => calls.filter((call) => call[0] === 'fetch').map((call) => call[1]);

test('设置页两处卡片与侧栏页面共用 apply 建的同一个更新器', async () => {
  const client = clientHarness(undefined, async () => ({ ok: true, status: 200, json: async () => initialView() }), { sidebar: true });
  await flush();
  const shared = client.cards.filter((card) => card.meta.inject).map((card) => card.meta.inject().pluginUpdater);
  assert.deepEqual(client.cards.filter((card) => card.meta.inject).map((card) => card.meta.name), ['plugins.bundle.config', 'plugins.row.config', 'main']);
  assert.ok(shared.every((value) => value === client.pluginUpdater));
  assert.deepEqual(client.registration.factory((id) => (id === 'react' ? { createElement() {}, useState() {} } : undefined)).inject, ['slots', 'locale', 'remote']);
});

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
    assert.equal(snapshot.version.latestVersion, '26.10.23');
    await h.updater.startUpdate();
    assert.deepEqual(fetched(h.calls), [VERSION_ROUTE, '/dsh-market/api/v1/capabilities']);
    assert.equal(h.calls.some((call) => call[0] !== 'fetch'), false);
    await h.updater.check(true);
    assert.ok(fetched(h.calls).includes(`${VERSION_ROUTE}?force=1`));
  }
});

test('官方更新：明确版本和查询注册表传给宿主，重复点击只提交一次，进度按 requestId 隔离', async () => {
  let finish;
  const h = updaterHarness({ result: () => new Promise((resolve) => { finish = resolve; }) });
  await h.updater.check();
  const first = h.updater.startUpdate();
  assert.equal(h.updater.startUpdate(), first);
  await flush();
  const call = h.calls.find((c) => c[0] === 'updateBundle');
  assert.equal(call[1], PACKAGE_NAME);
  assert.equal(call[2], '26.10.23');
  assert.deepEqual(Object.keys(call[3]).sort(), ['registry', 'requestId']);
  assert.equal(call[3].registry, 'https://registry.example/');
  assert.match(call[3].requestId, /^[0-9a-f-]{36}$/);
  const emit = h.events.get('plugin-manager/update-state');
  emit({ requestId: 'other', step: 'restoring' });
  assert.equal(h.updater.getSnapshot().operation.step, 'checking');
  emit({ requestId: call[3].requestId, step: 'installing' });
  assert.equal(h.updater.getSnapshot().operation.step, 'installing');
  finish({ ok: true, value: { from: '26.10.22', to: '26.10.23', step: 'install', result: { application: 'restart-required', version: '26.10.23' } } });
  await first;
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
  assert.equal(h.updater.getSnapshot().operation.outcome.restartRequired, true);
  assert.equal(h.updater.getSnapshot().manager.candidate, undefined);
  assert.equal(h.events.has('plugin-manager/update-state'), false, '结束后退订进度事件');
  assert.equal(h.calls.filter((c) => c[0] === 'updateBundle').length, 1);
  assert.equal(h.calls.some((c) => c[1]?.startsWith?.('/dsh-market/')), false, '有官方接口时不探测市场');
});

test('官方更新：非安全 HTTP 页面没有 randomUUID 时仍能提交合法请求 ID', async () => {
  const h = updaterHarness({ crypto: { getRandomValues: (value) => webcrypto.getRandomValues(value) } });
  await h.updater.check();
  await h.updater.startUpdate();
  const call = h.calls.find((c) => c[0] === 'updateBundle');
  assert.match(call[3].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
});

test('官方更新：本地、托管及不可更新安装不查询可用版本，也不提交更新', async () => {
  for (const extra of [{ source: 'file:D:/source', updatable: false }, { official: true, availability: 'installation', updatable: false }, { updatable: false }]) {
    const h = updaterHarness({ bundle: { name: PACKAGE_NAME, version: '26.10.22', ...extra } });
    await h.updater.check();
    assert.equal(h.updater.getSnapshot().manager.phase, 'blocked');
    await h.updater.startUpdate();
    assert.deepEqual(h.calls.map((c) => c[0]), ['fetch']);
  }
});

test('官方更新：跳过不兼容、弃用、预发布、非 bundle 与非明确版本，采用宿主兼容正式版', async () => {
  const versions = { status: 'listed', installed: '26.10.22', registry: null, versions: [
    { version: '27.1.1', bundle: true, prerelease: false, incompatible: {} },
    { version: '26.11.2', bundle: true, prerelease: false, deprecated: 'retired' },
    { version: '26.11.1-rc.1', bundle: true, prerelease: true },
    { version: '26.10.31', bundle: false, prerelease: false },
    { version: 'latest', bundle: true, prerelease: false },
    { version: '26.10.23', bundle: true, prerelease: false },
  ] };
  const h = updaterHarness({ versions });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().manager.candidate, '26.10.23');
  versions.versions.pop();
  await h.updater.check(true);
  assert.equal(h.updater.getSnapshot().manager.candidate, undefined);
  await h.updater.startUpdate();
  assert.equal(h.calls.some((c) => c[0] === 'updateBundle'), false);
});

test('官方更新：版本列表按已装版本缓存；npm 已是最新时不列，「检查更新」照样去列', async () => {
  const listed = (h) => h.calls.filter((call) => call[0] === 'listVersions').length;
  const h = updaterHarness();
  await h.updater.check();
  await h.updater.check();
  assert.equal(listed(h), 1, '重新挂载复用缓存，不在宿主上再跑一串 pnpm view');
  await h.updater.check(true);
  assert.equal(listed(h), 2);

  const quiet = updaterHarness({ version: { ...UP_TO_DATE, currentVersion: '26.10.22', latestVersion: '26.10.22' } });
  await quiet.updater.check();
  assert.equal(listed(quiet), 0);
  assert.equal(quiet.updater.getSnapshot().manager.phase, 'ready');
  assert.equal(quiet.updater.getSnapshot().manager.candidate, undefined);
  await quiet.updater.check(true);
  assert.equal(listed(quiet), 1);
  assert.equal(quiet.updater.getSnapshot().manager.candidate, '26.10.23', 'npm 落后于宿主注册表时，手动检查仍能找到新版本');
  await quiet.updater.check();
  assert.equal(listed(quiet), 1);
  assert.equal(quiet.updater.getSnapshot().manager.candidate, '26.10.23', '缓存期内重新挂载不丢掉刚查到的版本');
});

test('官方更新：查询失败与不支持分开显示，恢复连接后可以重新检查', async () => {
  const versions = { status: 'refused', problem: 'network', reason: 'offline' };
  const h = updaterHarness({ versions });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().manager.phase, 'error');
  assert.equal(h.updater.getSnapshot().manager.reason, 'offline');
  assert.match(text(render(h.updater.getSnapshot())), /官方插件管理器检查失败：offline/);
  await h.updater.startUpdate();
  assert.equal(h.calls.some((c) => c[0] === 'updateBundle'), false);
  Object.assign(versions, { status: 'listed', installed: '26.10.22', versions: [], registry: null });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().manager.phase, 'ready');

  const refused = updaterHarness({ versions: { status: 'refused', problem: 'not-updatable', reason: 'linked' } });
  await refused.updater.check();
  assert.equal(refused.updater.getSnapshot().manager.phase, 'blocked');
});

test('官方更新：失败、取消、回滚成功、回滚失败、版本不符与连接中断不会误报成功', async () => {
  const failed = { application: 'failed', error: { diagnostic: 'install failed' } };
  const cases = [
    [{ from: '26.10.22', step: 'install', result: failed }, 'failed'],
    [{ from: '26.10.22', step: 'install', result: { application: 'cancelled' } }, 'cancelled'],
    [{ from: '26.10.22', step: 'install', result: failed, restore: { application: 'applied', version: '26.10.22' } }, 'rolled-back'],
    [{ from: '26.10.22', step: 'install', result: failed, restore: failed }, 'failed'],
    [{ from: '26.10.22', step: 'install', result: { application: 'applied', version: '26.10.21' } }, 'failed'],
    [{ from: '26.10.22', step: 'remove', result: { application: 'applied', version: '26.10.23' } }, 'failed'],
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
  const bundle = { name: PACKAGE_NAME, version: '26.10.22', updatable: true };
  const versions = { status: 'listed', installed: '26.10.22', registry: null, versions: [{ version: '26.10.23', bundle: true, prerelease: false }] };
  const h = updaterHarness({ bundle, versions });
  await h.updater.check();
  await h.updater.startUpdate();
  bundle.version = versions.installed = '26.10.23';
  versions.versions = [];
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
  bundle.version = versions.installed = '26.10.22';
  versions.versions = [{ version: '26.10.23', bundle: true, prerelease: false }];
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().operation, undefined);
  assert.equal(h.updater.getSnapshot().manager.candidate, '26.10.23');
});

test('官方更新：插件管理器广播变更时静默重读；宿主不认识该事件也不影响卡片注册', async () => {
  const h = updaterHarness();
  await h.updater.check();
  const listed = h.calls.length;
  h.events.get('plugin-manager/changed')();
  assert.equal(h.updater.getSnapshot().version.phase, 'ready', '静默重读不把区块切成"正在检查"');
  assert.equal(h.updater.getSnapshot().manager.phase, 'ready');
  await flush();
  assert.ok(h.calls.length > listed, '广播后重新读了安装状态');
  assert.equal(h.updater.getSnapshot().manager.candidate, '26.10.23');

  const original = console.warn;
  console.warn = () => {};
  try {
    const client = clientHarness(undefined, undefined, { remote: { $on: (event) => {
      if (event === 'plugin-manager/changed') throw new Error('unknown event');
      return () => {};
    } } });
    assert.equal(client.cards.length, 2);
  } finally {
    console.warn = original;
  }
});

test('市场兜底：按能力发现的路由探测安装来源，提交纯包名，按任务轮询到完成', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = memoryStorage();
  const endpoints = { updates: '/custom/updates', operations: '/custom/operations' };
  const market = fakeMarket({ endpoints, ops: [
    { status: 200, body: { operation: { state: 'running', progress: { percent: 40, detail: 'resolved 3' } } } },
    { status: 200, body: { operation: { state: 'succeeded', beforeVersion: '26.10.22', installedVersion: '26.10.23', outcome: { restartRequired: true } } } },
  ] });
  const h = updaterHarness({ manager: legacyManager().manager, market, sessionStorage: storage });
  await h.updater.check();
  const { phase, source, updatable } = h.updater.getSnapshot().market;
  assert.deepEqual({ phase, source, updatable }, { phase: 'ready', source: 'npm', updatable: true });
  assert.ok(fetched(h.calls).includes(`/custom/updates?name=${encodeURIComponent(PACKAGE_NAME)}`));

  await h.updater.startUpdate();
  // 市场的公开 v1 API 只接受纯包名，不能拼 @版本
  assert.deepEqual(market.posted, [{ packageName: PACKAGE_NAME }]);
  assert.equal(h.updater.getSnapshot().operation.channel, 'market');
  assert.equal(h.updater.getSnapshot().target, '26.10.23');
  assert.deepEqual(JSON.parse(storage.getItem(OPERATION_KEY)), { operationId: 'b-1', target: '26.10.23' });

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updater.getSnapshot().operation.progress.percent, 40);
  assert.equal(h.updater.getSnapshot().operation.operationId, 'b-1');
  assert.match(text(render(h.updater.getSnapshot())), /40%.*resolved 3/);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updater.getSnapshot().operation.state, 'succeeded');
  assert.equal(storage.getItem(OPERATION_KEY), null);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(fetched(h.calls).filter((path) => path.startsWith('/custom/operations?')).length, 2, '任务结束后不再轮询');
});

test('市场兜底：卡片点更新只提交本包名，不改模型配置', async () => {
  const market = fakeMarket();
  const h = updaterHarness({ manager: {}, market, initial: initialView() });
  await h.updater.check();
  h.client.render();
  h.client.states[UPDATE_STATE] = h.updater.getSnapshot();
  const before = structuredClone(h.client.states[0].config);
  await button(section(h.client), '更新到 v26.10.23').props.onClick();
  assert.deepEqual(market.posted, [{ packageName: PACKAGE_NAME }]);
  assert.deepEqual(h.client.states[0].config, before);
  h.updater.dispose();
});

test('市场兜底：热重载后按 bootId 接着轮询，查不到任务时提示已结束；DSH 重启过的旧记录丢弃；卸载后停止轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stored = (operationId) => memoryStorage({ [OPERATION_KEY]: JSON.stringify({ operationId, target: '26.10.23' }) });

  const storage = stored('b-7');
  const h = updaterHarness({ manager: {}, market: fakeMarket(), sessionStorage: storage });
  await h.updater.check();
  assert.deepEqual(h.updater.getSnapshot().operation, { channel: 'market', operationId: 'b-7', state: 'running' });
  assert.equal(h.updater.getSnapshot().target, '26.10.23');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updater.getSnapshot().operation.state, 'lost');
  assert.equal(storage.getItem(OPERATION_KEY), null);
  assert.match(text(render(h.updater.getSnapshot())), /上次更新任务已结束/);

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
    const fake = fakeMarket({ source });
    const h = updaterHarness({ manager: {}, market: fake });
    await h.updater.check();
    assert.equal(h.updater.getSnapshot().market.updatable, false);
    await h.updater.startUpdate();
    assert.deepEqual(fake.posted, []);
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

  const busy = fakeMarket({ submit: { status: 409, body: { failure: { message: 'profile busy' } } } });
  const hb = updaterHarness({ manager: {}, market: busy });
  await hb.updater.check();
  await hb.updater.startUpdate();
  assert.equal(hb.updater.getSnapshot().startFailure, 'profile busy');
  assert.equal(hb.updater.getSnapshot().busy, false);
  assert.match(text(render(hb.updater.getSnapshot())), /没能开始更新：profile busy/);
  await hb.updater.check(true);
  assert.equal(hb.updater.getSnapshot().startFailure, undefined);

  const hw = updaterHarness({ manager: {}, market: fakeMarket({ restartSupported: true }) });
  await hw.updater.check();
  assert.equal(hw.updater.getSnapshot().market.restartSupported, true);
  await hw.updater.restart();
  assert.deepEqual(hw.updater.getSnapshot().restart, { phase: 'done' });
  assert.ok(hw.calls.some((call) => call[1] === '/dsh-market/api/v1/restart' && call[2] === 'POST'));
});

test('检查更新强制刷新版本路由并重新探测市场；版本检查失败时保留当前运行版本', async () => {
  const h = updaterHarness({ manager: {}, version: { ok: false, currentVersion: '26.10.22', reason: 'registry offline' } });
  await h.updater.check();
  assert.equal(h.updater.getSnapshot().market.phase, 'absent');
  h.useMarket(fakeMarket({ source: 'linked', endpoints: { updates: '/custom/updates' } }));
  h.calls.length = 0;
  await h.updater.check(true);
  assert.deepEqual(fetched(h.calls), [`${VERSION_ROUTE}?force=1`, '/dsh-market/api/v1/capabilities', `/custom/updates?name=${encodeURIComponent(PACKAGE_NAME)}`]);
  assert.equal(h.updater.getSnapshot().market.updatable, false);
  const tree = render(h.updater.getSnapshot());
  assert.match(text(tree), /当前运行版本：\|v26\.10\.22/);
  assert.match(text(tree), /registry offline/);
  assert.equal(button(tree, '检查更新').props.disabled, false);
});

test('市场兜底：成功后重新检查发现更高版本，恢复徽章和可用的更新按钮，保留上次结果', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bundle, manager } = legacyManager();
  const fake = fakeMarket({ ops: [
    { status: 200, body: { operation: { state: 'succeeded', installedVersion: '26.10.23', outcome: { restartRequired: true } } } },
  ] });
  const h = updaterHarness({ manager, market: fake });
  await h.updater.check();
  await h.updater.startUpdate();
  t.mock.timers.tick(1000);
  await flush();
  bundle.version = '26.10.23';
  assert.match(text(render(h.updater.getSnapshot())), /等待重启/);
  assert.equal(hasUpdateButton(render(h.updater.getSnapshot())), false, '更新成功后再点只会重装同一版');

  h.versionPayload.latestVersion = '26.10.24';
  await h.updater.check(true);
  const tree = render(h.updater.getSnapshot());
  assert.match(text(tree), /有新版本/);
  assert.doesNotMatch(text(tree), /等待重启|等待刷新|已是最新/);
  assert.equal(button(tree, '更新到 v26.10.24')?.props.disabled, undefined);
  assert.match(text(tree), /已更新到 v26\.10\.23/, '保留上次更新结果，不靠清空任务恢复入口');
});

test('插件更新 UI：官方接口只给宿主确认的兼容正式版；本地、托管、不可更新与无兼容版本时说明原因', () => {
  const current = render({ manager: official, market: { phase: 'idle' } });
  assert.ok(button(current, '更新到 v26.10.23'));
  assert.match(text(current), /当前运行版本：\|v26\.10\.22.*npm 最新版本：\|v26\.10\.23/);
  // npm latest 滞后时不隐藏宿主列出的新版本
  assert.ok(button(render({ manager: { ...official, candidate: '26.10.24' }, market: { phase: 'idle' } }), '更新到 v26.10.24'));
  for (const [manager, hint] of [
    [{ phase: 'blocked', local: true }, /本地目录（file:）/],
    [{ phase: 'blocked', managed: true }, /由 DSH 统一管理/],
    [{ phase: 'blocked' }, /不支持更新此安装/],
    [{ phase: 'ready', candidate: undefined }, /暂未提供可更新的兼容正式版/],
  ]) {
    const tree = render({ manager, market: { phase: 'idle' } });
    assert.equal(hasUpdateButton(tree), false);
    assert.match(text(tree), hint);
  }
  // 已是最新时不说明为什么没有一键更新
  const latest = render({ version: { ...version, latestVersion: '26.10.22', updateAvailable: false }, manager: { phase: 'blocked', local: true }, market: { phase: 'idle' } });
  assert.match(text(latest), /已是最新/);
  assert.doesNotMatch(text(latest), /本地目录|官方插件管理器/);
});

test('插件更新 UI：官方更新显示宿主阶段、重启提示与恢复失败；不给强制更新和重启按钮', () => {
  const running = render({ manager: official, market: { phase: 'idle' }, busy: true, operation: { channel: 'official', state: 'running', step: 'installing' } });
  assert.match(text(running), /正在安装新版本/);
  assert.equal(button(running, '检查更新').props.disabled, true);
  // 官方路径不探测 dshmarket，市场停在 idle，也就没有市场的重启入口
  const done = render({ manager: { ...official, installedVersion: '26.10.23', candidate: undefined }, market: { phase: 'idle' },
    operation: { channel: 'official', state: 'succeeded', installedVersion: '26.10.23', outcome: { restartRequired: true } } });
  assert.match(text(done), /等待重启.*已更新到 v26\.10\.23。 重启 DSH 后生效。/);
  assert.equal(button(done, '立即重启 DSH'), undefined);
  const restoreFailed = render({ manager: official, market: { phase: 'idle' },
    operation: { channel: 'official', state: 'failed', failure: { message: 'install failed' }, restoreFailure: 'restore failed' } });
  assert.match(text(restoreFailed), /更新失败：install failed.*恢复旧版本失败：restore failed/);
  assert.equal(button(restoreFailed, '强制更新'), undefined);
  assert.match(text(render({ manager: official, market: { phase: 'idle' }, operation: { channel: 'official', state: 'failed', failure: { message: 'reset' }, unknown: true } })), /未能确认更新结果/);
  assert.match(text(render({ manager: official, market: { phase: 'idle' },
    operation: { channel: 'official', state: 'rolled-back', installedVersion: '26.10.22', failure: { message: 'install failed' }, outcome: { restartRequired: true } } })),
  /更新失败：install failed 更新已回滚，插件保持在 v26\.10\.22。 重启 DSH 后生效。/);
});

test('市场兜底 UI：显示两个版本；缺少市场、本地安装或桌面托管时不提供更新按钮，只说明原因', () => {
  assert.match(text(render()), /当前运行版本：\|v26\.10\.22.*npm 最新版本：\|v26\.10\.23/);
  assert.equal(button(render(), '更新到 v26.10.23').props.disabled, undefined);
  for (const [overrides, hint] of [
    [{ market: { phase: 'absent' } }, /还没有官方插件更新接口.*dshmarket/],
    [{ market: { ...market, source: 'linked', updatable: false } }, /本地目录（file:）/],
    [{ market: { ...market, source: 'generation', updatable: false } }, /由 DSH 统一管理/],
    [{ manager: { ...legacy, local: true } }, /本地目录（file:）/],
    [{ manager: { ...legacy, managed: true } }, /由 DSH 统一管理/],
  ]) {
    const tree = render(overrides);
    assert.equal(hasUpdateButton(tree), false);
    assert.match(text(tree), hint);
    assert.ok(button(tree, '检查更新'));
  }
});

test('模型草稿及 Magpie 程序操作阻止自身更新，进行中的插件更新阻止编辑及保存', () => {
  for (const manager of [legacy, official]) {
    const client = setup({ manager });
    client.tab('模型');
    field(client.render(), '显示名称').props.onChange({ target: { value: '待保存' } });
    assert.equal(button(section(client), '更新到 v26.10.23').props.disabled, true);
    assert.match(text(section(client)), /请先保存或放弃模型更改/);
    client.states[1] = false;
    client.states[0].backend = { operation: { running: true, phase: 'downloading' } };
    assert.equal(button(section(client), '更新到 v26.10.23').props.disabled, true);
    client.states[0].backend = undefined;
  }
  const client = setup({ operation: { channel: 'market', operationId: 'boot-1', state: 'running', progress: { percent: 42, detail: 'resolved 3' } } });
  client.tab('模型');
  assert.equal(field(client.render(), '显示名称').props.disabled, true);
  assert.equal(button(client.render(), '处理中…').props.disabled, true);
  assert.match(text(section(client)), /42%.*resolved 3/);
});

test('失败原因可见；仅冷却期或版本未变允许显式 force 重试', () => {
  const forced = [];
  const tooFresh = render({ operation: { channel: 'market', state: 'failed', failure: { code: 'RELEASE_TOO_FRESH' } } }, { ...actions, startUpdate: (force) => forced.push(force) });
  assert.match(text(tooFresh), /发布冷却期/);
  button(tooFresh, '强制更新').props.onClick();
  assert.deepEqual(forced, [true]);
  const other = render({ operation: { channel: 'market', state: 'failed', failure: { code: 'UPDATE_FAILED', message: 'registry unavailable' } } });
  assert.match(text(other), /registry unavailable/);
  assert.equal(button(other, '强制更新'), undefined);
});

test('成功后核对目标和更新前版本，提示重启或刷新；桌面不出现重启按钮', () => {
  for (const [outcome, hint] of [[{ restartRequired: true }, /等待重启/], [{ refreshRequired: true }, /等待刷新/], [{}, /已是最新/]]) {
    const tree = render({ target: '26.10.23', operation: { state: 'succeeded', installedVersion: '26.10.23', outcome } });
    assert.match(text(tree), hint);
    assert.equal(hasUpdateButton(tree), false);
    assert.equal(button(tree, '立即重启 DSH'), undefined);
  }
  const bad = render({ target: '26.10.23', market: { ...market, restartSupported: true }, operation: {
    state: 'succeeded', beforeVersion: '26.10.25', installedVersion: '26.10.24', outcome: { restartRequired: true },
  } });
  assert.match(text(bad), /实际安装版本 v26\.10\.24 低于预期的 v26\.10\.25/);
  assert.equal(button(bad, '立即重启 DSH').props.disabled, true);
  assert.ok(button(bad, '更新到 v26.10.23'));
  assert.match(text(render({ operation: { state: 'rolled-back', installedVersion: '26.10.22' } })), /更新已回滚/);
  assert.match(text(render({ operation: { state: 'cancelled' } })), /更新已取消/);
  assert.match(text(render({ restart: { phase: 'error', reason: 'HTTP 500' } })), /未能确认重启：HTTP 500/);
});
