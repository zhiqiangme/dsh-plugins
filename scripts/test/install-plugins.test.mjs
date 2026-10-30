import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlugins } from '../install-plugins.mjs';

test('Magpie 可按别名与包名单独选择', () => {
  const [plugin] = resolvePlugins('magpie', 'install');
  assert.equal(plugin.name, '@zhiqiangme/dsh-magpie');
  assert.equal(plugin.folder, 'dsh-magpie');
  assert.deepEqual(resolvePlugins(plugin.name, 'install'), [plugin]);
});

test('Minimal Prompt 可按别名与包名单独选择', () => {
  const [plugin] = resolvePlugins('minimal-prompt', 'install');
  assert.equal(plugin.name, '@zhiqiangme/dsh-preset-minimal-prompt');
  assert.equal(plugin.folder, 'dsh-preset-minimal-prompt');
  assert.deepEqual(resolvePlugins(plugin.name, 'install'), [plugin]);
});

test('安装全部跳过停止维护的 OpenCode，显式安装仍可用', () => {
  const active = resolvePlugins('all', 'install');
  assert.deepEqual(active.map((p) => p.alias), ['workbuddy', 'tavily-search', 'magpie', 'minimal-prompt', 'presets-zh']);
  assert.equal(resolvePlugins('opencode2api', 'install')[0].maintained, false);
});

test('状态和卸载的全部仍包含旧插件，避免漏查或漏卸载', () => {
  for (const action of ['status', 'uninstall']) assert.equal(resolvePlugins('all', action).length, 6);
  assert.equal(resolvePlugins('magpie,magpie', 'install').length, 1);
  assert.throws(() => resolvePlugins('unknown', 'install'), /未知插件/);
});

test('中文预设与旧极简提示词是两个可并存的独立插件', () => {
  const plugins = resolvePlugins('presets-zh,minimal-prompt', 'install');
  assert.deepEqual(plugins.map(plugin => plugin.name), ['@zhiqiangme/dsh-presets-zh', '@zhiqiangme/dsh-preset-minimal-prompt']);
  assert.deepEqual(plugins[0].legacy, []);
  assert.notEqual(plugins[0].rowId, plugins[1].rowId);
});
