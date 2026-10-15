import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratePluginRows } from '../plugin-row-migration.mjs';

const plugin = { rowId: 'dsh-opencode2api', name: '@zhiqiangme/dsh-opencode2api', legacyRowIds: ['dsh-autostart-opencode2api'], legacy: ['@zhiqiangme/dsh-autostart-opencode2api'] };
test('包名和行 id 一起迁移，保留同步开关、白名单及 CRLF；重复运行不改动', () => {
  const before = "# settings\r\n- id: dsh-autostart-opencode2api # keep id comment\r\n  name: '@zhiqiangme/dsh-autostart-opencode2api' # keep name comment\r\n  config:\r\n    models:\r\n      enabled: true\r\n      only: [deepseek-free]\r\n";
  const result = migratePluginRows(before, [plugin]);
  assert.equal(result.text, before.replaceAll('dsh-autostart-opencode2api', 'dsh-opencode2api'));
  assert.deepEqual(result.migrated, [plugin.rowId]);
  assert.deepEqual(migratePluginRows(result.text, [plugin]), { text: result.text, migrated: [] });
});
test('仅按 id 覆盖的行和以 name 开头的旧行均能迁移', () => {
  for (const before of ['- id: dsh-autostart-opencode2api\n  config: {}\n', "- name: '@zhiqiangme/dsh-autostart-opencode2api'\n  id: dsh-autostart-opencode2api\n"]) {
    assert.equal(migratePluginRows(before, [plugin]).text, before.replaceAll('dsh-autostart-opencode2api', 'dsh-opencode2api'));
  }
});
test('不修改同 id 的外部插件或非本次迁移的行', () => {
  const before = "- id: dsh-autostart-opencode2api\n  name: someone-else\n- id: other\n  name: other\n";
  assert.deepEqual(migratePluginRows(before, [plugin]), { text: before, migrated: [] });
});
test('仍支持 WorkBuddy 旧包名迁移，拒绝新旧行重复以免覆盖用户配置', () => {
  const workbuddy = { rowId: 'dsh-autostart-workbuddy', name: '@zhiqiangme/dsh-autostart-workbuddy', legacy: ['dsh-autostart-workbuddy'] };
  assert.equal(migratePluginRows('- id: dsh-autostart-workbuddy\n  name: dsh-autostart-workbuddy\n', [workbuddy]).text, "- id: dsh-autostart-workbuddy\n  name: '@zhiqiangme/dsh-autostart-workbuddy'\n");
  assert.throws(() => migratePluginRows('- id: dsh-autostart-opencode2api\n- id: dsh-opencode2api\n', [plugin]), /同时存在/);
});
