import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { confirmRemovals, fetchModels, missingSelectedModels, syncModels } from '../lib/models.js';
import { applySelection, describeModels } from '../lib/web.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

const FLASH = { id: 'flash', name: 'Flash', credits: 'x0' };
const KIMI = { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', credits: 'x0.97', context_length: 1000000 };

async function fixture(t, mode, { all = false } = {}) {
  const state = { data: [FLASH, KIMI], catalog: { source: 'remote', fetched_at: 100, ignored: 'do-not-forward' } };
  const dual = mode === 'dual';
  const hub = mode !== 'wb2api';
  const server = createServer((req, res) => {
    const realm = req.headers['x-realm'] || 'cn';
    // GL 也有同名 Kimi：不能拿它代替 CN 的缺项。
    const list = realm === 'cn' ? state.data : [FLASH, KIMI];
    const data = hub ? list : list.map((model) => ({ ...model, id: `cn:${model.id}` }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data, ...(hub ? { realm, catalog: state.catalog } : {}) }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const only = all ? [] : ['cn:flash', 'cn:kimi-k3.1-pro', ...(dual ? ['global:flash'] : [])];
  const resolved = resolvePluginConfig({ gateway: hub ? 'hub' : 'wb2api', models: {
    enabled: true, hubDual: dual, only, baseURL: `http://127.0.0.1:${server.address().port}`,
  } }, {});
  resolved.models.hubProxyBaseURL = 'http://127.0.0.1:8787/plugins/test/hub/v1/';
  const editor = createFakeConfigEditor(profileRows({ models: { enabled: true, only } }));
  const credentials = createFakeCredentials();
  const options = { spec: resolved.spec, models: resolved.models, editor, credentials, env: {} };
  const provider = () => editor.entry('llm-pi-ai').options.config.providers.workbuddy;
  assert.equal((await syncModels(options)).state, 'updated');
  return { state, resolved, editor, credentials, options, provider };
}

for (const mode of ['dual', 'hub', 'wb2api']) {
  test(`${mode}：Kimi 缩水目录持续多批、重复保存及重启同步都不删已选模型`, async (t) => {
    const { state, resolved, editor, credentials, options, provider } = await fixture(t, mode);
    const before = structuredClone(provider());
    const writes = editor.edits.length;
    const keyWrites = credentials.sets.length;
    const guard = {};
    state.data = [FLASH];
    for (let i = 0; i < 6; i++) {
      state.catalog.fetched_at += 300;
      const result = await syncModels({ ...options, removalGuard: guard });
      assert.equal(result.state, 'deferred');
      assert.match(result.reason, /cn:kimi-k3\.1-pro/);
      assert.deepEqual(provider(), before);
    }
    assert.equal((await syncModels(options)).state, 'deferred', '启动时没有 guard 也要保护');
    const saved = await applySelection({ resolved, editor, credentials, env: {}, only: resolved.models.only });
    assert.equal(saved.ok, true);
    assert.equal(saved.sync.state, 'deferred');
    assert.equal(editor.edits.length, writes);
    assert.equal(credentials.sets.length, keyWrites);
    assert.deepEqual(provider(), before);

    const panel = await describeModels({ ...options, gateway: resolved.gateway });
    const missing = panel.models.find((row) => row.id === 'cn:kimi-k3.1-pro');
    assert.equal(missing.unavailable, true);
    assert.equal(missing.selected, true);
    assert.match(missing.label, /Kimi/);
    assert.equal(missing.price, null);
    assert.equal(missing.credits, undefined);
    assert.ok(!panel.models.some((row) => row.unavailable && row.id.startsWith('global:')));

    state.data = [FLASH, { ...KIMI, context_length: 2000000 }];
    assert.equal((await syncModels(options)).state, 'updated');
    const kimiId = mode === 'hub' ? KIMI.id : `cn:${KIMI.id}`;
    assert.equal(provider().models.find((model) => model.id === kimiId).contextWindow, 2000000);
    assert.equal((await describeModels({ ...options, gateway: resolved.gateway })).models.some((row) => row.unavailable), false);

    state.data = [FLASH];
    const removed = await applySelection({ resolved, editor, credentials, env: {}, only: resolved.models.only.filter((id) => id !== 'cn:kimi-k3.1-pro') });
    assert.equal(removed.sync.state, 'updated');
    assert.ok(!provider().models.some((model) => model.id === kimiId), '显式取消仍能移除缺席模型');
  });

  test(`${mode}：持配置锁前新增的已选模型也受保护`, async (t) => {
    const { state, editor, options, provider } = await fixture(t, mode);
    const kimiId = mode === 'hub' ? KIMI.id : `cn:${KIMI.id}`;
    const kimi = provider().models.find((model) => model.id === kimiId);
    provider().models = provider().models.filter((model) => model.id !== kimiId);
    state.data = [{ ...FLASH, name: 'Changed Flash' }];
    const edit = editor.edit.bind(editor);
    editor.edit = (entry, change) => {
      provider().models.push(kimi);
      return edit(entry, change);
    };
    assert.equal((await syncModels(options)).state, 'deferred');
    assert.ok(provider().models.some((model) => model.id === kimiId));
    assert.ok(!provider().models.some((model) => model.name.startsWith('Changed Flash')));
  });

  test(`${mode}：显式排除和目录可用时的筛选规则仍能移除模型`, async (t) => {
    const { state, options, provider } = await fixture(t, mode);
    const kimiId = mode === 'hub' ? KIMI.id : `cn:${KIMI.id}`;
    state.data = [FLASH];
    options.models.exclude = [kimiId];
    assert.equal((await syncModels(options)).state, 'updated');
    assert.ok(!provider().models.some((model) => model.id === kimiId));
    options.models.exclude = [];
    state.data = [FLASH, KIMI];
    assert.equal((await syncModels(options)).state, 'updated');
    options.models.rules = { freeOnly: true };
    assert.equal((await syncModels(options)).state, 'updated');
    assert.ok(!provider().models.some((model) => model.id === kimiId));
  });
}

for (const mode of ['dual', 'hub']) {
  test(`${mode}：跟随全部时同一缓存不重复确认，降级来源不确认下架`, async (t) => {
    const { state, options, provider } = await fixture(t, mode, { all: true });
    const guard = {};
    const sync = () => syncModels({ ...options, removalGuard: guard });
    const before = structuredClone(provider());
    state.data = [FLASH];
    for (let i = 0; i < 6; i++) assert.equal((await sync()).state, 'deferred');
    assert.deepEqual(provider(), before);
    for (const source of ['cache', 'legacy', 'bundled', 'endpoint']) {
      state.catalog = { source, fetched_at: state.catalog.fetched_at + 300 };
      assert.equal((await sync()).state, 'deferred');
      assert.equal((await sync()).state, 'deferred');
    }
    state.catalog = { source: 'remote', fetched_at: state.catalog.fetched_at + 300 };
    assert.equal((await sync()).state, 'deferred');
    state.catalog.fetched_at += 300;
    assert.equal((await sync()).state, 'updated');
    assert.ok(!provider().models.some((model) => model.id === (mode === 'dual' ? `cn:${KIMI.id}` : KIMI.id)));
  });
}

test('目录确认：旧时间戳不能确认；同批恢复会清掉该模型的缺席记录', () => {
  const guard = {};
  const check = (ids, at) => confirmRemovals(guard, ['a', 'b'], ids, { source: 'remote', fetched_at: at }).ok;
  assert.equal(check(['a'], 10), false);
  assert.equal(check(['a'], 9), false);
  assert.equal(check(['a', 'b'], 10), true);
  assert.equal(check(['a'], 10), false);
  assert.equal(check(['a'], 11), false, '同批恢复过，必须重新开始确认');
  assert.equal(check(['a'], 12), true);
});

test('缺席检测遵守区域及排除，空白名单不制造缺席条目', () => {
  const catalog = [{ id: 'flash', realm: 'cn' }];
  assert.deepEqual(missingSelectedModels(catalog, ['global:kimi', 'cn:kimi', 'flash'], 'cn'), ['cn:kimi']);
  assert.deepEqual(missingSelectedModels(catalog, ['cn:kimi'], 'cn', ['kimi']), []);
  assert.deepEqual(missingSelectedModels([{ id: 'cn:flash' }], ['cn:kimi'], undefined, ['kimi']), ['cn:kimi'], 'wb2api 的排除项仍须使用完整 id');
  assert.deepEqual(missingSelectedModels(catalog, [], 'cn'), []);
});

test('目录来源只透传同步确认字段', async (t) => {
  const { options } = await fixture(t, 'hub');
  const result = await fetchModels({ baseURL: options.models.baseURL });
  assert.deepEqual(result.catalog, { source: 'remote', fetched_at: 100 });
});
