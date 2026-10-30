import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { clientHarness, button, field, nodes } from '../fixtures/client.mjs';
import { resolveConfig, PACKAGE_NAME } from '../lib/config.js';

const VERSION_ROUTE = '/plugins/dsh-magpie/version';
// 卡片里 useUpdater 的状态位：排在模型草稿等 8 个状态与拖动 ref 之后。
const UPDATE_STATE = 9;
const version = { phase: 'ready', ok: true, currentVersion: '26.10.22', latestVersion: '26.10.23', updateAvailable: true };
const UP_TO_DATE = { ok: true, currentVersion: '26.10.23', latestVersion: '26.10.23', updateAvailable: false };
// 旧宿主缺少官方接口时，只保留版本检查与手动重装指引。
const legacy = { phase: 'unsupported', local: false, managed: false, installedVersion: '26.10.22' };
// 宿主有官方更新接口、列出了兼容新版本时的基准状态。
const official = { phase: 'ready', candidate: '26.10.23', registry: 'https://registry.npmjs.org/', installedVersion: '26.10.22' };
const initialView = () => ({ ok: true, config: resolveConfig({ models: [{ id: 'qoder-cn/dfmodel', name: 'DeepSeek-Flash' }] }), editable: true, nativeProviders: [] });
const noop = () => {};
const actions = { checkUpdate: noop, startUpdate: noop };
const text = (tree) => Array.isArray(tree) ? tree.map(text).join('|') : typeof tree === 'string' ? tree : tree?.children ? text(tree.children) : '';
const hasUpdateButton = (tree) => nodes(tree, (n) => n.type === 'button' && String(n.children[0]).startsWith('更新到')).length > 0;
/** 让挂起的 promise 链跑完（setImmediate 不在 mock.timers 的接管范围内）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function render(overrides = {}, callbacks = actions) {
  const client = clientHarness();
  const t = (key, values) => client.module.zh[key].replace(/\{(\w+)\}/g, (m, k) => values?.[k] ?? m);
  return client.module.renderUpdateSection({ version, manager: official, busy: false, ...overrides }, callbacks, t);
}

/** 渲染整张卡片并把更新器状态位换成给定快照；插件更新在「更新」标签页。 */
function setup(overrides = {}) {
  const client = clientHarness(initialView());
  client.render();
  client.states[UPDATE_STATE] = { version, manager: official, busy: false, ...overrides };
  return client;
}
const section = (client) => { client.tab('更新'); return nodes(client.render(), (n) => n.props.className === 'plugin-update')[0]; };

/** rc.3 的插件管理器：listBundles 带安装来源，没有 listVersions / updateBundle。 */
function legacyManager(extra = {}) {
  const bundle = { name: PACKAGE_NAME, version: '26.10.22', source: `${PACKAGE_NAME}@26.10.22`, availability: 'profile', official: false, ...extra };
  return { bundle, manager: { listBundles: async () => ({ ok: true, value: [bundle] }) } };
}

function updaterHarness({ manager, result, versions, bundle, crypto, version: payload, sessionStorage, initial } = {}) {
  const calls = [];
  const events = new Map();
  const versionPayload = payload ?? { ok: true, currentVersion: '26.10.22', latestVersion: '26.10.23', updateAvailable: true };
  const fetcher = async (path, options = {}) => {
    calls.push(['fetch', path, options.method ?? 'GET']);
    if (path.startsWith(VERSION_ROUTE)) {
      assert.match(path, /^\/plugins\/dsh-magpie\/version(?:\?force=1)?$/);
      return { ok: true, status: 200, json: async () => versionPayload };
    }
    throw new Error('Unexpected fetch: ' + path);
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
  return { client, updater: client.pluginUpdater, remote, calls, events, versionPayload };
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

test('旧宿主：缺少官方接口时不探测市场、不恢复旧市场任务，也不提交更新', async () => {
  for (const variant of ['none', 'legacy', 'throws']) {
    let storageReads = 0;
    const h = updaterHarness({ manager: variant === 'legacy' ? legacyManager().manager : {},
      sessionStorage: { getItem() { storageReads++; return JSON.stringify({ operationId: 'old-1', target: '26.10.23' }); } } });
    if (variant === 'throws') Object.defineProperty(h.remote, 'pluginManager', { get: () => { throw new Error('cannot get property without inject'); } });
    await h.updater.check();
    const snapshot = h.updater.getSnapshot();
    assert.equal(snapshot.manager.phase, 'unsupported');
    assert.equal('market' in snapshot, false);
    assert.equal(snapshot.version.latestVersion, '26.10.23');
    await h.updater.startUpdate();
    await h.updater.startUpdate(true);
    assert.deepEqual(fetched(h.calls), [VERSION_ROUTE]);
    assert.equal(h.calls.some((call) => call[0] !== 'fetch'), false);
    assert.equal('restart' in h.updater, false);
    assert.equal(storageReads, 0);
    const tree = render(snapshot);
    assert.match(text(tree), /请升级 DSH.*指定版本/);
    assert.match(text(tree), /@zhiqiangme\/dsh-magpie@26\.10\.23/);
    assert.equal(hasUpdateButton(tree), false);
    await h.updater.check(true);
    assert.deepEqual(fetched(h.calls), [VERSION_ROUTE, VERSION_ROUTE + '?force=1']);
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
  for (const extra of [{ source: 'file:D:/source', updatable: false }, { source: 'link:D:/source', updatable: true },
    { official: true, availability: 'installation', updatable: true }, { updatable: false }]) {
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
    { version: '26.10.22', bundle: true, prerelease: false },
    { version: '26.10.21', bundle: true, prerelease: false },
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

test('插件更新 UI：官方接口只给宿主确认的兼容正式版；本地、托管、不可更新与无兼容版本时说明原因', () => {
  const current = render({ manager: official });
  assert.ok(button(current, '更新到 v26.10.23'));
  assert.match(text(current), /当前运行版本：\|v26\.10\.22.*npm 最新版本：\|v26\.10\.23/);
  // npm latest 滞后时不隐藏宿主列出的新版本
  assert.ok(button(render({ manager: { ...official, candidate: '26.10.24' } }), '更新到 v26.10.24'));
  for (const [manager, hint] of [
    [{ phase: 'blocked', local: true }, /本地目录（file:）/],
    [{ phase: 'blocked', managed: true }, /由 DSH 统一管理/],
    [{ phase: 'blocked' }, /不支持更新此安装/],
    [{ phase: 'ready', candidate: undefined }, /暂未提供可更新的兼容正式版/],
  ]) {
    const tree = render({ manager });
    assert.equal(hasUpdateButton(tree), false);
    assert.match(text(tree), hint);
  }
  // 已是最新时不说明为什么没有一键更新
  const latest = render({ version: { ...version, latestVersion: '26.10.22', updateAvailable: false }, manager: { phase: 'blocked', local: true } });
  assert.match(text(latest), /已是最新/);
  assert.doesNotMatch(text(latest), /本地目录|官方插件管理器/);
});

test('插件更新 UI：官方更新显示宿主阶段、重启提示与恢复失败；不给强制更新和重启按钮', () => {
  const running = render({ manager: official, busy: true, operation: { channel: 'official', state: 'running', step: 'installing' } });
  assert.match(text(running), /正在安装新版本/);
  assert.equal(button(running, '检查更新').props.disabled, true);
  // 官方更新仅提示重启，不提供市场的强制更新和重启入口。
  const done = render({ manager: { ...official, installedVersion: '26.10.23', candidate: undefined },
    operation: { channel: 'official', state: 'succeeded', installedVersion: '26.10.23', outcome: { restartRequired: true } } });
  assert.match(text(done), /等待重启.*已更新到 v26\.10\.23。 重启 DSH 后生效。/);
  assert.equal(button(done, '立即重启 DSH'), undefined);
  const restoreFailed = render({ manager: official,
    operation: { channel: 'official', state: 'failed', failure: { message: 'install failed' }, restoreFailure: 'restore failed' } });
  assert.match(text(restoreFailed), /更新失败：install failed.*恢复旧版本失败：restore failed/);
  assert.equal(button(restoreFailed, '强制更新'), undefined);
  assert.match(text(render({ manager: official, operation: { channel: 'official', state: 'failed', failure: { message: 'reset' }, unknown: true } })), /未能确认更新结果/);
  assert.match(text(render({ manager: official,
    operation: { channel: 'official', state: 'rolled-back', installedVersion: '26.10.22', failure: { message: 'install failed' }, outcome: { restartRequired: true } } })),
  /更新失败：install failed 更新已回滚，插件保持在 v26\.10\.22。 重启 DSH 后生效。/);
});

test('模型草稿及 Magpie 程序操作阻止自身更新，进行中的插件更新阻止编辑及保存', () => {
  for (const manager of [official]) {
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
  const client = setup({ operation: { channel: 'official', state: 'running', step: 'installing' } });
  client.tab('模型');
  assert.equal(field(client.render(), '显示名称').props.disabled, true);
  assert.equal(button(client.render(), '处理中…').props.disabled, true);
  assert.match(text(section(client)), /正在安装新版本/);
});

test('手动重装：仅旧宿主或查询失败时给精确版本，不绕过本地、托管及官方兼容性结论', () => {
  for (const manager of [legacy, { phase: 'error', reason: 'offline' }]) {
    const tree = render({ manager });
    assert.match(text(tree), /按指定版本安装.*@zhiqiangme\/dsh-magpie@26\.10\.23/);
  }
  for (const manager of [official, { phase: 'blocked' }, { phase: 'ready' }, { ...legacy, local: true }, { ...legacy, managed: true }]) {
    assert.equal(nodes(render({ manager }), (n) => n.type === 'details' && n.props.key === 'pinnedInstall').length, 0);
  }
  assert.equal(nodes(render({ manager: legacy, version: { ...version, latestVersion: 'latest' } }), (n) => n.props.key === 'pinnedInstall').length, 0);
});

test('官方更新：卸载后不接受异步结果，也不提交新更新', async () => {
  let finish;
  const h = updaterHarness({ result: () => new Promise((resolve) => { finish = resolve; }) });
  await h.updater.check();
  const pending = h.updater.startUpdate();
  await flush();
  const snapshot = h.updater.getSnapshot();
  h.updater.dispose();
  finish({ from: '26.10.22', step: 'install', result: { application: 'applied', version: '26.10.23' } });
  await pending;
  assert.equal(h.updater.getSnapshot(), snapshot);
  await h.updater.check(true);
  await h.updater.startUpdate();
  assert.equal(h.calls.filter((c) => c[0] === 'updateBundle').length, 1);
  assert.equal(h.events.has('plugin-manager/update-state'), false);
});
