import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { confirmRemovals, fetchModels, missingSelectedModels, pendingPruned, prunableSelection, restorePruned, syncModels } from '../lib/models.js';
import { applySelection, describeModels, pruneMissingSelection, restorePrunedSelection } from '../lib/web.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

const FLASH = { id: 'flash', name: 'Flash', credits: 'x0' };
const KIMI = { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', credits: 'x0.97', context_length: 1000000 };
const OTHER = { id: 'other', name: 'Other', credits: 'x1' };

/** 写进 DSH 的 id：双区域都是 auto:，单区域 hub 是裸 id，wb2api 带区域前缀。 */
const listedId = (mode, id) => ({ dual: `auto:${id}`, hub: id, wb2api: `cn:${id}` })[mode];

async function fixture(t, mode, { all = false } = {}) {
  const state = { data: [FLASH, KIMI], others: [FLASH, KIMI], catalog: { source: 'remote', fetched_at: 100, ignored: 'do-not-forward' } };
  const dual = mode === 'dual';
  const hub = mode !== 'wb2api';
  const server = createServer((req, res) => {
    const realm = req.headers['x-realm'] || 'cn';
    // GL 也有同名 Kimi：不能拿它代替 CN 的缺项。
    const list = realm === 'cn' ? state.data : state.others;
    const data = hub ? list : list.map((model) => ({ ...model, id: `cn:${model.id}` }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data, ...(hub ? { realm, catalog: realm === 'cn' ? state.catalog : state.othersCatalog ?? state.catalog } : {}) }));
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
    const kimiId = listedId(mode, KIMI.id);
    assert.equal(provider().models.find((model) => model.id === kimiId).contextWindow, 2000000);
    assert.equal((await describeModels({ ...options, gateway: resolved.gateway })).models.some((row) => row.unavailable), false);

    state.data = [FLASH];
    const removed = await applySelection({ resolved, editor, credentials, env: {}, only: resolved.models.only.filter((id) => id !== 'cn:kimi-k3.1-pro') });
    assert.equal(removed.sync.state, 'updated');
    assert.ok(!provider().models.some((model) => model.id === kimiId), '显式取消仍能移除缺席模型');
  });

  test(`${mode}：持配置锁前新增的已选模型也受保护`, async (t) => {
    const { state, editor, options, provider } = await fixture(t, mode);
    const kimiId = listedId(mode, KIMI.id);
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

  test(`${mode}：手动刷新以当前目录为准，当轮移除缺席的已选模型并剔除白名单，重新列出后补回`, async (t) => {
    const { state, resolved, editor, options, provider } = await fixture(t, mode);
    const kimiId = listedId(mode, KIMI.id);
    state.data = [FLASH];
    state.catalog.fetched_at += 300;
    assert.equal((await syncModels({ ...options, removalGuard: {} })).state, 'deferred', '自动同步仍保留缺席模型');

    const panel = await describeModels({ ...options, gateway: resolved.gateway });
    const payload = await pruneMissingSelection({ resolved, editor, gateway: resolved.gateway, payload: panel });
    assert.deepEqual(payload.pruned.map((row) => row.id), ['cn:kimi-k3.1-pro']);
    assert.match(payload.pruned[0].label, /Kimi/);
    assert.ok(!payload.models.some((row) => row.unavailable));
    assert.ok(!payload.only.includes('cn:kimi-k3.1-pro'));
    assert.deepEqual(editor.entry('dsh-autostart-workbuddy').options.config.models.only, payload.only);
    assert.deepEqual(resolved.models.only, payload.only);
    // 手动那一轮不带移除确认；同一份缓存目录也当轮生效。
    assert.equal((await syncModels({ ...options, models: resolved.models })).state, 'updated');
    assert.ok(!provider().models.some((model) => model.id === kimiId));
    assert.equal((await syncModels({ ...options, models: resolved.models, removalGuard: {} })).state, 'unchanged', '之后的自动同步不再拦');

    // 期间显式保存其它勾选：面板不回传剔除项，记录仍保留。
    const saved = await applySelection({ resolved, editor, credentials: options.credentials, env: {}, only: payload.only });
    assert.equal(saved.ok, true);
    assert.deepEqual(resolved.models.pruned, ['cn:kimi-k3.1-pro']);

    state.data = [FLASH, KIMI];
    const back = await restorePrunedSelection({ resolved, editor, gateway: resolved.gateway, payload: await describeModels({ ...options, models: resolved.models, gateway: resolved.gateway }) });
    assert.deepEqual(back.restored.map((row) => row.id), ['cn:kimi-k3.1-pro']);
    assert.equal(back.models.find((row) => row.id === 'cn:kimi-k3.1-pro').selected, true);
    assert.ok(back.only.includes('cn:kimi-k3.1-pro'));
    assert.deepEqual(editor.entry('dsh-autostart-workbuddy').options.config.models.only, back.only);
    assert.deepEqual(resolved.models.pruned, []);
    assert.equal((await syncModels({ ...options, models: resolved.models })).state, 'updated');
    assert.ok(provider().models.some((model) => model.id === kimiId), '补回的模型重新写进 DSH');
  });

  test(`${mode}：某个范围的勾选全部缺席时手动刷新也保留，不变成同步全部`, async (t) => {
    const { state, resolved, editor, options, provider } = await fixture(t, mode);
    const before = structuredClone(provider());
    const only = [...resolved.models.only];
    state.data = [OTHER];
    const panel = await describeModels({ ...options, gateway: resolved.gateway });
    const payload = await pruneMissingSelection({ resolved, editor, gateway: resolved.gateway, payload: panel });
    assert.equal(payload.pruned, undefined);
    assert.deepEqual(payload.models.filter((row) => row.unavailable).map((row) => row.id), ['cn:flash', 'cn:kimi-k3.1-pro']);
    assert.deepEqual(editor.entry('dsh-autostart-workbuddy').options.config.models.only, only);
    const synced = await syncModels(options);
    assert.equal(synced.state, 'deferred', '保留的勾选照常受缺席保护');
    assert.match(synced.reason, /cn:flash/);
    assert.deepEqual(provider(), before);
  });

  test(`${mode}：显式排除和目录可用时的筛选规则仍能移除模型`, async (t) => {
    const { state, options, provider } = await fixture(t, mode);
    const kimiId = listedId(mode, KIMI.id);
    state.data = [FLASH];
    options.models.exclude = [mode === 'hub' ? KIMI.id : `cn:${KIMI.id}`];
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
    state.others = [FLASH];
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
    assert.ok(!provider().models.some((model) => model.id === listedId(mode, KIMI.id)));
  });
}

test('dual：跟随全部时只有一个出口缺这个模型，条目还在就不算移除，只是少一个出口', async (t) => {
  const { state, options, provider } = await fixture(t, 'dual', { all: true });
  const kimi = () => provider().models.find((model) => model.id === listedId('dual', KIMI.id));
  assert.match(kimi().name, / Auto /);
  state.data = [FLASH];
  assert.equal((await syncModels({ ...options, removalGuard: {} })).state, 'updated');
  assert.match(kimi().name, / GL /);
});

test('dual：跟随全部时 CN / GL 目录错开刷新也能确认下架，不会一直卡住', async (t) => {
  const { state, options, provider } = await fixture(t, 'dual', { all: true });
  const guard = {};
  const sync = () => syncModels({ ...options, removalGuard: guard });
  state.data = [FLASH];
  state.others = [FLASH];
  state.othersCatalog = { source: 'remote', fetched_at: 160 };
  assert.equal((await sync()).state, 'deferred');
  // 同一轮里只有 CN 换了新目录；要两边同一轮都换才算确认的话，错开的两个缓存永远等不到。
  state.catalog = { source: 'remote', fetched_at: 400 };
  assert.equal((await sync()).state, 'updated');
  assert.ok(!provider().models.some((model) => model.id === listedId('dual', KIMI.id)));
});

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

test('手动刷新只剔除不会让范围变成同步全部的缺席勾选', () => {
  assert.deepEqual(prunableSelection(['cn:a', 'cn:b', 'global:c'], ['cn:a'], true), ['cn:a']);
  assert.deepEqual(prunableSelection(['cn:a', 'global:c'], ['cn:a'], true), [], 'hub 按区域生效：CN 唯一的勾选不剔除');
  assert.deepEqual(prunableSelection(['cn:a', 'global:c'], ['cn:a'], false), ['cn:a'], 'wb2api 整张白名单一起生效');
  assert.deepEqual(prunableSelection(['cn:a'], ['cn:a'], false), []);
  assert.deepEqual(prunableSelection(['cn:a', 'cn:b'], ['cn:x'], true), [], '不在白名单里的缺席项不算');
});

test('剔除记录：回到目录才补回；已勾回或所在范围改成同步全部的不再记', () => {
  assert.deepEqual(pendingPruned(['cn:a', 'global:b'], ['cn:x'], true), ['cn:a'], 'GL 改成同步全部后不再补回 global:b');
  assert.deepEqual(pendingPruned(['cn:a'], ['cn:a', 'cn:x'], true), [], '已勾回');
  assert.deepEqual(pendingPruned(['cn:a'], [], false), [], 'wb2api 整张白名单清空即同步全部');
  assert.deepEqual(restorePruned(['cn:x'], ['cn:a', 'cn:b'], ['cn:a', 'cn:x'], true), { only: ['cn:x', 'cn:a'], pruned: ['cn:b'], restored: ['cn:a'] });
  assert.deepEqual(restorePruned([], ['cn:a'], ['cn:a'], true), { only: [], pruned: [], restored: [] }, '同步全部时只清记录');
});

test('目录来源只透传同步确认字段', async (t) => {
  const { options } = await fixture(t, 'hub');
  const result = await fetchModels({ baseURL: options.models.baseURL });
  assert.deepEqual(result.catalog, { source: 'remote', fetched_at: 100 });
});
