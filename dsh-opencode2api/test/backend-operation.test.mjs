import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendOperations } from '../lib/backend-operation.js';

function context(t) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-operation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { paths: { root }, gateway: 'tiara', logger: { warn() {} } };
}

test('操作立即返回；断开请求后持续运行，同一任务的进度和最终结果持久保存', async t => {
  const options = context(t);
  let finish;
  const operations = createBackendOperations({ ...options, run: async (_action, { onProgress }) => {
    onProgress({ stage: 'runtime', detail: '下载运行时', received: 25, total: 100 });
    await new Promise(resolve => { finish = resolve; });
    return { ok: true, state: 'installed', latest: { tag: 'main-a' } };
  } });
  const started = operations.start('install');
  assert.equal(started.operation.state, 'running');
  await Promise.resolve();
  assert.equal(operations.current.id, started.operation.id);
  assert.equal(operations.current.progress.received, 25);
  assert.equal(operations.start('install').ok, false);
  finish(); await operations.wait();
  const reloaded = createBackendOperations({ ...options, run() { throw new Error('should not rerun'); } });
  assert.equal(reloaded.current.state, 'succeeded');
  assert.equal(reloaded.current.result.state, 'installed');
  assert.equal(reloaded.current.id, started.operation.id);
});

test('上次运行被退出中断时解除忙碌状态，保留诊断，允许重试', async t => {
  const options = context(t);
  writeFileSync(join(options.paths.root, 'operation.json'), JSON.stringify({ state: 'running', action: 'install', id: 'old' }));
  const operations = createBackendOperations({ ...options, run: async () => ({ ok: false, reason: 'network offline' }) });
  assert.equal(operations.busy, false);
  assert.equal(operations.current.result.state, 'interrupted');
  assert.equal(operations.start('install').ok, true);
  await operations.wait();
  assert.match(JSON.parse(readFileSync(join(options.paths.root, 'operation.json'))).result.reason, /offline/);
});

test('释放会取消下载；彻底卸载成功后不会为了任务记录重建数据目录', async t => {
  const options = context(t);
  const operations = createBackendOperations({ ...options, run: async (_action, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  operations.start('install'); await Promise.resolve(); await operations.dispose();
  assert.equal(operations.current.state, 'failed');
  assert.equal(operations.current.result.state, 'interrupted');
  const purge = createBackendOperations({ ...options, run: async () => {
    rmSync(options.paths.root, { recursive: true, force: true });
    return { ok: true };
  } });
  purge.start('purge'); await purge.wait();
  assert.equal(existsSync(options.paths.root), false);
});
