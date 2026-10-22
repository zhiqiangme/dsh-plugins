import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientHarness, button, field, nodes } from '../fixtures/client.mjs';
import { resolveConfig, PACKAGE_NAME } from '../lib/config.js';

const version = { phase: 'ready', ok: true, currentVersion: '26.10.22', latestVersion: '26.10.23', updateAvailable: true };
const market = { phase: 'ready', restartSupported: false, endpoints: { updates: '/market/updates', operations: '/market/operations' } };
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const noop = () => {};
const actions = { checkUpdate: noop, startUpdate: noop, restart: noop };
function setup(overrides = {}, fetchImpl, options) {
  const initial = { ok: true, config: resolveConfig({ models: [{ id: 'qoder-cn/dfmodel', name: 'DeepSeek-Flash' }] }), editable: true, nativeProviders: [] };
  const client = clientHarness(initial, fetchImpl, options);
  client.render();
  const model = { version, market, ...overrides };
  client.states.splice(9, 7, model.version, model.market, model.operation, model.target, model.busy ?? false, model.notice, model.restart);
  return client;
}
const section = (client) => nodes(client.render(), (n) => n.props.className === 'plugin-update')[0];
const text = (tree) => Array.isArray(tree) ? tree.map(text).join('|') : typeof tree === 'string' ? tree : tree?.children ? text(tree.children) : '';
function render(overrides = {}, callbacks = actions) {
  const client = clientHarness();
  const t = (key, values) => client.module.zh[key].replace(/\{(\w+)\}/g, (m, k) => values?.[k] ?? m);
  return client.module.renderUpdateSection({ version, market, ...overrides }, callbacks, t);
}

test('自身更新独立显示版本；缺少市场、本地安装或桌面托管时不提供更新按钮', () => {
  assert.match(text(render()), /当前运行版本：\|v26\.10\.22.*npm 最新版本：\|v26\.10\.23/);
  assert.equal(button(render(), '更新到 v26.10.23').props.disabled, undefined);
  for (const [state, hint] of [
    [{ phase: 'absent' }, /dshmarket/],
    [{ ...market, source: 'linked', updatable: false }, /本地目录（file:）/],
    [{ ...market, source: 'generation', updatable: false }, /桌面端统一管理/],
  ]) {
    const tree = render({ market: state });
    assert.equal(button(tree, '更新到 v26.10.23'), undefined);
    assert.match(text(tree), hint);
    assert.ok(button(tree, '检查更新'));
  }
});

test('模型草稿及 Magpie 程序操作阻止自身更新，进行中的插件更新阻止编辑及保存', () => {
  const client = setup();
  field(client.render(), '显示名称').props.onChange({ target: { value: '待保存' } });
  assert.equal(button(section(client), '更新到 v26.10.23').props.disabled, true);
  assert.match(text(section(client)), /请先保存或放弃模型更改/);
  client.states[1] = false;
  client.states[0].backend = { operation: { running: true, phase: 'downloading' } };
  assert.equal(button(section(client), '更新到 v26.10.23').props.disabled, true);
  client.states[0].backend = undefined;
  client.states[11] = { operationId: 'boot-1', state: 'running', progress: { percent: 42, detail: 'resolved 3' } };
  assert.equal(field(client.render(), '显示名称').props.disabled, true);
  assert.equal(button(client.render(), '处理中…').props.disabled, true);
  assert.match(text(section(client)), /42%.*resolved 3/);
});

test('普通更新使用能力发现后的路由，仅发送本包名，并保存任务用于重挂恢复', async () => {
  const calls = [], storage = new Map();
  const client = setup({}, async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    return response({ operation: { operationId: 'boot-1', state: 'queued' } }, 202);
  }, { sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) ?? null } });
  const before = structuredClone(client.states[0].config);
  await button(section(client), '更新到 v26.10.23').props.onClick();
  assert.deepEqual(calls, [{ path: market.endpoints.updates, method: 'POST', body: { packageName: PACKAGE_NAME } }]);
  assert.deepEqual(client.states[0].config, before);
  assert.equal(client.states[11].operationId, 'boot-1');
  assert.deepEqual(JSON.parse(storage.get('dsh-magpie:update-operation')), { operationId: 'boot-1', target: '26.10.23' });
});

test('失败原因可见；仅冷却期或版本未变允许显式 force 重试，保留模型配置', async () => {
  let posted;
  const client = setup({ operation: { state: 'failed', failure: { code: 'RELEASE_TOO_FRESH' } } }, async (_path, options) => {
    posted = JSON.parse(options.body);
    return response({ failure: { message: 'profile busy' } }, 409);
  });
  assert.match(text(section(client)), /发布冷却期/);
  await button(section(client), '强制更新').props.onClick();
  assert.deepEqual(posted, { packageName: PACKAGE_NAME, force: true });
  assert.match(text(section(client)), /profile busy/);
  assert.equal(client.states[0].config.models[0].name, 'DeepSeek-Flash');
  const other = render({ operation: { state: 'failed', failure: { code: 'UPDATE_FAILED', message: 'registry unavailable' } } });
  assert.match(text(other), /registry unavailable/);
  assert.equal(button(other, '强制更新'), undefined);
});

test('成功后核对目标和更新前版本，提示重启或刷新；桌面不出现重启按钮', () => {
  for (const [outcome, hint] of [[{ restartRequired: true }, /等待重启/], [{ refreshRequired: true }, /等待刷新/], [{}, /已是最新/]]) {
    const tree = render({ target: '26.10.23', operation: { state: 'succeeded', installedVersion: '26.10.23', outcome } });
    assert.match(text(tree), hint);
    assert.equal(button(tree, '更新到 v26.10.23'), undefined);
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
});

test('强制检查使用独立版本接口并重新发现市场来源，失败时保留当前运行版本', async () => {
  const calls = [];
  const client = setup({ market: { phase: 'absent' } }, async (path) => {
    calls.push(path);
    if (path.startsWith('/plugins/dsh-magpie/version')) return response({ ok: false, currentVersion: '26.10.22', reason: 'registry offline' });
    if (path.endsWith('/capabilities')) return response({ schema: 'dsh-market/update-api/v1', features: { update: true }, endpoints: { updates: '/custom/updates' } });
    return response({ package: { source: 'linked' } });
  });
  await button(section(client), '检查更新').props.onClick();
  assert.deepEqual(calls, ['/plugins/dsh-magpie/version?force=1', '/dsh-market/api/v1/capabilities', `/custom/updates?name=${encodeURIComponent(PACKAGE_NAME)}`]);
  assert.equal(client.states[10].updatable, false);
  assert.match(text(section(client)), /当前运行版本：\|v26\.10\.22/);
  assert.match(text(section(client)), /registry offline/);
  assert.equal(button(section(client), '检查更新').props.disabled, false);
});
