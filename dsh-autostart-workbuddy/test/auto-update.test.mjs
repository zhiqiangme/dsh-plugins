/**
 * 后端自动更新测试：候选判断（纯函数）、后台下载暂存、下次启动时换装，以及各条防护规则。
 *
 * 全程离线：假 release 服务器（fixtures/dummy-server.mjs 的 http-release / http-hub-release）
 * 提供 release 元数据与资产，健康探针走 http-health / http-hub-health。时间用 now 注入，
 * 与夹具里写死的 published_at 对齐，不依赖跑测试那天的日期。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoUpdateStatus, createAutoUpdater, evaluateCandidate, readAutoState } from '../lib/auto-update.js';
import { applyUpdate, backendPaths, readBuildInfo, readManifest, rollbackBackend, writeManifest } from '../lib/backend.js';
import { resolvePluginConfig } from '../lib/config.js';
import { withBackendLock } from '../lib/gateway.js';
import { hubPaths, localHubVersion } from '../lib/hub.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));

const OLD_REVISION = 'a'.repeat(40);
const NEW_COMMIT = 'f'.repeat(40);
/** 夹具 http-release 的 published_at 是 2026-10-09，http-hub-release 是 2026-10-18；这里取两者都满 24 小时的时刻。 */
const NOW = Date.parse('2026-10-20T00:00:00Z');

function startFixture(env = {}) {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, TEST_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('fixture 启动超时')), 10_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /listening (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fixture 提前退出 code=${code}`));
    });
  });
  return { ready, stop: () => child.kill() };
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** 替身 ManagedService：只记录调用，不真的起进程。 */
function fakeService(port, { stopResult = { stopped: true } } = {}) {
  const calls = [];
  return {
    calls,
    spec: { host: '127.0.0.1', port },
    port,
    async stop(reason) {
      calls.push(['stop', reason]);
      return stopResult;
    },
    async ensureRunning() {
      calls.push(['start']);
      return { state: 'started' };
    },
  };
}

function fakeLogger() {
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, info: record('info'), warn: record('warn'), error: record('error') };
}

function fakeExe(revision) {
  return Buffer.from(`MZ fake\nvcs.revision=${revision}\nvcs.time=2026-10-01T00:00:00Z\nvcs.modified=false\n`, 'utf8');
}

/** 装着 v1.0.0（由插件从 release 装上）的 wb2api 数据根，以及指向假 release 的插件配置。 */
function wb2apiSetup(apiBase, backend = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-auto-'));
  const env = { DSH_WORKBUDDY_BACKEND_ROOT: root };
  const paths = backendPaths(env);
  mkdirSync(paths.current, { recursive: true });
  writeFileSync(paths.exe, fakeExe(OLD_REVISION));
  writeManifest(paths, { tag: 'v1.0.0', commit: OLD_REVISION, source: 'github-release' });
  const resolved = resolvePluginConfig({ backend: { apiBase, ...backend } }, env);
  return { root, paths, resolved };
}

function updaterFor(resolved, service, extra = {}) {
  const logger = fakeLogger();
  const updater = createAutoUpdater({ resolved, logger, service, env: {}, now: () => NOW, firstDelayMs: 60_000, ...extra });
  return { updater, logger };
}

test('evaluateCandidate：只认比当前新、发布满冷却期、没被回滚 / 失败过、当前版本可识别的正式版', () => {
  const latest = { tag: 'v1.8.0', publishedAt: '2026-10-18T00:00:00Z' };
  const local = { tag: 'v1.7.14', source: 'github-release', drifted: false };
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.deepEqual(evaluateCandidate({ latest, local, now }), { eligible: true });

  const reason = (input) => evaluateCandidate({ latest, local, now, ...input }).reason;
  assert.equal(reason({ local: { ...local, tag: 'v1.8.0' } }), 'up-to-date');
  assert.equal(reason({ local: { ...local, tag: 'v1.9.0' } }), 'up-to-date', '不做降级');
  assert.equal(reason({ local: { ...local, tag: null } }), 'unknown-local');
  assert.equal(reason({ local: { ...local, tag: 'nightly' } }), 'unknown-local');
  assert.equal(reason({ local: { ...local, drifted: true } }), 'drifted');
  assert.equal(reason({ local: { ...local, source: 'rollback', previous: { tag: 'v1.8.0' } } }), 'rolled-back');
  assert.deepEqual(
    evaluateCandidate({ latest: { ...latest, tag: 'v1.8.1' }, local: { ...local, source: 'rollback', previous: { tag: 'v1.8.0' } }, now }),
    { eligible: true },
    '回滚只挡被退掉的那个版本，更新的版本照常',
  );
  assert.equal(reason({ autoState: { failed: { tag: 'v1.8.0' } } }), 'failed-before');
  assert.equal(reason({ latest: { tag: 'v1.8.0' } }), 'no-publish-time');

  const fresh = evaluateCandidate({ latest, local, now: Date.parse('2026-10-18T06:00:00Z') });
  assert.equal(fresh.reason, 'too-fresh');
  assert.equal(fresh.readyAt, Date.parse('2026-10-19T00:00:00Z'));
  assert.deepEqual(evaluateCandidate({ latest, local, now: Date.parse('2026-10-18T06:00:00Z'), delayHours: 0 }), { eligible: true }, '冷却期可以设成 0');
});

test('wb2api：后台只下载暂存不动 current/，下次启动先换上；回滚过的版本不再自动装回去', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const service = fakeService(await health.ready);
  const { updater, logger } = updaterFor(resolved, service);
  try {
    const prepared = await updater.tick();
    assert.equal(prepared.state, 'prepared', JSON.stringify(prepared));
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION, '后台下载不碰正在用的程序');
    assert.deepEqual(service.calls, [], '后台下载不停服务');
    const pending = readAutoState(paths).pending;
    assert.equal(pending.tag, 'v9.9.9');
    assert.ok(existsSync(pending.staged.path), '新版本暂存在 cache/');
    assert.ok(logger.lines.some((line) => line.includes('下次启动 DSH 时自动安装')), logger.lines.join('\n'));
    assert.equal(autoUpdateStatus(resolved).pending.tag, 'v9.9.9', '面板能看到已下载待装');

    // 同一版本已经暂存：下一轮不再下载（release 服务器停了也照样答，走查询缓存）。
    release.stop();
    assert.equal((await updater.tick()).state, 'pending');

    // 下次启动：先换上，再由 index.js 照常 ensureRunning。
    const applied = await updater.applyPending();
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(readBuildInfo(paths.exe).revision, NEW_COMMIT);
    const manifest = readManifest(paths);
    assert.equal(manifest.source, 'auto-update');
    assert.equal(manifest.previous.tag, 'v1.0.0');
    const state = readAutoState(paths);
    assert.equal(state.pending, null);
    assert.equal(state.last.from, 'v1.0.0');
    assert.equal(state.last.to, 'v9.9.9');
    assert.equal(await updater.applyPending(), undefined, '换完就没有待装的了');

    // 用户觉得新版本不好，手动回滚：之后的检查跳过 v9.9.9，不会又被自动装回去。
    const rolled = await rollbackBackend({ paths, service });
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    const skipped = await updater.tick();
    assert.equal(skipped.state, 'skipped');
    assert.equal(skipped.reason, 'rolled-back');
    assert.equal(readAutoState(paths).lastCheck.reason, 'rolled-back', '面板能说明为什么没更新');
  } finally {
    release.stop();
    health.stop();
  }
});

test('冷却期内不下载，只记下什么时候再来', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const { updater } = updaterFor(resolved, fakeService(1), { now: () => Date.parse('2026-10-09T06:00:00Z') });
  try {
    const result = await updater.tick();
    assert.equal(result.state, 'skipped');
    assert.equal(result.reason, 'too-fresh');
    const state = readAutoState(paths);
    assert.equal(state.pending, null);
    assert.equal(state.lastCheck.readyAt, '2026-10-10T00:00:00.000Z');
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION);
  } finally {
    release.stop();
  }
});

test('换上后健康检查不过：退回原版本，这个版本记成失败、不再自动重试', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const service = fakeService(await freePort()); // 没人监听 → /healthz 必然失败
  const { updater, logger } = updaterFor(resolved, service);
  try {
    assert.equal((await updater.tick()).state, 'prepared');
    const applied = await updater.applyPending();
    assert.equal(applied.state, 'health-failed');
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION, '已退回原版本');
    const state = readAutoState(paths);
    assert.equal(state.pending, null);
    assert.equal(state.failed.tag, 'v9.9.9');
    assert.ok(logger.lines.some((line) => line.startsWith('error') && line.includes('不再自动重试')), logger.lines.join('\n'));

    const again = await updater.tick();
    assert.equal(again.reason, 'failed-before');
    assert.equal(readAutoState(paths).pending, null, '失败过的版本不再下载');
  } finally {
    release.stop();
  }
});

test('启动时端口被别人的进程占着：这次不换，暂存的包留到下次', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const foreign = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const service = fakeService(await foreign.ready, { stopResult: { stopped: false } });
  const { updater } = updaterFor(resolved, service);
  try {
    assert.equal((await updater.tick()).state, 'prepared');
    const applied = await updater.applyPending();
    assert.equal(applied.state, 'not-owned');
    const pending = readAutoState(paths).pending;
    assert.equal(pending.tag, 'v9.9.9');
    assert.ok(existsSync(pending.staged.path), '暂存文件保留');
    assert.equal(readAutoState(paths).failed, null, '不算版本失败');
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION);
  } finally {
    release.stop();
    foreign.stop();
  }
});

test('关掉自动更新 / 自配 exe：不检查；之前暂存的包在启动时清掉而不是装上', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const service = fakeService(1);
  const { updater } = updaterFor(resolved, service);
  try {
    assert.equal((await updater.tick()).state, 'prepared');
    const staged = readAutoState(paths).pending.staged.path;

    resolved.backend.autoUpdate = false;
    assert.deepEqual(await updater.tick(), { state: 'inactive', reason: 'disabled' });
    const applied = await updater.applyPending();
    assert.equal(applied.state, 'discarded');
    assert.equal(existsSync(staged), false);
    assert.equal(readAutoState(paths).pending, null);
    assert.deepEqual(service.calls, []);
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION);
  } finally {
    release.stop();
  }

  const custom = resolvePluginConfig({ exe: 'C:/elsewhere/wb2api.exe' }, { DSH_WORKBUDDY_BACKEND_ROOT: mkdtempSync(join(tmpdir(), 'wb-auto-')) });
  assert.equal(custom.backend.autoUpdate, true);
  const { updater: customUpdater } = updaterFor(custom, fakeService(1));
  assert.deepEqual(await customUpdater.tick(), { state: 'inactive', reason: 'custom-exe' });
  assert.equal(autoUpdateStatus(custom).available, false, '面板据此禁用开关');
});

test('用户手动更新到了暂存的版本：下一轮清掉过期的暂存包', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const service = fakeService(await health.ready);
  const { updater } = updaterFor(resolved, service);
  try {
    assert.equal((await updater.tick()).state, 'prepared');
    const manual = await applyUpdate({ paths, env: {}, apiBase, service });
    assert.equal(manual.ok, true, JSON.stringify(manual));
    assert.equal(readManifest(paths).source, 'github-release', '手动更新照旧记 github-release');

    const result = await updater.tick();
    assert.equal(result.reason, 'up-to-date');
    assert.equal(readAutoState(paths).pending, null);
    assert.equal(await updater.applyPending(), undefined);
  } finally {
    release.stop();
    health.stop();
  }
});

test('面板正在更新（锁被占着）：后台这一轮让路，启动换装也不硬抢', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths, resolved } = wb2apiSetup(apiBase);
  const service = fakeService(1);
  const { updater } = updaterFor(resolved, service);
  let releaseLock;
  let held = withBackendLock('update', () => new Promise((done) => { releaseLock = done; }));
  try {
    const busy = await updater.tick();
    assert.deepEqual(busy, { state: 'busy', holder: 'update' });
    assert.equal(readAutoState(paths).pending, null);
    releaseLock();
    await held;

    assert.equal((await updater.tick()).state, 'prepared');
    held = withBackendLock('rollback', () => new Promise((done) => { releaseLock = done; }));
    assert.deepEqual(await updater.applyPending(), { state: 'busy', holder: 'rollback' });
    assert.equal(readAutoState(paths).pending.tag, 'v9.9.9', '包留着，下次启动再换');
    assert.deepEqual(service.calls, []);
  } finally {
    releaseLock();
    await held;
    release.stop();
  }
  const blocked = await withBackendLock('update', async () => 'ran');
  assert.deepEqual(blocked, { acquired: true, value: 'ran' }, '锁用完即释放');
});

test('hub：同一套流程换的是整个目录，账号数据不动', async () => {
  const release = startFixture({ TEST_MODE: 'http-hub-release', TEST_RELEASE_TAG: 'v1.8.0' });
  const health = startFixture({ TEST_MODE: 'http-hub-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const root = mkdtempSync(join(tmpdir(), 'wb-auto-hub-'));
  const env = { DSH_WORKBUDDY_BACKEND_ROOT: root };
  const paths = hubPaths(env);
  mkdirSync(join(paths.current, 'python'), { recursive: true });
  writeFileSync(join(paths.current, 'wb_proxy.py'), '# v1.7.14\n');
  writeFileSync(join(paths.current, 'python', 'python.exe'), 'MZ');
  writeFileSync(join(paths.current, 'release-manifest.json'), JSON.stringify({ tag: 'v1.7.14', root: 'wb-proxy' }));
  writeFileSync(paths.state, JSON.stringify({ tag: 'v1.7.14', source: 'github-release' }));
  mkdirSync(paths.accounts, { recursive: true });
  writeFileSync(join(paths.accounts, 'acc.json'), '{"uid":"u1"}');
  const resolved = resolvePluginConfig({ gateway: 'hub', backend: { apiBase } }, env);
  const service = fakeService(await health.ready);
  const { updater } = updaterFor(resolved, service);
  try {
    assert.equal((await updater.tick()).state, 'prepared');
    assert.equal(localHubVersion(paths).tag, 'v1.7.14');
    assert.deepEqual(service.calls, []);

    const applied = await updater.applyPending();
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(localHubVersion(paths).tag, 'v1.8.0');
    assert.equal(localHubVersion(paths).source, 'auto-update');
    assert.ok(existsSync(join(paths.versions, 'v1.7.14', 'wb_proxy.py')), '旧版本留着可回滚');
    assert.equal(readFileSync(join(paths.accounts, 'acc.json'), 'utf8'), '{"uid":"u1"}');
    assert.equal(readAutoState(paths).last.to, 'v1.8.0');
  } finally {
    release.stop();
    health.stop();
  }
});

test('定时：start 后等 firstDelayMs 才查第一轮，stop 之后不再查', async () => {
  const { resolved } = wb2apiSetup('http://127.0.0.1:1');
  let checks = 0;
  const driver = {
    describe: () => ({ exeExists: true, version: { tag: 'v1.0.0' } }),
    check: async () => {
      checks += 1;
      return { local: { tag: 'v1.0.0' }, latest: { tag: 'v1.0.0', publishedAt: '2026-01-01T00:00:00Z' } };
    },
  };
  resolved.backend.checkTtlMs = 15;
  const { updater } = updaterFor(resolved, fakeService(1), { driver, firstDelayMs: 20 });
  updater.start();
  assert.equal(checks, 0, '不在启动当下抢网络');
  await new Promise((done) => setTimeout(done, 80));
  assert.ok(checks >= 1, `应已查过（${checks}）`);
  updater.stop();
  const seen = checks;
  await new Promise((done) => setTimeout(done, 80));
  assert.equal(checks, seen, 'stop 之后不再排下一轮');
});
