import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { modelSyncBlockReason, MODEL_SYNC_BUSY } from '../lib/model-sync-guard.js';
import { resolvePluginConfig } from '../lib/config.js';
import { syncModels } from '../lib/models.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

test('对话运行状态覆盖所有工作区和子代理，未知或读取失败时延后自动同步', () => {
  assert.equal(modelSyncBlockReason({ list: () => [] }), undefined);
  assert.equal(modelSyncBlockReason({ list: () => [{ status: 'idle' }] }), undefined);
  assert.equal(modelSyncBlockReason({ list: () => [{ status: 'idle' }, { status: 'running' }] }), MODEL_SYNC_BUSY);
  for (const registry of [undefined, {}, { list: () => undefined }, { list: () => [{ status: 'unknown' }] }, { list: () => { throw new Error('unavailable'); } }]) {
    assert.match(modelSyncBlockReason(registry), /状态暂不可用/);
  }
});

for (const hubDual of [false, true]) {
  for (const startAt of ['before-sync', 'during-fetch', 'waiting-for-editor']) {
    test(`${hubDual ? '双区域' : '单区域'}：对话在 ${startAt} 开始后不写 provider，空闲后重新拉取目录`, async (t) => {
      const agent = { status: startAt === 'before-sync' ? 'running' : 'idle' };
      let startDuringFetch = startAt === 'during-fetch';
      let hits = 0;
      let entries = [{ id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' }];
      const server = createServer((req, res) => {
        hits++;
        if (startDuringFetch) agent.status = 'running';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ realm: req.headers['x-realm'] || 'cn', data: entries }));
      });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
      const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, hubDual, baseURL: `http://127.0.0.1:${server.address().port}` } }, {});
      resolved.models.hubProxyBaseURL = 'http://127.0.0.1:8787/plugins/test/hub/v1/';
      const editor = createFakeConfigEditor(profileRows());
      const credentials = createFakeCredentials();
      const original = structuredClone(editor.entry('llm-pi-ai').options.config);
      const edit = editor.edit.bind(editor);
      if (startAt === 'waiting-for-editor') editor.edit = (entry, change) => {
        agent.status = 'running';
        return edit(entry, change);
      };
      const options = { spec: resolved.spec, models: resolved.models, editor, credentials, env: {}, syncBlocker: () => modelSyncBlockReason({ list: () => [agent] }) };
      assert.equal((await syncModels(options)).state, 'busy');
      assert.deepEqual(editor.entry('llm-pi-ai').options.config, original);
      assert.equal(editor.edits.length, 0);
      assert.equal(credentials.sets.length, 0);
      if (startAt === 'before-sync') assert.equal(hits, 0, '已知运行中时不拉目录');

      editor.edit = edit;
      agent.status = 'idle';
      // 更换目录，确保后续同步不会应用运行前的旧快照。
      entries = [{ id: 'fresh', name: 'Fresh' }];
      startDuringFetch = false;
      const before = hits;
      assert.equal((await syncModels(options)).state, 'updated');
      assert.ok(hits > before);
      assert.deepEqual(editor.entry('llm-pi-ai').options.config.providers.workbuddy.models.map((m) => m.id), hubDual ? ['cn:fresh', 'global:fresh'] : ['fresh']);
    });
  }
}
