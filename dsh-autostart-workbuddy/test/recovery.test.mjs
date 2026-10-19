import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../lib/recovery.js';
import { withBackendLock } from '../lib/gateway.js';

const flush = () => new Promise((done) => setImmediate(done));
function setup(t, result = 'started') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const service = { startedByUs: true, stopping: false, ensureRunning: async () => { calls++; return { state: result }; } };
  const recovery = createRecovery({ service, resolved: { recovery: { enabled: true, maxAttempts: 3, windowMs: 300_000, delayMs: 5, maxDelayMs: 20 } }, logger: { info() {}, warn() {} } });
  recovery.arm();
  t.after(() => recovery.stop());
  return { recovery, service, calls: () => calls, advance: async (ms) => { t.mock.timers.tick(ms); await flush(); } };
}

test('意外退出后退避恢复，连续失败三次后停止；重置后可以重新恢复', async (t) => {
  const x = setup(t, 'failed');
  x.recovery.onExit();
  await x.advance(5); await x.advance(10); await x.advance(20);
  assert.equal(x.calls(), 3);
  assert.equal(x.recovery.status.state, 'exhausted');
  await x.advance(100);
  assert.equal(x.calls(), 3);
  x.recovery.reset(); x.recovery.onExit(); await x.advance(5);
  assert.equal(x.calls(), 4);
});

test('成功恢复；外部进程和主动停止不触发恢复', async (t) => {
  const x = setup(t);
  x.service.startedByUs = false; x.recovery.onExit(); await x.advance(100);
  assert.equal(x.calls(), 0);
  x.service.startedByUs = true; x.service.stopping = true; x.recovery.onExit(); await x.advance(100);
  assert.equal(x.calls(), 0);
  x.service.stopping = false; x.recovery.onExit(); await x.advance(5);
  assert.equal(x.recovery.status.state, 'recovered');
  assert.equal(x.calls(), 1);
});

test('更新占锁时让路，不消耗恢复次数；主动卸载取消已排队的恢复', async (t) => {
  const x = setup(t);
  let release;
  const held = withBackendLock('update', () => new Promise((done) => { release = done; }));
  try {
    x.recovery.onExit(); await x.advance(5);
    assert.equal(x.calls(), 0);
    assert.equal(x.recovery.status.attempts, 0);
  } finally { release(); await held; }
  await x.advance(5);
  assert.equal(x.calls(), 1);
  x.recovery.onExit(); x.recovery.suspend(); await x.advance(100);
  assert.equal(x.calls(), 1);
});

test('关闭插件后取消恢复，迟到的退出事件无效', async (t) => {
  const x = setup(t);
  x.recovery.onExit(); await x.recovery.stop(); await x.advance(100);
  x.recovery.arm(); x.recovery.onExit(); await x.advance(100);
  assert.equal(x.calls(), 0);
});

test('重试前端口被外部进程占用时暂停，不把它认作自己已恢复', async (t) => {
  const x = setup(t, 'already-running');
  x.service.isAlive = () => false;
  x.recovery.onExit(); await x.advance(5);
  assert.equal(x.recovery.status.state, 'external');
  await x.advance(100);
  assert.equal(x.calls(), 1);
});

test('手动重试重置恢复预算并取消尚未执行的自动重试', async (t) => {
  const x = setup(t);
  x.recovery.onExit();
  x.recovery.reset();
  await x.advance(100);
  assert.equal(x.calls(), 0);
  assert.equal(x.recovery.status.state, 'idle');
});
