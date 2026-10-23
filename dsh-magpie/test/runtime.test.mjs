import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelManager } from '../lib/runtime.js';
import { KEY_REF, PROVIDER_ID } from '../lib/config.js';
import { apply } from '../lib/index.js';
import { fakeHost } from '../fixtures/host.mjs';
import { MagpieBackend } from '../lib/backend.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { syncEnabled: true, models: [{ id: 'manual/unlisted', name: '自己的目录' }] };
function setup(options) {
  const host = fakeHost();
  const manager = new ModelManager(host.ctx, {}, { env: {}, ...options });
  return { ...host, manager };
}

test('保存手工清单不拉 Magpie 目录，重建实例后仍保留', async () => {
  const host = setup({ fetchImpl: () => { throw new Error('手工保存不应该联网'); } });
  const view = await host.manager.describe();
  const result = await host.manager.handle({ action: 'save', revision: view.revision, config });
  assert.equal(result.saved, true);
  assert.equal(result.sync.ok, true);
  assert.equal(host.own.options.config.models[0].id, 'manual/unlisted');
  assert.equal(host.llm.options.config.providers[PROVIDER_ID].models[0].name, '自己的目录');
  const reopened = new ModelManager(host.ctx, host.own.options.config, { env: {} });
  assert.deepEqual((await reopened.describe()).config, result.config);
  assert.deepEqual(result.nativeProviders, ['magpie']);
  assert.equal(result.providerNames['workbuddy-ai'], 'WorkBuddy GL');
  assert.equal(result.providerNames.workbuddy, 'WorkBuddy');
});

test('两个页面保存时拒绝过期版本，保留新清单和凭据', async () => {
  const host = setup();
  const initial = await host.manager.describe();
  await host.manager.handle({ action: 'save', revision: initial.revision, config });
  await assert.rejects(host.manager.handle({ action: 'save', revision: initial.revision, config: { models: [{ id: 'stale' }] }, apiKey: 'stale-key' }), (error) => error.status === 409);
  assert.equal(host.own.options.config.models[0].id, 'manual/unlisted');
  assert.equal(host.keys.get(KEY_REF), 'magpie-dsh');
});

test('同时保存串行核对版本，只有一个相同版本的修改可生效', async () => {
  const host = setup();
  const view = await host.manager.describe();
  const results = await Promise.allSettled(['a', 'b'].map((id) => host.manager.handle({ action: 'save', revision: view.revision, config: { models: [{ id }] } })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
});

test('模型清单已保存但同步失败时如实返回，可修复后再同步', async () => {
  const host = setup();
  host.services.credentials.set = async () => { throw new Error('locked'); };
  const result = await host.manager.handle({ action: 'save', revision: (await host.manager.describe()).revision, config });
  assert.equal(result.saved, true);
  assert.equal(result.sync.ok, false);
  assert.equal(host.own.options.config.models[0].id, 'manual/unlisted');
  assert.equal(host.llm.options.config.providers[PROVIDER_ID], undefined);
  host.services.credentials.set = async (ref, value) => host.keys.set(ref, value);
  assert.equal((await host.manager.handle({ action: 'sync', revision: result.revision })).sync.ok, true);
});

test('Key 写凭据库，GET 不回显；空输入沿用，环境变量不被表单覆盖', async () => {
  const host = setup();
  await host.manager.handle({ action: 'save', revision: (await host.manager.describe()).revision, config, apiKey: 'secret-new-key' });
  const view = await host.manager.describe();
  assert.equal(host.keys.get(KEY_REF), 'secret-new-key');
  assert.equal(view.keyConfigured, true);
  assert.equal(JSON.stringify(view).includes('secret-new-key'), false);
  assert.equal(JSON.stringify(host.own.options.config).includes('secret-new-key'), false);
  await host.manager.handle({ action: 'save', revision: view.revision, config, apiKey: '' });
  assert.equal(host.keys.get(KEY_REF), 'secret-new-key');
  const envManager = new ModelManager(host.ctx, {}, { env: { [KEY_REF]: 'from-env' } });
  assert.equal((await envManager.describe()).keyWritable, false);
  await assert.rejects(envManager.handle({ action: 'save', revision: view.revision, config, apiKey: 'replace-env' }), /不可写/);
});

test('全量同步以 Magpie 目录覆盖保存并更新 DSH，移除旧项和手工项，全部勾选', async () => {
  const calls = [];
  const host = setup({ fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => url.endsWith('/api/hello') ? { name: 'magpie', version: 'test' } : { data: [{ id: 'workbuddy-ai/b', display_name: 'B', context_window: 1000000, max_output_tokens: 128000 }, { id: 'new/a', display_name: 'A' }] } }; } });
  host.own.options.config = { models: [{ id: 'workbuddy/disabled' }, { id: 'workbuddy-ai/b', name: '旧名字', enabled: false }, { id: 'manual' }] };
  const initial = await host.manager.describe();
  const result = await host.manager.handle({ action: 'sync-catalog', revision: initial.revision, config: { ...initial.config, models: [{ id: '' }] } });
  assert.equal(result.saved, true);
  assert.equal(result.sync.ok, true);
  // 同步后按模型名称排序保存：A 在 B 前，与上游返回顺序无关。
  assert.deepEqual(result.config.models.map((m) => m.id), ['new/a', 'workbuddy-ai/b']);
  assert.equal(result.config.models[1].name, 'B');
  assert.equal(result.config.models[1].maxTokens, 128000);
  assert.ok(result.config.models.every((m) => m.enabled));
  assert.equal(result.config.syncEnabled, true);
  assert.deepEqual(host.own.options.config.models, result.config.models);
  assert.deepEqual(host.llm.options.config.providers[PROVIDER_ID].models.map((m) => m.id), ['new/a', 'workbuddy-ai/b']);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID].models[1].name, 'B WorkBuddy GL');
  assert.deepEqual(host.llm.options.config.providers.magpie.models, [{ id: 'native' }]);
  assert.deepEqual(host.llm.options.config.providers.unrelated.models, [{ id: 'keep' }]);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/api/hello', '/v1/models']);
  const editsBefore = host.edits.length;
  host.manager.fetch = async () => ({ ok: true, json: async () => ({ name: 'other-app' }) });
  await assert.rejects(host.manager.handle({ action: 'sync-catalog', revision: result.revision, config: result.config }), /身份/);
  assert.equal(host.edits.length, editsBefore);
});

test('合法空目录清空清单并移除 DSH 分组；异常目录及网络失败保留原配置', async () => {
  const host = setup();
  const saved = await host.manager.handle({ action: 'save', revision: (await host.manager.describe()).revision, config });
  const previous = structuredClone([host.own.options.config, host.llm.options.config, [...host.keys]]);
  const edits = host.edits.length;
  for (const payload of [{ wrong: [] }, { data: [{ id: 'valid' }, null] }, { data: [{ id: '' }] }, { data: [{ id: 'invalid-limit', context_window: 10.5 }] }, { data: Array.from({ length: 513 }, (_, i) => ({ id: `x${i}` })) }]) {
    host.manager.fetch = async (url) => ({ ok: true, json: async () => url.endsWith('/api/hello') ? { name: 'magpie' } : payload });
    await assert.rejects(host.manager.handle({ action: 'sync-catalog', revision: saved.revision, config: saved.config }));
    assert.deepEqual([host.own.options.config, host.llm.options.config, [...host.keys]], previous);
    assert.equal(host.edits.length, edits);
  }
  host.manager.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(host.manager.handle({ action: 'sync-catalog', revision: saved.revision, config: saved.config }), /offline/);
  assert.deepEqual([host.own.options.config, host.llm.options.config, [...host.keys]], previous);
  host.manager.fetch = async (url) => ({ ok: true, json: async () => url.endsWith('/api/hello') ? { name: 'magpie' } : { data: [] } });
  const cleared = await host.manager.handle({ action: 'sync-catalog', revision: saved.revision, config: saved.config });
  assert.deepEqual(cleared.config.models, []);
  assert.deepEqual(host.own.options.config.models, []);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID], undefined);
  assert.equal(cleared.sync.count, 0);
});

test('全量同步下载期间其他页面修改配置时，锁内拒绝旧版本，保留新清单', async () => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const payload = new Promise((resolve) => { release = resolve; });
  const host = setup({ fetchImpl: async (url) => ({ ok: true, json: async () => {
    if (url.endsWith('/api/hello')) return { name: 'magpie' };
    started(); return payload;
  } }) });
  const initial = await host.manager.describe();
  const pending = host.manager.handle({ action: 'sync-catalog', revision: initial.revision, config: initial.config });
  await ready;
  await host.editor.edit(host.own, () => config);
  release({ data: [{ id: 'remote' }] });
  await assert.rejects(pending, (error) => error.status === 409);
  assert.deepEqual(host.own.options.config, config);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID], undefined);
  assert.equal(host.keys.size, 0);
});

test('保存完整配置、非法模型和缺少版本都须拒绝', async () => {
  const host = setup();
  const revision = (await host.manager.describe()).revision;
  await assert.rejects(host.manager.handle({ action: 'save', revision }), /完整/);
  await assert.rejects(host.manager.handle({ action: 'save', revision, config: { models: [{ id: '' }] } }), /模型 ID/);
  await assert.rejects(host.manager.handle({ action: 'save', config }), /重新载入/);
  assert.deepEqual(host.edits, []);
});

test('插件入口立即返回，等待宿主服务，释放路由，配置热更新不重启', async () => {
  // 关掉开机启动：真实 apply 会探测用户主目录下的 Magpie，测试不能启动真实程序。
  const quiet = { ...config, autoStart: false };
  const host = fakeHost(quiet);
  const pending = [];
  host.ctx.inject = (names, run) => pending.push({ names, run });
  assert.equal(apply(host.ctx, quiet), undefined);
  assert.equal(host.routes.length, 0);
  await pending.find((p) => p.names.includes('webServer')).run(host.ctx);
  await pending.find((p) => p.names.includes('configEditor')).run();
  assert.equal(host.routes.length, 2);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID].models[0].id, 'manual/unlisted');
  await host.editor.edit(host.own, (raw) => ({ ...raw, syncEnabled: false }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.llm.options.config.providers[PROVIDER_ID], undefined, '原始配置保存应就地同步');
  await host.ctx.dispose();
  assert.equal(host.routes.length, 0);
  assert.equal(host.hooks.length, 0);
});

test('关闭后的 manager 不再接受配置写入', async () => {
  const host = setup();
  host.manager.disposed = true;
  await assert.rejects(host.manager.handle({ action: 'save', revision: (await host.manager.describe()).revision, config }), /关闭/);
});

test('保存的程序路径是目录时保存成功、卡片仍可读取；本机占位标识不算已保存 Key', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-magpie-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'folder.exe');
  mkdirSync(folder);
  const host = setup({ backend: new MagpieBackend({ env: { DSH_MAGPIE_BACKEND_ROOT: root }, platform: 'win32', arch: 'x64', probe: async () => '0.1.0', isRunning: async () => false }) });
  const view = await host.manager.describe();
  const saved = await host.manager.handle({ action: 'save', revision: view.revision, config: { ...config, magpiePath: folder } });
  assert.equal(saved.saved, true);
  assert.match(saved.backend.reason, /普通文件/);
  const reloaded = await host.manager.describe();
  assert.equal(reloaded.config.magpiePath, folder);
  assert.equal(host.keys.get(KEY_REF), 'magpie-dsh');
  assert.equal(reloaded.keyConfigured, false);
});

test('手动排过序时，全量同步保留卡片上的顺序，新模型按名称接在末尾，标记保留', async () => {
  const catalog = { data: [{ id: 'p/zeta', display_name: 'Zeta' }, { id: 'p/new-b', display_name: 'New B' }, { id: 'p/alpha', display_name: 'Alpha' }, { id: 'p/new-a', display_name: 'New A' }] };
  const host = setup({ fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('/api/hello') ? { name: 'magpie' } : catalog }) });
  const initial = await host.manager.describe();
  // 卡片草稿里 Zeta 被拖到 Alpha 前；已删除的 gone 不会被带回。
  const draft = { ...initial.config, manualOrder: true, models: [{ id: 'p/zeta' }, { id: 'p/gone' }, { id: 'p/alpha' }] };
  const result = await host.manager.handle({ action: 'sync-catalog', revision: initial.revision, config: draft });
  assert.deepEqual(result.config.models.map((m) => m.id), ['p/zeta', 'p/alpha', 'p/new-a', 'p/new-b']);
  assert.equal(result.config.manualOrder, true);
  const automatic = await host.manager.handle({ action: 'sync-catalog', revision: result.revision, config: { ...result.config, manualOrder: false } });
  assert.deepEqual(automatic.config.models.map((m) => m.id), ['p/alpha', 'p/new-a', 'p/new-b', 'p/zeta']);
});

test('开关即时修改只接受白名单字段，不校验版本号也不带入草稿；同步开关改完立即重写分组', async () => {
  let lightweight = 0;
  // 替身程序管理：不读写真实的 Magpie 设置。
  const backend = { describe: async () => ({}), settings: () => ({ available: false }), ensureLightweight: () => { lightweight++; } };
  const host = setup({ backend });
  const before = await host.manager.describe();
  await host.manager.handle({ action: 'save', revision: before.revision, config });
  await assert.rejects(host.manager.handle({ action: 'patch', patch: { models: [] } }), /只能直接修改/);
  await assert.rejects(host.manager.handle({ action: 'patch', patch: {} }), /只能直接修改/);
  await assert.rejects(host.manager.handle({ action: 'patch', patch: { sidebarEntry: 'hidden' } }), /侧边栏入口/);
  const patched = await host.manager.handle({ action: 'patch', patch: { closeOnExit: true, sidebarEntry: 'never' } });
  assert.equal(patched.sync, undefined);
  assert.equal(host.own.options.config.closeOnExit, true);
  assert.equal(host.own.options.config.sidebarEntry, 'never');
  assert.equal(host.own.options.config.models[0].id, 'manual/unlisted', '清单不受影响');
  assert.equal(host.manager.config.closeOnExit, true);
  await host.manager.handle({ action: 'patch', patch: { autoLightweight: true } });
  assert.equal(lightweight, 1);
  const off = await host.manager.handle({ action: 'patch', patch: { syncEnabled: false } });
  assert.equal(off.sync.ok, true);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID], undefined);
  // 新版本号可直接用于后续保存。
  assert.equal((await host.manager.handle({ action: 'save', revision: off.revision, config: off.config })).saved, true);
});
