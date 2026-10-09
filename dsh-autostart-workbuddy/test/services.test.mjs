/**
 * 进程托管测试：真的 spawn 一个假服务，验证就绪判定、幂等、提前退出与"只停自己拉起的进程"。
 * 这些用例覆盖的正是插件最关键的行为，所以不 mock 子进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ManagedService, probeTcp, resolveExecutableOnPath, waitForPort } from '../lib/services.js';

const DUMMY = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));
const silent = { info() {}, warn() {}, error() {} };

/** 借一个空闲端口：先 listen(0) 拿到系统分配，再关掉交给子进程使用。 */
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

function specFor(port, overrides = {}) {
  return {
    key: 'workbuddy',
    title: 'dummy',
    host: '127.0.0.1',
    port,
    exe: process.execPath,
    args: [DUMMY],
    cwd: process.cwd(),
    env: { ...process.env, TEST_PORT: String(port), TEST_MODE: 'listen' },
    logDir: mkdtempSync(join(tmpdir(), 'autostart-wb-log-')),
    logName: 'dummy',
    readinessTimeoutMs: 10_000,
    stopTimeoutMs: 5_000,
    ...overrides,
  };
}

test('启动假服务 → 端口就绪 → 停止后端口释放', async () => {
  const port = await freePort();
  const service = new ManagedService(specFor(port), silent);

  const started = await service.ensureRunning();
  assert.equal(started.state, 'started');
  assert.equal(await probeTcp(port), true);

  const stopped = await service.stop('测试结束');
  assert.equal(stopped.stopped, true);
  assert.equal(await probeTcp(port), false);
  assert.equal(service.isAlive(), false);
});

test('端口已监听时跳过启动（幂等，不拉起第二个实例）', async () => {
  const port = await freePort();
  const occupied = createServer();
  await new Promise((done) => occupied.listen(port, '127.0.0.1', done));

  try {
    const service = new ManagedService(specFor(port), silent);
    const result = await service.ensureRunning();
    assert.equal(result.state, 'already-running');
    // 关键：没有 spawn 过，所以停止阶段不会去动别人的进程。
    assert.equal(service.startedByUs, false);
    const stopped = await service.stop('测试结束');
    assert.deepEqual(stopped, { stopped: false, skipped: true });
    assert.equal(await probeTcp(port), true, '外部服务必须仍然存活');
  } finally {
    await new Promise((done) => occupied.close(done));
  }
});

test('子进程提前退出：不白等满超时，并给出退出码原因', async () => {
  const port = await freePort();
  const service = new ManagedService(
    specFor(port, { env: { ...process.env, TEST_MODE: 'exit' }, readinessTimeoutMs: 30_000 }),
    silent,
  );

  const began = Date.now();
  const result = await service.ensureRunning();
  const elapsed = Date.now() - began;

  assert.equal(result.state, 'failed');
  assert.match(result.reason, /提前退出/);
  assert.ok(elapsed < 10_000, `应在子进程退出后立即失败，实际耗时 ${elapsed}ms`);
});

test('可执行文件不存在：直接失败且不 spawn', async () => {
  const service = new ManagedService(specFor(await freePort(), { exe: 'Z:\\nope\\missing.exe' }), silent);
  const result = await service.ensureRunning();
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /未找到可执行文件/);
});

test('缺少必需环境变量时拒绝启动并指明变量名', async () => {
  const service = new ManagedService(
    specFor(await freePort(), { env: {}, requiredEnv: ['WB_TOKEN'], envFile: 'C:\\nope\\.env' }),
    silent,
  );
  const result = await service.ensureRunning();
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /WB_TOKEN/);
});

test('子进程监听失败（从不监听）：超时后失败，且不留下残留进程', async () => {
  const port = await freePort();
  const service = new ManagedService(
    // TEST_PORT=0 让假服务监听随机端口，因此目标端口永远不会就绪。
    specFor(port, { env: { ...process.env, TEST_PORT: '0' }, readinessTimeoutMs: 1_500 }),
    silent,
  );

  const result = await service.ensureRunning();
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /未确认/);
  // 回归：启动失败后必须回收自己拉起的进程，否则宿主进程树里会留下僵尸进程。
  assert.equal(service.isAlive(), false, '启动失败后不应残留子进程');
});

test('启动失败回收进程后，stop() 是幂等的', async () => {
  const port = await freePort();
  const service = new ManagedService(
    specFor(port, { env: { ...process.env, TEST_PORT: '0' }, readinessTimeoutMs: 1_000 }),
    silent,
  );
  await service.ensureRunning();
  const stopped = await service.stop('重复停止');
  assert.deepEqual(stopped, { stopped: false, skipped: true });
});

test('resolveExecutableOnPath：显式路径与 PATH 搜索', () => {
  assert.equal(resolveExecutableOnPath('C:\\nope\\missing.exe'), undefined);
  assert.ok(resolveExecutableOnPath(process.execPath), '绝对路径存在时应返回自身');

  // PATH 搜索：用当前进程所在目录构造一条最小 PATH。
  const dir = process.execPath.slice(0, process.execPath.lastIndexOf('\\'));
  const name = process.execPath.slice(process.execPath.lastIndexOf('\\') + 1).replace(/\.exe$/i, '');
  const found = resolveExecutableOnPath(name, { PATH: dir, PATHEXT: '.EXE' });
  assert.ok(found, `应在 PATH 中找到 ${name}`);
});

test('waitForPort：shouldContinue 返回 false 时立即放弃', async () => {
  const port = await freePort();
  const began = Date.now();
  const ready = await waitForPort(port, { timeoutMs: 30_000, shouldContinue: () => false });
  assert.equal(ready, false);
  assert.ok(Date.now() - began < 1_000);
});
