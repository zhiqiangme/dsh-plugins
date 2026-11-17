import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { desktopExeFrom, installInto, resolvePlugins } from '../install-plugins.mjs';

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

/** 只复制会被打包的文件，避免把开发依赖带入临时 profile。 */
function copyPlugin(plugin, profileDir) {
  const manifest = JSON.parse(readFileSync(join(plugin.dir, 'package.json'), 'utf8'));
  const targets = new Set(['package.json', ...manifest.files.map((pattern) => pattern.includes('*') ? dirname(pattern) : pattern)]);
  const installed = join(profileDir, 'node_modules', plugin.name);
  mkdirSync(installed, { recursive: true });
  for (const target of targets) cpSync(join(plugin.dir, target), join(installed, target), { recursive: true });
}

/** 用临时 profile 和包管理器替身跑完整安装流程，不调用真实 DSH 或 pnpm。 */
function installFixture(t, manifest) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-install-state-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const dir = join(home, 'profiles', 'web');
  const file = join(dir, 'package.json');
  mkdirSync(dir, { recursive: true });
  const write = (value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  const read = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (manifest) write(manifest);
  const calls = [];
  const runPlugin = (profile, [action, ...args]) => {
    assert.equal(profile, 'web');
    calls.push([action, ...args]);
    const current = read();
    current.dependencies ??= {};
    current.dsh ??= {};
    current.dsh.profile ??= {};
    current.dsh.profile.bundles ??= [];
    if (action === 'remove') {
      for (const name of args) delete current.dependencies[name];
      current.dsh.profile.bundles = current.dsh.profile.bundles.filter((name) => !args.includes(name));
    } else {
      assert.equal(action, 'add');
      assert.ok(args.length > 0, '不能空跑 add');
      for (const spec of args) {
        const plugin = resolvePlugins('all').find((item) => spec === `file:${item.dir}`);
        assert.ok(plugin, `未知安装来源：${spec}`);
        if (!(plugin.name in current.dependencies)) current.dsh.profile.bundles.push(plugin.name);
        current.dependencies[plugin.name] = spec;
        copyPlugin(plugin, dir);
      }
      current.packageManager = 'pnpm@11.28.5';
    }
    write(current);
    return true;
  };
  return { dir, read, write, calls, host: { waitIdle: async () => true, runPlugin } };
}

test('混合更新保留停用、启用和首次安装状态，以及 CLI 写入的最新元数据', async (t) => {
  const [disabled, enabled, fresh] = resolvePlugins('workbuddy,magpie,presets-zh');
  const fixture = installFixture(t, {
    dependencies: { [disabled.name]: '26.1.1', [enabled.name]: '26.1.1', other: '1.0.0' },
    dsh: { profile: { bundles: ['base', enabled.name, 'base'], custom: true } },
    private: true,
  });
  const config = '# keep config\r\n- id: dsh-autostart-workbuddy\r\n  config:\r\n    enabled: true\r\n';
  writeFileSync(join(fixture.dir, 'cordis.patch.yml'), config);
  assert.equal(await installInto('web', [disabled, enabled, fresh], fixture.host), true);
  const after = fixture.read();
  assert.deepEqual(after.dsh.profile.bundles, ['base', 'base', enabled.name, fresh.name]);
  assert.equal(after.dependencies[disabled.name], `file:${disabled.dir}`);
  assert.equal(after.dependencies.other, '1.0.0');
  assert.equal(after.packageManager, 'pnpm@11.28.5');
  assert.equal(after.dsh.profile.custom, true);
  assert.equal(after.private, true);
  assert.equal(readFileSync(join(fixture.dir, 'cordis.patch.yml'), 'utf8'), config);
  assert.deepEqual(fixture.calls, [
    ['remove', disabled.name, enabled.name],
    ['add', ...[disabled, enabled, fresh].map((plugin) => `file:${plugin.dir}`)],
  ]);
});

test('代码已是最新的停用插件无需重装或改写 manifest', async (t) => {
  const [plugin] = resolvePlugins('magpie');
  const before = { dependencies: { [plugin.name]: `file:${plugin.dir}` }, dsh: { profile: { bundles: ['base'] } } };
  const fixture = installFixture(t, before);
  copyPlugin(plugin, fixture.dir);
  assert.equal(await installInto('web', [plugin], fixture.host), true);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.read(), before);
});

for (const enabled of [false, true]) {
  test(`旧包名迁移保留${enabled ? '启用' : '停用'}状态`, async (t) => {
    const [plugin] = resolvePlugins('workbuddy');
    const old = plugin.legacy[0];
    const fixture = installFixture(t, {
      dependencies: { [old]: 'file:D:/old-workbuddy' },
      dsh: { profile: { bundles: enabled ? ['base', old] : ['base'] } },
    });
    assert.equal(await installInto('web', [plugin], fixture.host), true);
    const after = fixture.read();
    assert.equal(old in after.dependencies, false);
    assert.equal(after.dsh.profile.bundles.includes(plugin.name), enabled);
  });
}

test('清理残留旧包时不重新启用已是最新的当前包，也不空跑 add', async (t) => {
  const [plugin] = resolvePlugins('workbuddy');
  const old = plugin.legacy[0];
  const fixture = installFixture(t, {
    dependencies: { [plugin.name]: `file:${plugin.dir}`, [old]: 'file:D:/old-workbuddy' },
    dsh: { profile: { bundles: ['base'] } },
  });
  copyPlugin(plugin, fixture.dir);
  assert.equal(await installInto('web', [plugin], fixture.host), true);
  assert.deepEqual(fixture.calls, [['remove', old]]);
  assert.deepEqual(fixture.read().dsh.profile.bundles, ['base']);
});

test('以宿主退出后的最终状态为准', async (t) => {
  const [plugin] = resolvePlugins('magpie');
  const fixture = installFixture(t, {
    dependencies: { [plugin.name]: '26.1.1' }, dsh: { profile: { bundles: [plugin.name] } },
  });
  fixture.host.waitIdle = async () => {
    const final = fixture.read();
    final.dsh.profile.bundles = [];
    fixture.write(final);
    return true;
  };
  assert.equal(await installInto('web', [plugin], fixture.host), true);
  assert.deepEqual(fixture.read().dsh.profile.bundles, []);
});

test('add 已写入依赖但最终报失败时仍恢复停用状态', async (t) => {
  const [plugin] = resolvePlugins('magpie');
  const fixture = installFixture(t, {
    dependencies: { [plugin.name]: '26.1.1' }, dsh: { profile: { bundles: ['base'] } },
  });
  const run = fixture.host.runPlugin;
  fixture.host.runPlugin = (profile, args) => run(profile, args) && args[0] !== 'add';
  assert.equal(await installInto('web', [plugin], fixture.host), false);
  assert.deepEqual(fixture.read().dsh.profile.bundles, ['base']);
  assert.equal(fixture.read().dependencies[plugin.name], `file:${plugin.dir}`);
});

test('新 profile 首次安装默认启用', async (t) => {
  const [plugin] = resolvePlugins('magpie');
  const fixture = installFixture(t);
  assert.equal(await installInto('web', [plugin], fixture.host), true);
  assert.deepEqual(fixture.read().dsh.profile.bundles, [plugin.name]);
});
