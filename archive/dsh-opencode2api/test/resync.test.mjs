import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePluginConfig } from '../lib/config.js';
import { confirmRemovals, syncModels } from '../lib/models.js';
import { createModelResync, healthTarget } from '../lib/resync.js';
import { createFakeConfigEditor, profileRows } from '../fixtures/fake-config-editor.mjs';
import { memoryCredentials, serve } from '../fixtures/http-fixture.mjs';

const READY = async () => ({ ok: true, servable: true });

function memoryLogger() {
  const lines = [];
  const push = (level) => (line) => lines.push([level, line]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * 可随时换目录的 /v1/models + 已经过一次启动同步的 profile（与真实运行顺序一致：
 * 启动同步不带移除确认，之后才轮到定时同步）。
 */
async function setup(t, { probe = READY } = {}) {
  const backend = { models: [{ id: 'keep-free' }, { id: 'step-5-preview-free' }], hits: 0 };
  const url = await serve(t, (_req, res) => {
    backend.hits += 1;
    res.end(JSON.stringify({ data: backend.models }));
  });
  const resolved = resolvePluginConfig({ models: { enabled: true, apiKey: 'key', baseURL: url } }, {});
  const editor = createFakeConfigEditor(profileRows());
  const credentials = memoryCredentials();
  assert.equal((await syncModels({ ...resolved, editor, credentials, env: {} })).state, 'updated');
  backend.hits = 0;
  const logger = memoryLogger();
  const resync = createModelResync({ resolved, logger, env: {}, probe, editor: () => editor, credentials: () => credentials });
  const ids = () => editor.entry('llm-pi-ai').options.config.providers.opencode2api.models.map((model) => model.id);
  return { backend, resolved, editor, logger, resync, ids };
}

test('后端下架的模型连续两轮缺席后从 DSH 移除，之后保持不变', async (t) => {
  const { backend, editor, resync, ids } = await setup(t);
  const edits = editor.edits.length;
  assert.equal((await resync.tick()).state, 'unchanged');

  backend.models = [{ id: 'keep-free' }];
  const first = await resync.tick();
  assert.equal(first.state, 'deferred');
  assert.deepEqual(first.missing, ['step-5-preview-free']);
  assert.deepEqual(ids(), ['keep-free', 'step-5-preview-free'], '只缺席一轮不删');
  assert.equal(editor.edits.length, edits);

  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(ids(), ['keep-free']);
  assert.equal((await resync.tick()).state, 'unchanged');
  assert.deepEqual([...resync.removalGuard.missing], []);
});

test('目录刷新抖动：缺席一轮又回来的模型不会被删，确认状态随之清零', async (t) => {
  const { backend, editor, resync, ids } = await setup(t);
  const edits = editor.edits.length;
  const full = backend.models;

  backend.models = [{ id: 'keep-free' }];
  assert.equal((await resync.tick()).state, 'deferred');
  backend.models = full;
  assert.equal((await resync.tick()).state, 'unchanged');
  backend.models = [{ id: 'keep-free' }];
  assert.equal((await resync.tick()).state, 'deferred', '中间恢复过一轮，要重新确认');
  assert.deepEqual(ids(), ['keep-free', 'step-5-preview-free']);
  assert.equal(editor.edits.length, edits);
});

test('只新增模型时当轮写入', async (t) => {
  const { backend, resync, ids } = await setup(t);
  backend.models = [...backend.models, { id: 'new-free' }];
  assert.equal((await resync.tick()).state, 'updated');
  assert.deepEqual(ids(), ['keep-free', 'step-5-preview-free', 'new-free']);
});

test('后端返回空列表时不清空，也不算作缺席', async (t) => {
  const { backend, editor, resync, ids } = await setup(t);
  const edits = editor.edits.length;
  backend.models = [];
  assert.equal((await resync.tick()).state, 'skipped');
  assert.deepEqual(ids(), ['keep-free', 'step-5-preview-free']);
  assert.equal(editor.edits.length, edits);
  assert.deepEqual([...resync.removalGuard.missing], []);
});

for (const [label, health] of [['/healthz 不通', { ok: false, reason: '探测 /healthz 失败：ECONNREFUSED' }], ['上游目录未就绪', { ok: true, servable: false }]]) {
  test(`后端未就绪（${label}）时整轮跳过，不拉目录不写配置，同一原因只记一次日志`, async (t) => {
    const { backend, editor, logger, resync } = await setup(t, { probe: async () => health });
    const edits = editor.edits.length;
    backend.models = [{ id: 'keep-free' }];
    assert.equal((await resync.tick()).state, 'not-ready');
    assert.equal((await resync.tick()).state, 'not-ready');
    assert.equal(backend.hits, 0);
    assert.equal(editor.edits.length, edits);
    assert.equal(logger.lines.length, 1);
  });
}

test('同步开关关闭时不探测后端', async () => {
  let probed = 0;
  const resolved = resolvePluginConfig({ models: { enabled: false } }, {});
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: async () => { probed += 1; return { ok: true, servable: true }; },
    editor: () => undefined, credentials: () => undefined,
  });
  assert.equal((await resync.tick()).state, 'disabled');
  assert.equal(probed, 0);
});

test('上一轮未结束时再次触发不会并发同步', async () => {
  let calls = 0;
  let release;
  const resolved = resolvePluginConfig({ models: { enabled: true } }, {});
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: () => { calls += 1; return new Promise((resolve) => { release = () => resolve({ state: 'unchanged' }); }); },
  });
  const a = resync.tick();
  const b = resync.tick();
  assert.equal(a, b);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await a;
  assert.equal(calls, 1);
});

test('定时器按间隔触发，stop 后不再触发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const resolved = resolvePluginConfig({ models: { enabled: true, resyncIntervalMs: 60_000 } }, {});
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: async () => { calls += 1; return { state: 'unchanged' }; },
  });
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

  resync.start();
  resync.start();
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 1, '重复 start 只排一条定时链');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 2);

  resync.stop();
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls, 2);
});

test('resyncIntervalMs：默认 10 分钟，0 关闭，过小抬到 1 分钟，非法值退回默认', () => {
  const interval = (value) => resolvePluginConfig({ models: { resyncIntervalMs: value } }, {}).models.resyncIntervalMs;
  assert.equal(interval(undefined), 600_000);
  assert.equal(interval(0), 0);
  assert.equal(interval(5_000), 60_000);
  assert.equal(interval('bad'), 600_000);
  assert.equal(interval(1_800_000), 1_800_000);
});

test('间隔为 0 时 start 不排定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const resolved = resolvePluginConfig({ models: { enabled: true, resyncIntervalMs: 0 } }, {});
  const resync = createModelResync({
    resolved, logger: memoryLogger(), probe: READY, editor: () => undefined, credentials: () => undefined,
    sync: async () => { calls += 1; return { state: 'unchanged' }; },
  });
  resync.start();
  t.mock.timers.tick(10 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('confirmRemovals：缺席集合是上一轮的子集才放行', () => {
  const guard = {};
  assert.equal(confirmRemovals(guard, ['a', 'b'], ['a', 'b']).ok, true);
  assert.equal(confirmRemovals(guard, ['a', 'b', 'c'], ['a']).ok, false);
  assert.equal(confirmRemovals(guard, ['a', 'b', 'c'], ['a', 'b']).ok, true, 'c 上一轮已缺席');
  assert.equal(confirmRemovals({}, [], ['x']).ok, true, '新 provider 没有可删的');
});

test('healthTarget 跟随 models.baseURL，解析不了退回托管端口', () => {
  assert.deepEqual(healthTarget('http://127.0.0.1:9090/v1', { host: '127.0.0.1', port: 8080 }), { host: '127.0.0.1', port: 9090 });
  assert.deepEqual(healthTarget('', { host: '127.0.0.1', port: 8080 }), { host: '127.0.0.1', port: 8080 });
});

test('Tiara 定时同步默认使用 /health，不依赖 Go 后端的 /healthz',async t=>{
  const hits=[];let synced=0;
  const url=await serve(t,(req,res)=>{hits.push(req.url);res.end(JSON.stringify({status:'ok',proxy:true}));});
  const resolved=resolvePluginConfig({gateway:'tiara',models:{enabled:true,baseURL:url}},{});
  const resync=createModelResync({resolved,logger:memoryLogger(),editor:()=>undefined,credentials:()=>undefined,sync:async()=>{synced++;return {state:'unchanged'};}});
  assert.equal((await resync.tick()).state,'unchanged');assert.deepEqual(hits,['/health']);assert.equal(synced,1);resync.stop();
});
