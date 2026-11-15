import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeHost } from '../fixtures/host.mjs';
import { resolveConfig } from '../lib/config.js';
import { CLOSE_TIMEOUT, autoStartMagpie, closeMagpieSync, registerAutoStart, registerExitClose } from '../lib/lifecycle.js';
import { backendFixture } from '../fixtures/backend.mjs';

test('关闭联动默认关闭，布尔校验严格，不支持平台不执行进程命令', () => {
  assert.equal(resolveConfig().closeOnExit, false);
  assert.throws(() => resolveConfig({ closeOnExit: 'true' }), /必须是布尔/);
  const run = () => { throw new Error('不应调用'); };
  assert.deepEqual(closeMagpieSync(resolveConfig(), { platform: 'win32', run }), []);
  assert.deepEqual(closeMagpieSync(resolveConfig({ closeOnExit: true }), { platform: 'linux', run }), []);
});

test('仅根退出或进程退出执行关闭；普通插件停用/重载解绑且不关闭', async () => {
  for (const mode of ['disabled', 'plugin-reload', 'root-exit', 'process-exit']) {
    const host = fakeHost(), hostProcess = new EventEmitter(), closed = [];
    host.ctx.root = { fiber: { state: 2 } };
    const manager = { config: resolveConfig({ closeOnExit: mode !== 'disabled' }), env: {} };
    registerExitClose(host.ctx, manager, { hostProcess, close: (config) => { closed.push(config); return []; } });
    assert.equal(hostProcess.listenerCount('exit'), 1);
    if (mode === 'root-exit') host.ctx.root.fiber.state = 5;
    if (mode === 'process-exit' || mode === 'disabled') hostProcess.emit('exit', 0);
    await host.ctx.dispose();
    hostProcess.emit('exit', 0);
    assert.equal(closed.length, ['root-exit', 'process-exit'].includes(mode) ? 1 : 0, mode);
    assert.equal(hostProcess.listenerCount('exit'), 0);
  }
});

test('升级收尾与根退出同时发生时，等待程序任务结束再关闭新启动的 Magpie', async (t) => {
  const host = fakeHost(), hostProcess = new EventEmitter(), calls = [];
  host.ctx.root = { fiber: { state: 5 } };
  let release, reachedStart, probes = 0;
  const hold = new Promise((resolve) => { release = resolve; });
  const starting = new Promise((resolve) => { reachedStart = resolve; });
  const { backend } = backendFixture(t, {
    isRunning: async () => { if (++probes === 2) { reachedStart(); await hold; } return false; },
    launch: async () => { calls.push('started'); return 4321; },
  });
  mkdirSync(backend.paths.current, { recursive: true });
  writeFileSync(backend.paths.exe, 'magpie 0.1.1');
  const manager = { config: resolveConfig({ closeOnExit: true }), env: {}, backend, pending: Promise.resolve() };
  registerExitClose(host.ctx, manager, { hostProcess, close: () => { calls.push('closed'); return [{ pid: 4321 }]; } });
  backend.install();
  await starting;
  const closing = host.ctx.dispose();
  try { assert.deepEqual(calls, [], '不能先关闭，再让升级收尾启动程序'); }
  finally { release(); await closing; }
  assert.deepEqual(calls, ['started', 'closed']);
  hostProcess.emit('exit', 0);
  assert.deepEqual(calls, ['started', 'closed'], '进程退出不应重复关闭');
});

test('退出读取最新已保存设置和路径，失败只记日志，不阻碍 DSH 退出', async () => {
  const host = fakeHost(), hostProcess = new EventEmitter(), warnings = [];
  host.ctx.logger.warn = (value) => warnings.push(value);
  const manager = { config: resolveConfig(), env: {} };
  registerExitClose(host.ctx, manager, { hostProcess, close: (config) => {
    assert.equal(config.magpiePath, join(process.cwd(), '最新路径', 'magpie.exe'));
    throw new Error('fixture denied');
  } });
  manager.config = resolveConfig({ closeOnExit: true, magpiePath: join(process.cwd(), '最新路径', 'magpie.exe') });
  hostProcess.emit('exit', 0);
  assert.match(warnings[0], /fixture denied/);
  await host.ctx.dispose();
});

test('命令使用静态脚本和环境参数，保留完整路径，不对远程网关查端口；超时明确报错', () => {
  const magpiePath = join(process.cwd(), "用户's $path", 'magpie.exe');
  const config = resolveConfig({ closeOnExit: true, magpiePath, baseURL: 'https://remote.example/v1' });
  let script;
  const result = closeMagpieSync(config, { platform: 'win32', env: {}, run: (file, args, options) => {
    assert.equal(file, 'powershell.exe');
    script = args.at(-1);
    assert.equal(script.includes(magpiePath), false);
    assert.equal(options.env.DSH_MAGPIE_CLOSE_TARGET, magpiePath);
    assert.equal(options.env.DSH_MAGPIE_CLOSE_EXPLICIT, '1');
    assert.equal(options.env.DSH_MAGPIE_CLOSE_PORT, '');
    assert.equal(options.windowsHide, true);
    // 慢机器上 PowerShell 冷启动可超过 4 秒；超时需留足余量。
    assert.equal(options.timeout, CLOSE_TIMEOUT);
    assert.ok(CLOSE_TIMEOUT >= 10_000);
    return { status: 0, stdout: '[{"pid":123}]' };
  } });
  assert.deepEqual(result, [{ pid: 123 }]);
  assert.match(script, /Stop-Process -InputObject/);
  assert.match(script, /GetFullPath\(\$current.Path\)/);
  assert.throws(() => closeMagpieSync(config, { platform: 'win32', run: () => ({ error: new Error('timeout') }) }), /timeout/);
});

test('真实 Windows 进程：网关识别只结束该实例，完整路径不会误关同名的另一份程序', { skip: process.platform !== 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-magpie-close-test-'));
  const env = { ...process.env, DSH_MAGPIE_BACKEND_ROOT: join(root, 'managed') };
  const targets = [];
  t.after(async () => {
    for (const child of targets) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const folder of ['one', 'two']) { mkdirSync(join(root, folder)); copyFileSync(process.execPath, join(root, folder, 'magpie.exe')); }
  async function start(folder) {
    const child = spawn(join(root, folder, 'magpie.exe'), ['-e', "require('node:net').createServer().listen(0,'127.0.0.1',function(){ console.log(this.address().port); });"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    targets.push(child);
    const [output] = await once(child.stdout, 'data');
    return { child, port: Number(output.toString().trim()) };
  }
  const first = await start('one'), other = await start('two');
  const firstExit = once(first.child, 'exit');
  const closed = closeMagpieSync(resolveConfig({ closeOnExit: true, baseURL: `http://127.0.0.1:${first.port}` }), { env });
  assert.deepEqual(closed.map((p) => p.pid), [first.child.pid]);
  await firstExit;
  assert.equal(other.child.exitCode, null);
  assert.equal(other.child.signalCode, null);
  const secondExit = once(other.child, 'exit');
  assert.deepEqual(closeMagpieSync(resolveConfig({ closeOnExit: true, magpiePath: join(root, 'two', 'magpie.exe') }), { env }).map((p) => p.pid), [other.child.pid]);
  await secondExit;
});

test('真实 Windows 进程：关闭升级后启动的主程序和 Bun 子进程，保留另一实例', { skip: process.platform !== 'win32' }, async (t) => {
  for (const gateway of ['parent', 'child']) await t.test(`网关由 ${gateway} 监听`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-magpie-close-tree-'));
    // 即使端口识别失败，也只能回退到测试目录，不能触及用户安装的 Magpie。
    const env = { ...process.env, DSH_MAGPIE_BACKEND_ROOT: join(root, 'managed') };
    const pids = [];
    const running = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const assertClosed = async (closed, instance) => {
      const expected = [instance.pid, instance.runtimePid];
      assert.ok(closed.length && closed.every((p) => expected.includes(p.pid)), '只允许关闭目标实例的进程');
      // 主程序可能在 Bun 退出后自行退出，因此应核对最终进程状态，而不是要求脚本逐个执行关闭。
      for (let attempt = 0; attempt < 100 && expected.some(running); attempt++) await sleep(20);
      assert.ok(expected.every((pid) => !running(pid)), '主程序和 Bun 均应退出');
    };
    t.after(async () => {
      for (const pid of pids) if (running(pid)) process.kill(pid);
      for (let attempt = 0; attempt < 100 && pids.some(running); attempt++) await sleep(20);
      assert.ok(pids.every((pid) => !running(pid)), '测试进程应全部退出');
      rmSync(root, { recursive: true, force: true });
    });
    const runtime = join(root, 'magpie-bun.exe');
    copyFileSync(process.execPath, runtime);
    for (const folder of ['one', 'two']) { mkdirSync(join(root, folder)); copyFileSync(process.execPath, join(root, folder, 'magpie.exe')); }
    // 模拟升级后 Magpie 启动 Bun 的实际父子结构；两个实例共享同一路径的 Bun，不能按名称或路径全关。
    const launcher = `
      const { spawn } = require('node:child_process');
      const listen = "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); });";
      const child = spawn(process.argv[1], ['-e', process.argv[2] === 'child' ? listen : "console.log('ready'); setInterval(() => {}, 1000);"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.once('data', (output) => {
        const report = (port) => console.log(JSON.stringify({ runtimePid: child.pid, port }));
        if (process.argv[2] === 'child') report(Number(output.toString().trim()));
        else require('node:net').createServer().listen(0, '127.0.0.1', function () { report(this.address().port); });
      });
    `;
    async function start(folder) {
      const child = spawn(join(root, folder, 'magpie.exe'), ['-e', launcher, runtime, gateway], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      pids.push(child.pid);
      const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
      const status = JSON.parse(output.toString());
      pids.push(status.runtimePid);
      return { pid: child.pid, ...status };
    }
    const first = await start('one'), other = await start('two');
    const closed = closeMagpieSync(resolveConfig({ closeOnExit: true, baseURL: `http://127.0.0.1:${first.port}` }), { env });
    await assertClosed(closed, first);
    assert.ok(running(other.pid) && running(other.runtimePid), '另一个实例及其同名 Bun 子进程应继续运行');
    const explicit = closeMagpieSync(resolveConfig({ closeOnExit: true, magpiePath: join(root, 'two', 'magpie.exe') }), { env });
    await assertClosed(explicit, other);
  });
});

// 开机启动用的 manager 替身：程序与进程检测全部注入，不探测真实主目录、不启动真实进程。
function startupManager(t, config = {}, backendOptions = {}) {
  const fixture = backendFixture(t, backendOptions);
  const manager = { config: resolveConfig(config), backend: fixture.backend, disposed: false };
  return { manager, ...fixture };
}
const refused = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); };

test('开机启动默认开启；本机未运行 Magpie 时启动已下载的程序', async (t) => {
  assert.equal(resolveConfig().autoStart, true);
  assert.throws(() => resolveConfig({ autoStart: 'yes' }), /必须是布尔/);
  const { manager, backend, launches, launchArgs } = startupManager(t);
  writeMagpie(backend.paths.exe);
  mkdirSync(join(backend.paths.settings, '..'), { recursive: true });
  writeFileSync(backend.paths.settings, JSON.stringify({ theme: 'system' }));
  const result = await autoStartMagpie(manager, { platform: 'win32', fetchImpl: refused, findRunning: async () => false });
  assert.equal(result.state, 'started');
  assert.deepEqual(launches, [backend.paths.exe]);
  assert.deepEqual(launchArgs, [['tray']], '开机只在托盘启动，不弹窗口');
  assert.equal(backend.settings().lightweight, true, '默认开启 Magpie 轻量模式');
});

test('关闭自动轻量模式后不改动 Magpie 设置；已在运行时仍按开关写入', async (t) => {
  const { manager, backend } = startupManager(t, { autoLightweight: false });
  writeMagpie(backend.paths.exe);
  mkdirSync(join(backend.paths.settings, '..'), { recursive: true });
  writeFileSync(backend.paths.settings, '{}');
  const opts = { platform: 'win32', fetchImpl: refused, findRunning: async () => true };
  assert.equal((await autoStartMagpie(manager, opts)).state, 'running');
  assert.equal(backend.settings().lightweight, false);
  manager.config = resolveConfig();
  assert.equal((await autoStartMagpie(manager, opts)).state, 'running');
  assert.equal(backend.settings().lightweight, true);
});

test('已有 Magpie 在运行、端口被占用、远程地址、关闭开关或未下载时不启动', async (t) => {
  const { manager, backend, launches } = startupManager(t);
  const opts = { platform: 'win32', fetchImpl: refused, findRunning: async () => false };
  assert.equal((await autoStartMagpie(manager, opts)).state, 'not-installed');
  writeMagpie(backend.paths.exe);
  assert.equal((await autoStartMagpie(manager, { ...opts, findRunning: async () => true })).state, 'running');
  assert.equal((await autoStartMagpie(manager, { ...opts, fetchImpl: async () => ({ ok: true }) })).state, 'running');
  assert.equal((await autoStartMagpie(manager, { ...opts, fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } })).state, 'running', '无法确定时不重复启动');
  assert.equal((await autoStartMagpie(manager, { ...opts, platform: 'linux' })).state, 'disabled');
  manager.config = resolveConfig({ autoStart: false });
  assert.equal((await autoStartMagpie(manager, opts)).state, 'disabled');
  manager.config = resolveConfig({ baseURL: 'https://remote.example' });
  assert.equal((await autoStartMagpie(manager, opts)).state, 'disabled');
  manager.config = resolveConfig();
  backend.pending = Promise.resolve();
  assert.equal((await autoStartMagpie(manager, opts)).state, 'busy');
  assert.deepEqual(launches, []);
});

test('程序无法验证为 Magpie 时不启动并记录警告；启动异常只记录不抛出', async (t) => {
  const { manager, backend, launches } = startupManager(t);
  mkdirSync(join(backend.paths.exe, '..'), { recursive: true });
  writeFileSync(backend.paths.exe, 'not magpie');
  assert.equal((await autoStartMagpie(manager, { platform: 'win32', fetchImpl: refused, findRunning: async () => false })).state, 'unverified');
  assert.deepEqual(launches, []);
  const warnings = [];
  registerAutoStart({ logger: { info() {}, warn: (m) => warnings.push(m) } }, manager, { start: async () => { throw new Error('boom'); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(warnings[0], /boom/);
});

function writeMagpie(path, version = '0.1.1') { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, `magpie ${version}`); }
