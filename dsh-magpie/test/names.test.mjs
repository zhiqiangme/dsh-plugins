import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_NAMES, displayModelName } from '../lib/names.js';
import { modelEntries } from '../lib/models.js';
import { resolveConfig } from '../lib/config.js';
import { clientHarness } from '../fixtures/client.mjs';

test('前端预览和 DSH 同步使用相同供应商简称，区分 WorkBuddy 国内与国际版', () => {
  const client = clientHarness();
  const names = {
    workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy GL', 'opencode-zen-free': 'OpenCode',
    'qoder-cn': 'Qoder', qoder: 'Qoder GL', 'trae-cn': 'Trae', 'trae-global': 'Trae GL',
    zcode: 'ZCode', 'mimo-app': 'MiMo', 'commandcode-plan': 'CommandCode', cline: 'Cline', codex: 'Codex',
  };
  for (const [id, shortName] of Object.entries(names)) {
    const row = { id: `${id}/deepseek-v4.1-flash`, name: 'DeepSeek V4.1 Flash' };
    const expected = `DeepSeek V4.1 Flash ${shortName}`;
    assert.equal(displayModelName(row), expected);
    assert.equal(client.module.displayModelName(row, PROVIDER_NAMES), expected);
  }
});

test('重复同步不叠加简称，手工名称、完整 ID、排序及勾选原样保存', () => {
  const config = resolveConfig({ models: [
    { id: 'workbuddy/model', name: 'DeepSeek V4.1 Flash' },
    { id: 'workbuddy-ai/model', name: 'DeepSeek V4.1 Flash WorkBuddy GL' },
    { id: 'opencode-zen-free/model', name: 'DeepSeek V4.1 Flash opencode' },
    { id: 'qoder-cn/unselected', enabled: false },
  ] });
  const before = structuredClone(config);
  const entries = modelEntries(config);
  assert.deepEqual(config, before);
  assert.deepEqual(entries.map((row) => row.id), ['workbuddy/model', 'workbuddy-ai/model', 'opencode-zen-free/model']);
  assert.deepEqual(entries.map((row) => row.name), ['DeepSeek V4.1 Flash WorkBuddy', 'DeepSeek V4.1 Flash WorkBuddy GL', 'DeepSeek V4.1 Flash opencode']);
  assert.deepEqual(modelEntries(config), entries);
});

test('未知供应商、路由组和空白新条目不猜供应商，已含简称不会重复追加', () => {
  const client = clientHarness();
  for (const row of [
    { id: 'my-routing-group', name: '自动选路' }, { id: 'group/custom', name: '自定义' },
    { id: 'constructor/custom', name: '未知供应商' }, { id: 'toString/model', name: '未知模型' },
    { id: '', name: '' }, { id: 'workbuddy/model', name: 'WorkBuddy' },
    { id: 'workbuddy-ai/model', name: 'Some WorkBuddy GL' },
  ]) {
    assert.equal(displayModelName(row), row.name);
    assert.equal(client.module.displayModelName(row, PROVIDER_NAMES), row.name);
  }
});
