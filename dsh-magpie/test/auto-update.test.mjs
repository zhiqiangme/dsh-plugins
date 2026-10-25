import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { autoUpdateMagpie, CHECK_INTERVAL, conversationBlock, registerAutoUpdate, RELEASE_DELAY } from '../lib/auto-update.js';
import { ModelManager } from '../lib/runtime.js';
import { resolveConfig } from '../lib/config.js';
import { backendFixture, finish, releaseFixture } from '../fixtures/backend.mjs';
import { fakeHost } from '../fixtures/host.mjs';

function setup(t, config = {}) {
  const fixture = backendFixture(t, { idlePollMs: 1 });
  const host = fakeHost(config);
  const agent = { status: 'idle' };
  host.services.agents = { list: () => [agent] };
  const manager = new ModelManager(host.ctx, config, { backend: fixture.backend });
  const path = fixture.backend.paths.exe;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'magpie 0.1.1');
  const published = Date.parse(fixture.release.published_at);
  const now = () => published + RELEASE_DELAY;
  return { ...fixture, ...host, agent, manager, path, published, now };
}

async function phase(backend, expected) {
  for (let i = 0; i < 200; i++) {
    if (backend.operation?.phase === expected) return;
    await sleep(5);
  }
  assert.fail(`Expected ${expected}, got ${backend.operation?.phase}`);
}

test('默认开启，严格校验自动更新开关；宿主所有工作区/子代理都必须明确空闲', () => {
  assert.equal(resolveConfig().autoUpdate, true);
  assert.equal(resolveConfig({ autoUpdate: false }).autoUpdate, false);
  assert.throws(() => resolveConfig({ autoUpdate: 'true' }), /布尔值/);
  assert.equal(conversationBlock({ list: () => [] }), undefined);
  assert.equal(conversationBlock({ list: () => [{ status: 'idle' }] }), undefined);
  assert.equal(conversationBlock({ list: () => [{ status: 'idle' }, { status: 'running', parentId: 'another-workspace' }] }), 'waiting-idle');
  for (const agents of [undefined, {}, { list: () => null }, { list: () => Promise.resolve([]) }, { list: () => [{ status: 'unknown' }] }, { list: () => { throw new Error('unavailable'); } }]) {
    assert.equal(conversationBlock(agents), 'waiting-status');
  }
});

test('发布满 30 分钟才下载；最后一毫秒仍等待，到期立即允许安装', async (t) => {
  const f = setup(t);
  let downloads = 0;
  f.backend.fetchImpl = async (url, options) => { if (url.includes('/download/')) downloads++; return f.fetchImpl(url, options); };
  const waiting = await autoUpdateMagpie(f.manager, { now: () => f.now() - 1 });
  assert.equal(waiting.phase, 'cooling-down');
  assert.equal(waiting.eligibleAt, f.now());
  assert.equal(downloads, 0);
  assert.equal(readFileSync(f.path, 'utf8'), 'magpie 0.1.1');
  assert.equal((await autoUpdateMagpie(f.manager, { now: f.now })).phase, 'updated');
  assert.equal(downloads, 1);
  assert.deepEqual(f.launchArgs, [['tray']]);
});

test('发布时间缺失/非法不下载，未来发布时间继续等待', async (t) => {
  const f = setup(t);
  f.backend.fetchImpl = async (url, options) => { assert.ok(!url.includes('/download/')); return f.fetchImpl(url, options); };
  for (const value of [undefined, null, '', 'not-a-date']) {
    f.release.published_at = value;
    assert.equal((await autoUpdateMagpie(f.manager, { now: f.now })).phase, 'invalid-release-date');
  }
  f.release.published_at = new Date(f.now() + 60_000).toISOString();
  assert.equal((await autoUpdateMagpie(f.manager, { now: f.now })).phase, 'cooling-down');
});

test('运行中仍下载校验，等待期间不退出/替换；空闲后直接升级，不重复下载', async (t) => {
  const f = setup(t);
  f.agent.status = 'running';
  let running = true, downloads = 0, verified = false;
  const probe = f.backend.probe;
  f.backend.probe = async (path, signal) => { const value = await probe(path, signal); if (path.endsWith('.download.exe')) verified = true; return value; };
  f.backend.fetchImpl = async (url, options) => { if (url.includes('/download/')) downloads++; return f.fetchImpl(url, options); };
  f.backend.isRunning = async () => running;
  f.backend.stop = async (path) => { assert.ok(verified); assert.equal(f.agent.status, 'idle'); f.stops.push(path); running = false; };
  const work = autoUpdateMagpie(f.manager, { now: f.now });
  await phase(f.backend, 'waiting-idle');
  assert.ok(verified);
  assert.equal(downloads, 1);
  assert.deepEqual(f.stops, []);
  assert.equal(readFileSync(f.path, 'utf8'), 'magpie 0.1.1');
  assert.throws(() => f.backend.install(), /等待/);
  assert.equal(await autoUpdateMagpie(f.manager, { now: f.now }), undefined);
  f.agent.status = 'idle';
  assert.equal((await work).phase, 'updated');
  assert.equal(downloads, 1);
  assert.deepEqual(f.stops, [f.path]);
  assert.equal(readFileSync(f.path, 'utf8'), 'magpie 0.1.2');
});

test('进程探测期间新对话开始也会等待；状态服务稍后恢复便继续', async (t) => {
  const f = setup(t);
  f.backend.isRunning = async () => { f.agent.status = 'running'; return true; };
  let running = true;
  f.backend.stop = async () => { f.stops.push(f.path); running = false; };
  const work = autoUpdateMagpie(f.manager, { now: f.now });
  await phase(f.backend, 'waiting-idle');
  assert.deepEqual(f.stops, []);
  f.backend.isRunning = async () => running;
  delete f.services.agents;
  await phase(f.backend, 'waiting-status');
  assert.deepEqual(f.stops, []);
  f.services.agents = { list: () => [] };
  assert.equal((await work).phase, 'updated');
});

test('停用/远程/不存在/无法识别/不支持的平台不会联网或自动首次安装', async (t) => {
  for (const config of [{ autoUpdate: false }, { enabled: false }, { baseURL: 'https://example.com' }, {}]) {
    const f = setup(t, config);
    if (!Object.keys(config).length) f.own.options.config.magpiePath = join(f.root, 'missing.exe');
    f.backend.fetchImpl = () => { throw new Error('must not fetch'); };
    assert.equal(await autoUpdateMagpie(f.manager), undefined);
    assert.equal(f.backend.operation, null);
  }
  const f = setup(t);
  writeFileSync(f.path, 'unrecognized');
  assert.equal(await autoUpdateMagpie(f.manager), undefined);
  f.backend.platform = 'linux';
  assert.equal(await autoUpdateMagpie(f.manager), undefined);
});

test('等待时关闭开关、修改路径或改用远程网关会取消，卸载可中止等待并释放锁', async (t) => {
  for (const patch of [{ autoUpdate: false }, { enabled: false }, { magpiePath: 'other' }, { baseURL: 'https://example.com' }, null]) {
    const f = setup(t);
    f.agent.status = 'running';
    const work = autoUpdateMagpie(f.manager, { now: f.now });
    await phase(f.backend, 'waiting-idle');
    if (patch) Object.assign(f.own.options.config, patch.magpiePath ? { magpiePath: join(f.root, 'other.exe') } : patch);
    else await f.backend.dispose();
    assert.equal((await work).phase, patch ? 'cancelled' : 'failed');
    assert.equal(readFileSync(f.path, 'utf8'), 'magpie 0.1.1');
    assert.deepEqual(f.stops, []);
    assert.equal(existsSync(join(f.backend.paths.cache, 'install.lock')), false);
    assert.ok(!readdirSync(dirname(f.path)).some((name) => name.endsWith('.download.exe')));
  }
});

test('校验失败保留原程序，后续检查可重试；最新版本不下载或重启', async (t) => {
  const f = setup(t);
  f.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.equal((await autoUpdateMagpie(f.manager, { now: f.now })).phase, 'failed');
  assert.deepEqual(f.stops, []);
  assert.equal(readFileSync(f.path, 'utf8'), 'magpie 0.1.1');
  f.backend.fetchImpl = releaseFixture().fetchImpl;
  assert.equal((await autoUpdateMagpie(f.manager, { now: f.now })).phase, 'updated');
  assert.equal((await autoUpdateMagpie(f.manager, { now: f.now })).phase, 'up-to-date');
  assert.equal(f.launches.length, 1);
});

test('手动升级不受发布冷却限制，但仍等待空闲', async (t) => {
  const f = setup(t, { autoUpdate: false });
  f.release.published_at = '2099-01-01T00:00:00Z';
  f.agent.status = 'running';
  await f.manager.handle({ action: 'backend-install' });
  await phase(f.backend, 'waiting-idle');
  f.agent.status = 'idle';
  assert.equal((await finish(f.backend)).phase, 'updated');
});

test('后台调度在冷却到期检查、失败重试、注销后不再调度', async () => {
  const host = fakeHost();
  const timers = [], cancelled = [];
  let result = { phase: 'cooling-down', eligibleAt: 2_000 };
  registerAutoUpdate(host.ctx, { disposed: false }, { now: () => 1_000, run: async () => { if (result instanceof Error) throw result; return result; },
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: (timer) => cancelled.push(timer) });
  assert.equal(timers[0].delay, 10_000);
  await timers[0].fn();
  assert.equal(timers[1].delay, 1_000);
  result = new Error('network');
  await timers[1].fn();
  assert.equal(timers[2].delay, CHECK_INTERVAL);
  await host.ctx.dispose();
  assert.deepEqual(cancelled, [timers[2]]);
  await timers[2].fn();
  assert.equal(timers.length, 3);
});
