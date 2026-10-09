/**
 * 配置解析测试：默认值、覆盖、opt-out、.env 补位与优先级、node 解析、缺键检测。
 * 全部是纯函数，不 spawn 任何进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolvePluginConfig, describeConfig } from '../lib/config.js';
import { SERVICE_DEFAULTS } from '../lib/services.js';

/** 一个隔离的 .env 文件，避免读到工作区里真实的 key。 */
function tempEnvFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'autostart-web-cfg-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

test('默认配置：启用、端口 8787、argv 以 server.js 开头', () => {
  const resolved = resolvePluginConfig({}, { PATH: '' });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.spec.key, 'tavily');
  assert.equal(resolved.spec.port, 8787);
  assert.equal(resolved.spec.host, '127.0.0.1');
  assert.equal(resolved.spec.script, SERVICE_DEFAULTS.script);
  assert.equal(resolved.spec.args[0], SERVICE_DEFAULTS.script);
  assert.deepEqual(resolved.spec.requiredEnv, ['TAVILY_API_KEY']);
});

test('enabled:false 时解析结果直接标记为不启用', () => {
  assert.equal(resolvePluginConfig({ enabled: false }, { PATH: '' }).enabled, false);
  // 非布尔值不算显式关闭，退回默认（true）。
  assert.equal(resolvePluginConfig({ enabled: 'no' }, { PATH: '' }).enabled, true);
});

test('端口可覆盖，非法端口退回默认值', () => {
  assert.equal(resolvePluginConfig({ port: 9999 }, { PATH: '' }).spec.port, 9999);
  assert.equal(resolvePluginConfig({ port: 'abc' }, { PATH: '' }).spec.port, 8787);
  assert.equal(resolvePluginConfig({ port: 0 }, { PATH: '' }).spec.port, 8787);
});

test('宿主环境优先于 .env（与 start.ps1 的 Set-Item Env: 语义一致）', () => {
  const envFile = tempEnvFile('TAVILY_API_KEY=from-file\n');

  const fromFile = resolvePluginConfig({ envFile }, { PATH: '' });
  assert.equal(fromFile.spec.env.TAVILY_API_KEY, 'from-file');

  const fromHost = resolvePluginConfig({ envFile }, { PATH: '', TAVILY_API_KEY: 'from-host' });
  assert.equal(fromHost.spec.env.TAVILY_API_KEY, 'from-host');
});

test('.env 解析：忽略注释与空行，只按第一个 = 切分', () => {
  const envFile = tempEnvFile(
    ['# 注释', '', 'A=1', 'B=has=equals', 'C=', '=noKey', '  D  =  spaced  '].join('\n'),
  );
  const env = resolvePluginConfig({ envFile }, { PATH: '' }).spec.env;
  assert.equal(env.A, '1');
  assert.equal(env.B, 'has=equals');
  assert.equal(env.C, '');
  assert.equal(env.D, 'spaced');
});

test('缺少 TAVILY_API_KEY 时被报告为缺失依赖', () => {
  const envFile = tempEnvFile('# 没有 key\n');
  const info = describeConfig(resolvePluginConfig({ envFile }, { PATH: '' }));
  assert.deepEqual(info.missing, ['TAVILY_API_KEY']);
});

test('env 覆盖项不污染宿主 process.env，非字符串值被丢弃', () => {
  const resolved = resolvePluginConfig({ env: { SHIM_X: '1', BAD: 42 } }, { PATH: '' });
  assert.equal(resolved.spec.env.SHIM_X, '1');
  assert.equal(resolved.spec.env.BAD, undefined, '非字符串值必须被丢弃');
  assert.equal(process.env.SHIM_X, undefined, '不得污染宿主环境');
});

test('node 解析：PATH 里没有 node 时退回 execPath 并补 ELECTRON_RUN_AS_NODE', () => {
  const resolved = resolvePluginConfig({}, { PATH: '' });
  assert.equal(resolved.spec.exe, process.execPath);
  // execPath 不是 node 时必须有兜底开关，否则 Electron 会被当 Node 启动。
  if (!/node(\.exe)?$/i.test(process.execPath)) {
    assert.equal(resolved.spec.env.ELECTRON_RUN_AS_NODE, '1');
  }

  const explicit = resolvePluginConfig({ nodePath: 'C:\\tmp\\node.exe' }, { PATH: '' });
  assert.equal(explicit.spec.exe, 'C:\\tmp\\node.exe');
});

test('script / args / cwd 可覆盖，非法类型退回默认值', () => {
  const resolved = resolvePluginConfig(
    { script: 'C:\\tmp\\server.js', args: ['--port', '1'], cwd: 'C:\\tmp' },
    { PATH: '' },
  );
  assert.deepEqual(resolved.spec.args, ['C:\\tmp\\server.js', '--port', '1']);
  assert.equal(resolved.spec.cwd, resolve('C:\\tmp'));

  const bad = resolvePluginConfig({ args: 'not-an-array', cwd: '   ' }, { PATH: '' });
  assert.deepEqual(bad.spec.args, [SERVICE_DEFAULTS.script]);
  assert.equal(bad.spec.cwd, resolve(SERVICE_DEFAULTS.cwd));
});

test('logDir 默认落在 DSH home 下（与 workbuddy 插件分目录），可覆盖', () => {
  const byHome = resolvePluginConfig({}, { PATH: '', DSH_HOME: 'C:\\custom-dsh' });
  assert.equal(byHome.logDir, join('C:\\custom-dsh', 'autostart-websearch', 'logs'));

  const explicit = resolvePluginConfig({ logDir: 'C:\\logs\\web' }, { PATH: '', DSH_HOME: 'C:\\custom-dsh' });
  assert.equal(explicit.logDir, resolve('C:\\logs\\web'));
});

test('describeConfig 给出排障所需的概要', () => {
  const info = describeConfig(resolvePluginConfig({}, { PATH: '' }));
  assert.equal(info.key, 'tavily');
  assert.equal(info.endpoint, '127.0.0.1:8787');
  assert.ok(info.script.endsWith('server.js'));
  assert.ok(info.envFile.endsWith('.env'));
  assert.ok(info.logDir.endsWith(join('autostart-websearch', 'logs')));
});
