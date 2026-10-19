/**
 * 配置解析测试：默认值、覆盖、opt-out、环境合并、非法值回退。
 * 全部是纯函数，不 spawn 任何进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { resolvePluginConfig, describeConfig } from '../lib/config.js';
import { backendPaths } from '../lib/backend.js';
import { SERVICE_DEFAULTS } from '../lib/services.js';

/** 固定一个后端根目录，让"默认路径"的断言与真实的 home 目录无关。 */
const ENV = { PATH: '', DSH_WORKBUDDY_BACKEND_ROOT: 'C:\\tmp\\wb-root' };
const PATHS = backendPaths(ENV);

test('默认配置：启用、端口 7863、指向插件自管的 wb2api.exe', () => {
  const resolved = resolvePluginConfig({}, ENV);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.spec.key, 'workbuddy');
  assert.equal(resolved.spec.port, 7863);
  assert.equal(resolved.spec.host, '127.0.0.1');
  assert.equal(resolved.spec.exe, PATHS.exe);
  assert.equal(resolved.spec.cwd, PATHS.current);
  assert.deepEqual(resolved.spec.args, ['-config', 'config.json']);
});

test('enabled:false 时解析结果直接标记为不启用', () => {
  assert.equal(resolvePluginConfig({ enabled: false }, { PATH: '' }).enabled, false);
  // 非布尔值不算显式关闭，退回默认（true）。
  assert.equal(resolvePluginConfig({ enabled: 'no' }, { PATH: '' }).enabled, true);
});

test('端口可覆盖，非法端口退回默认值', () => {
  assert.equal(resolvePluginConfig({ port: 7999 }, { PATH: '' }).spec.port, 7999);
  assert.equal(resolvePluginConfig({ port: 'abc' }, { PATH: '' }).spec.port, 7863);
  assert.equal(resolvePluginConfig({ port: 0 }, { PATH: '' }).spec.port, 7863);
});

test('exe / args / cwd / title 可覆盖，非法类型退回默认值', () => {
  const resolved = resolvePluginConfig(
    { exe: 'C:\\tmp\\fake.exe', args: ['--x'], cwd: 'C:\\tmp', title: '假服务' },
    { PATH: '' },
  );
  assert.equal(resolved.spec.exe, 'C:\\tmp\\fake.exe');
  assert.deepEqual(resolved.spec.args, ['--x']);
  assert.equal(resolved.spec.cwd, resolve('C:\\tmp'));
  assert.equal(resolved.spec.title, '假服务');

  const bad = resolvePluginConfig({ args: 'not-an-array', cwd: '   ' }, ENV);
  assert.deepEqual(bad.spec.args, SERVICE_DEFAULTS.args);
  assert.equal(bad.spec.cwd, PATHS.current);
});

test('cwd 相对路径会被解析成绝对路径（子进程 cwd 不接受相对路径）', () => {
  const resolved = resolvePluginConfig({ cwd: '.' }, { PATH: '' });
  assert.equal(resolved.spec.cwd, resolve('.'));
});

test('子进程环境继承宿主并叠加覆盖项，且不改写宿主 process.env', () => {
  const resolved = resolvePluginConfig({ env: { WB_EXTRA: '1', BAD: 42 } }, { PATH: '', WB_BASE: 'base' });
  assert.equal(resolved.spec.env.WB_BASE, 'base');
  assert.equal(resolved.spec.env.WB_EXTRA, '1');
  assert.equal(resolved.spec.env.BAD, undefined, '非字符串值必须被丢弃');
  assert.equal(process.env.WB_EXTRA, undefined, '不得污染宿主环境');
});

test('logDir 默认落在 DSH home 下，可用 DSH_HOME 或配置覆盖', () => {
  const byHome = resolvePluginConfig({}, { PATH: '', DSH_HOME: 'C:\\custom-dsh' });
  assert.equal(byHome.logDir, join('C:\\custom-dsh', 'autostart-workbuddy', 'logs'));

  const explicit = resolvePluginConfig({ logDir: 'C:\\logs\\wb' }, { PATH: '', DSH_HOME: 'C:\\custom-dsh' });
  assert.equal(explicit.logDir, resolve('C:\\logs\\wb'));
});

test('超时参数可覆盖，非法值退回默认（30000 / 5000）', () => {
  const resolved = resolvePluginConfig({ readinessTimeoutMs: 1000, stopTimeoutMs: -5 }, { PATH: '' });
  assert.equal(resolved.spec.readinessTimeoutMs, 1000);
  assert.equal(resolved.spec.stopTimeoutMs, 5000);
});

test('models 段：默认关闭、默认三档、默认接口指向本机后端', () => {
  const resolved = resolvePluginConfig({}, ENV);
  assert.equal(resolved.models.enabled, false, '默认不擅自改用户的 profile');
  assert.deepEqual(resolved.models.efforts, ['low', 'high', 'max']);
  assert.deepEqual(resolved.models.only, []);
  assert.equal(resolved.models.provider, 'workbuddy');
  assert.equal(resolved.models.baseURL, 'http://127.0.0.1:7863');
  // 面板 config.json 默认就在 wb2api 的工作目录下。
  assert.equal(resolved.models.panelConfig, join(PATHS.current, 'config.json'));
});

test('backend 段：默认开启启动检查、保留 3 个版本，各字段可覆盖', () => {
  const resolved = resolvePluginConfig({}, ENV);
  assert.equal(resolved.backend.enabled, true);
  assert.equal(resolved.backend.checkOnStart, true);
  assert.equal(resolved.backend.keepVersions, 3);
  assert.equal(resolved.backend.apiBase, '');
  assert.equal(resolved.backend.paths.exe, PATHS.exe);

  const custom = resolvePluginConfig(
    { backend: { checkOnStart: false, keepVersions: 5, checkTtlMs: 1000, apiBase: 'http://127.0.0.1:1' } },
    ENV,
  );
  assert.equal(custom.backend.checkOnStart, false);
  assert.equal(custom.backend.keepVersions, 5);
  assert.equal(custom.backend.checkTtlMs, 1000);
  assert.equal(custom.backend.apiBase, 'http://127.0.0.1:1');
});

test('backend 段：自动更新默认开启、冷却期 24 小时；冷却期可设 0，负数与非法值退回默认', () => {
  const resolved = resolvePluginConfig({}, ENV);
  assert.equal(resolved.backend.autoUpdate, true);
  assert.equal(resolved.backend.autoUpdateDelayHours, 24);

  const off = resolvePluginConfig({ backend: { autoUpdate: false, autoUpdateDelayHours: 0 } }, ENV);
  assert.equal(off.backend.autoUpdate, false);
  assert.equal(off.backend.autoUpdateDelayHours, 0);

  for (const value of [-1, 'abc', '', null]) {
    assert.equal(resolvePluginConfig({ backend: { autoUpdateDelayHours: value } }, ENV).backend.autoUpdateDelayHours, 24, String(value));
  }
  // 只有显式 false 才关：写错类型不该把自动更新悄悄关掉。
  assert.equal(resolvePluginConfig({ backend: { autoUpdate: 'no' } }, ENV).backend.autoUpdate, true);
});

test('managedExe：没配 exe 时为 true（用自管目录），显式配了为 false', () => {
  assert.equal(resolvePluginConfig({}, ENV).managedExe, true);
  assert.equal(resolvePluginConfig({ exe: 'C:\\tmp\\x.exe' }, ENV).managedExe, false);
  // 空白字符串不算显式配置
  assert.equal(resolvePluginConfig({ exe: '   ' }, ENV).managedExe, true);
});

test('models 段：白名单、排除、档位与超时可覆盖，非法值退回默认', () => {
  const resolved = resolvePluginConfig(
    {
      models: {
        enabled: true,
        only: ['cn:a', 'global:b'],
        exclude: ['cn:c'],
        efforts: 'auto',
        baseURL: 'http://127.0.0.1:9999/v1/',
        timeoutMs: 'abc',
      },
    },
    { PATH: '' },
  );
  assert.equal(resolved.models.enabled, true);
  assert.deepEqual(resolved.models.only, ['cn:a', 'global:b']);
  assert.deepEqual(resolved.models.exclude, ['cn:c']);
  assert.equal(resolved.models.efforts, 'auto');
  assert.equal(resolved.models.baseURL, 'http://127.0.0.1:9999/v1/');
  assert.equal(resolved.models.timeoutMs, 60_000, '非法超时退回默认');
  // 非数组的 only 视为没配（= 全部模型），而不是解析失败。
  assert.deepEqual(resolvePluginConfig({ models: { only: 'cn:a' } }, { PATH: '' }).models.only, []);
});

test('describeConfig 给出排障所需的概要', () => {
  const info = describeConfig(resolvePluginConfig({}, { PATH: '' }));
  assert.equal(info.key, 'workbuddy');
  assert.equal(info.endpoint, '127.0.0.1:7863');
  assert.ok(info.exe.endsWith('wb2api.exe'));
  assert.ok(info.logDir.endsWith(join('autostart-workbuddy', 'logs')));
});
