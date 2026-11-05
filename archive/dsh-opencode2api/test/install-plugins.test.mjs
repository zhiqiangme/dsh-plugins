import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN } from '../scripts/install-plugins.mjs';

const pluginDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = (args, env = {}) => spawnSync(
  process.execPath,
  [join(pluginDir, 'scripts', 'install-plugins.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } },
);

test('安装脚本管理的是本目录的插件', () => {
  assert.equal(PLUGIN.name, JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name);
  assert.equal(PLUGIN.dir.replace(/[\\/]+$/, ''), pluginDir);
});

test('安装脚本不接受选择其他插件的参数', () => {
  const result = run(['--action', 'status', '--plugins', 'tavily-search']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /--plugins/);
});

test('查看状态只列出本插件，不碰 profile 里的其他插件', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { '@zhiqiangme/dsh-tavily-search': '26.10.28' } }));
  // 查看状态不调用 dsh，DSH_CLI 只需指向一个存在的文件
  const result = run(['--action', 'status', '--profiles', 'web'], { DSH_HOME: home, DSH_CLI: process.execPath });
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${PLUGIN.name}\\s+未安装`));
  assert.doesNotMatch(result.stdout, /dsh-tavily-search/);
});
