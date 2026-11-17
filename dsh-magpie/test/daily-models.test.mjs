import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DailyModels, registerDailyModels } from '../lib/daily-models.js';
import { ModelManager } from '../lib/runtime.js';
import { PROVIDER_ID, resolveConfig } from '../lib/config.js';
import { backendFixture } from '../fixtures/backend.mjs';
import { fakeHost } from '../fixtures/host.mjs';

function setup(t, config = {}) {
  const f = backendFixture(t), host = fakeHost({ autoRoute: false, models: [{ id: 'a/old', name: '保留名称' }], ...config });
  const agent = { status: 'idle' }, posts = [], reads = [];
  host.services.agents = { list: () => [agent] };
  const data = { providers: [{ id: 'a', off: false }, { id: 'b', off: false }, { id: 'off', off: true }, { id: 'no-list', listOff: true }],
    models: [{ id: 'a/old', name: '上游新名称', context_window: 1_000_000 }, { id: 'b/new', name: 'New' }] };
  const api = async (path, body) => {
    if (path === 'providers') return { providers: data.providers };
    posts.push(body);
    return { count: 2 };
  };
  f.backend.web.modelAPI = async () => api;
  const manager = new ModelManager(host.ctx, host.own.options.config, { backend: f.backend, env: {}, fetchImpl: async (url) => {
    reads.push(url);
    return Response.json(url.endsWith('/api/hello') ? { name: 'magpie' } : { data: data.models });
  } });
  const clock = { now: Date.parse('2026-11-17T03:59:59+08:00') };
  const worker = new DailyModels(manager, { now: () => clock.now });
  t.after(() => { manager.router.stop(); });
  return { ...f, ...host, manager, agent, data, worker, clock, posts, reads, api };
}

test('每日开关默认开启，严格校验，关闭或非本机地址时不访问 Magpie', async (t) => {
  assert.equal(resolveConfig().dailyModels, true);
  assert.throws(() => resolveConfig({ dailyModels: 'yes' }), /布尔值/);
  for (const [config, phase] of [[{ dailyModels: false }, 'disabled'], [{ enabled: false }, 'disabled'], [{ baseURL: 'https://example.com' }, 'local-only']]) {
    const f = setup(t, config);
    f.backend.web.modelAPI = () => { throw new Error('不应访问网页'); };
    assert.equal((await f.worker.run()).phase, phase);
    assert.equal(f.edits.length, 0);
  }
});

test('仅刷新开启且允许获取列表的渠道，同步保留勾选、名称、手工模型和顺序，新模型不勾选', async (t) => {
  const f = setup(t, { models: [{ id: 'b/new', name: '用户改名', enabled: false }, { id: 'manual/unlisted', name: '手工' }, { id: 'a/old', name: '保留名称', contextWindow: 1_000_000, maxTokens: 128_000 }] });
  assert.equal((await f.worker.run()).phase, 'completed');
  assert.deepEqual(f.posts, [{ id: 'a' }, { id: 'b' }]);
  const models = f.manager.current().models;
  assert.deepEqual(models.map((m) => [m.id, m.name, m.enabled]), [['b/new', '用户改名', false], ['manual/unlisted', '手工', true], ['a/old', '保留名称', true]]);
  assert.equal(models[2].contextWindow, 1_000_000);
  assert.deepEqual(f.llm.options.config.providers[PROVIDER_ID].models.map((m) => m.id), ['manual/unlisted', 'a/old']);
  f.data.models.push({ id: 'b/newest', name: 'Newest' });
  f.data.models[0].context_window = 100_000;
  f.clock.now += 24 * 3600_000;
  await f.worker.run();
  assert.equal(f.manager.current().models.at(-1).id, 'b/newest');
  assert.equal(f.manager.current().models.at(-1).enabled, false);
  assert.equal(f.manager.current().models[2].contextWindow, 100_000);
  assert.equal(f.manager.current().models[2].maxTokens, undefined, '目录缩小上下文时不保留已不合法的旧输出上限');
});

test('成功后当天及重建实例都不重复；北京时间 04:00 开始新一天，与电脑时区无关', async (t) => {
  const f = setup(t);
  await f.worker.run(); await f.worker.run();
  assert.equal(f.posts.length, 2);
  const restored = new DailyModels(f.manager, { now: () => f.clock.now });
  assert.equal((await restored.run()).day, '2026-11-16');
  assert.equal(f.posts.length, 2);
  f.clock.now += 1_000;
  assert.equal((await restored.run()).day, '2026-11-17');
  assert.equal(f.posts.length, 4);
  const cache = JSON.parse(readFileSync(restored.file, 'utf8'));
  assert.deepEqual(cache.done, ['a', 'b']);
  assert.equal(cache.day, '2026-11-17');
  assert.doesNotMatch(JSON.stringify(cache), /secret|cookie|key|保留名称/);
});

test('渠道部分失败继续刷新其它渠道；重试只刷新失败项，DSH 同步失败也不会重复刷新成功项', async (t) => {
  const f = setup(t);
  let fail = true;
  f.backend.web.modelAPI = async () => async (path, body) => {
    const result = await f.api(path, body);
    if (body?.id === 'b' && fail) throw new Error('sensitive upstream error');
    return result;
  };
  assert.equal((await f.worker.run()).phase, 'retrying');
  assert.deepEqual(f.worker.status().failed, ['b']);
  fail = false;
  const sync = f.manager.sync.bind(f.manager);
  f.manager.sync = async () => ({ ok: false });
  assert.equal((await f.worker.run()).phase, 'failed');
  assert.deepEqual(f.posts, [{ id: 'a' }, { id: 'b' }, { id: 'b' }]);
  f.manager.sync = sync;
  assert.equal((await f.worker.run()).phase, 'completed');
  assert.equal(f.posts.length, 3);
  assert.doesNotMatch(JSON.stringify(f.worker.status()), /sensitive/);
});

test('对话运行或状态未知时等待；刷新期间开始对话时不继续刷新或改写配置', async (t) => {
  const f = setup(t);
  f.agent.status = 'running';
  assert.equal((await f.worker.run()).phase, 'waiting-idle');
  delete f.services.agents;
  assert.equal((await f.worker.run()).phase, 'waiting-status');
  assert.equal(f.posts.length, 0);
  f.services.agents = { list: () => [f.agent] }; f.agent.status = 'idle';
  f.backend.web.modelAPI = async () => async (path, body) => {
    const result = await f.api(path, body);
    if (body?.id === 'a') f.agent.status = 'running';
    return result;
  };
  assert.equal((await f.worker.run()).phase, 'waiting-idle');
  assert.deepEqual(f.posts, [{ id: 'a' }]);
  assert.deepEqual(f.edits, []);
  f.agent.status = 'idle'; f.backend.web.modelAPI = async () => f.api;
  assert.equal((await f.worker.run()).phase, 'completed');
  assert.deepEqual(f.posts, [{ id: 'a' }, { id: 'b' }]);
});

test('等目录接口时用户编辑配置，后台按锁内最新选择合并；空目录和非法目录不覆盖清单', async (t) => {
  const f = setup(t);
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const fetchImpl = f.manager.fetch;
  f.manager.fetch = async (url, options) => {
    if (url.endsWith('/v1/models')) { entered(); await new Promise((resolve) => { release = resolve; }); }
    return fetchImpl(url, options);
  };
  const work = f.worker.run(); await ready;
  f.own.options.config = { ...f.own.options.config, hideNonVision: true, models: [{ id: 'manual/unlisted', name: '保留手工' }, { id: 'a/old', name: '刚刚编辑', enabled: false }] };
  release(); await work;
  assert.deepEqual(f.manager.current().models.map((m) => [m.id, m.enabled]), [['manual/unlisted', true], ['a/old', false], ['b/new', false]]);
  assert.equal(f.manager.current().models[1].name, '刚刚编辑');
  assert.equal(f.manager.current().hideNonVision, true);
  f.manager.fetch = fetchImpl;
  const before = f.manager.current();
  for (const bad of [[], [{ id: '' }]]) {
    f.data.models = bad;
    await assert.rejects(f.manager.refreshCatalog(() => {}));
    assert.deepEqual(f.manager.current(), before);
  }
});

test('刷新结果回落到失败默认列表时不记成功，关闭开关及卸载能取消在途工作', async (t) => {
  const f = setup(t);
  f.backend.web.modelAPI = async () => async (path) => path === 'providers' ? { providers: [{ id: 'a' }] } : { count: 2, provider: { listError: 'vendor offline' } };
  assert.equal((await f.worker.run()).phase, 'retrying');
  assert.deepEqual(f.worker.state.done, []);
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  f.backend.web.modelAPI = (signal) => new Promise((_resolve, reject) => { entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const work = f.worker.run(); await ready;
  assert.equal(f.worker.run(), work, '并发触发共用同一个任务');
  await f.worker.stop();
  assert.equal((await work).phase, 'disabled');
});

test('定时器临近北京时间 04:00 缩短等待，卸载取消后不再安排任务', async (t) => {
  const f = setup(t), timers = [], cancelled = [];
  const worker = registerDailyModels(f.ctx, f.manager, { now: () => f.clock.now,
    schedule: (run, ms) => { const token = { run, ms, unref() {} }; timers.push(token); return token; }, cancel: (token) => cancelled.push(token) });
  assert.equal(timers[0].ms, 15_000);
  await timers[0].run();
  assert.equal(timers[1].ms, 1_000, '按北京时间边界而非本地午夜等待');
  await f.ctx.dispose();
  assert.equal(cancelled[0], timers[1]);
  assert.equal(worker.controller.signal.aborted, true);
  await timers[1].run();
  assert.equal(timers.length, 2);
});
