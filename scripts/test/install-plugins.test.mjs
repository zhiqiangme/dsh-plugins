import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { desktopExeFrom, resolvePlugins } from '../install-plugins.mjs';

test('Magpie 可按别名与包名单独选择', () => {
  const [plugin] = resolvePlugins('magpie');
  assert.equal(plugin.name, '@zhiqiangme/dsh-magpie');
  assert.equal(plugin.folder, 'dsh-magpie');
  assert.deepEqual(resolvePlugins(plugin.name), [plugin]);
});

test('全部即维护中的插件，重复选择只算一次', () => {
  assert.deepEqual(resolvePlugins('all').map((p) => p.alias), ['workbuddy', 'tavily-search', 'magpie', 'presets-zh']);
  assert.equal(resolvePlugins('magpie,magpie').length, 1);
});

test('停止维护的插件改由各自目录内的脚本安装，这里不再受理', () => {
  for (const alias of ['opencode2api', 'minimal-prompt', 'unknown']) assert.throws(() => resolvePlugins(alias), /未知插件/);
});

test('安装中文预设不会移除旧极简提示词', () => {
  assert.deepEqual(resolvePlugins('presets-zh')[0].legacy, []);
});

// desktopExeFrom 只处理 Windows 的 dsh.cmd 路径；POSIX 的 resolve 会把盘符当成相对路径。
test('桌面版 exe 从 dsh.cmd 的安装目录推导', { skip: process.platform !== 'win32' }, () => {
  const cli = join('C:', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  assert.equal(desktopExeFrom(cli), join('C:', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
});
