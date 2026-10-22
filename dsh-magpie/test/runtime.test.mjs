import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelManager } from '../lib/runtime.js';
import { KEY_REF, PROVIDER_ID } from '../lib/config.js';
import { apply } from '../lib/index.js';
import { fakeHost } from '../fixtures/host.mjs';

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

test('导入是可选读取，不保存、不推理、不删除已有自定义清单；错误身份拒绝导入', async () => {
  const calls = [];
  const host = setup({ fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => url.endsWith('/api/hello') ? { name: 'magpie', version: 'test' } : { data: [{ id: 'imported/a' }] } }; } });
  const result = await host.manager.handle({ action: 'import' });
  assert.equal(result.models[0].id, 'imported/a');
  assert.equal(result.models[0].enabled, false);
  assert.deepEqual(host.own.options.config, {});
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/api/hello', '/v1/models']);
  host.manager.fetch = async () => ({ ok: true, json: async () => ({ name: 'other-app' }) });
  await assert.rejects(host.manager.handle({ action: 'import' }), /身份/);
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
  const host = fakeHost(config);
  const pending = [];
  host.ctx.inject = (names, run) => pending.push({ names, run });
  assert.equal(apply(host.ctx, config), undefined);
  assert.equal(host.routes.length, 0);
  await pending.find((p) => p.names.includes('webServer')).run(host.ctx);
  await pending.find((p) => p.names.includes('configEditor')).run();
  assert.equal(host.routes.length, 1);
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
