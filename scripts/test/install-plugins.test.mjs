import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlugins } from '../install-plugins.mjs';

test('Magpie 可按别名与包名单独选择', () => {
  const [plugin] = resolvePlugins('magpie', 'install');
  assert.equal(plugin.name, '@zhiqiangme/dsh-magpie');
  assert.equal(plugin.folder, 'dsh-magpie');
  assert.deepEqual(resolvePlugins(plugin.name, 'install'), [plugin]);
});

test('Minimal Plus 可按别名与包名单独选择', () => {
  const [plugin] = resolvePlugins('minimal-plus', 'install');
  assert.equal(plugin.name, '@zhiqiangme/dsh-preset-minimal-plus');
  assert.equal(plugin.folder, 'dsh-preset-minimal-plus');
  assert.deepEqual(resolvePlugins(plugin.name, 'install'), [plugin]);
});

test('安装全部跳过停止维护的 OpenCode，显式安装仍可用', () => {
  const active = resolvePlugins('all', 'install');
  assert.deepEqual(active.map((p) => p.alias), ['workbuddy', 'tavily-search', 'magpie', 'minimal-plus']);
  assert.equal(resolvePlugins('opencode2api', 'install')[0].maintained, false);
});

test('状态和卸载的全部仍包含旧插件，避免漏查或漏卸载', () => {
  for (const action of ['status', 'uninstall']) assert.equal(resolvePlugins('all', action).length, 5);
  assert.equal(resolvePlugins('magpie,magpie', 'install').length, 1);
  assert.throws(() => resolvePlugins('unknown', 'install'), /未知插件/);
});
