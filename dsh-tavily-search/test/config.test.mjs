/**
 * 配置解析测试：默认值、覆盖、opt-out、非法值退回默认、.env 解析、独立运行的环境变量映射。
 * 全部是纯函数，不监听任何端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configFromEnv } from '../lib/cli.js';
import { parseEnvFile, resolvePluginConfig } from '../lib/config.js';

test('默认配置：启用、127.0.0.1:8787、凭据引用 TAVILY_API_KEY、不导入旧 key', () => {
  const resolved = resolvePluginConfig(undefined);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.host, '127.0.0.1');
  assert.equal(resolved.port, 8787);
  assert.equal(resolved.endpoint, 'http://127.0.0.1:8787/v1');
  assert.equal(resolved.apiKeyRef, 'TAVILY_API_KEY');
  assert.equal(resolved.importEnvFile, '');
  assert.equal(resolved.shim.tavilyBaseUrl, 'https://api.tavily.com');
  assert.equal(resolved.shim.maxResults, 8);
  assert.equal(resolved.shim.searchDepth, '');
});

test('enabled 只有显式 false 才关闭', () => {
  assert.equal(resolvePluginConfig({ enabled: false }).enabled, false);
  assert.equal(resolvePluginConfig({ enabled: 'no' }).enabled, true);
});

test('端口与数值字段：合法值生效，非法值退回默认', () => {
  assert.equal(resolvePluginConfig({ port: 9999 }).endpoint, 'http://127.0.0.1:9999/v1');
  assert.equal(resolvePluginConfig({ port: 'abc' }).port, 8787);
  assert.equal(resolvePluginConfig({ port: 0 }).port, 8787);
  assert.equal(resolvePluginConfig({ port: 70000 }).port, 8787);
  assert.equal(resolvePluginConfig({ maxResults: '3' }).shim.maxResults, 3);
  assert.equal(resolvePluginConfig({ maxResults: 2.5 }).shim.maxResults, 8);
  assert.equal(resolvePluginConfig({ timeoutMs: -1 }).shim.timeoutMs, 30000);
});

test('searchDepth 只接受 basic / advanced', () => {
  assert.equal(resolvePluginConfig({ searchDepth: 'advanced' }).shim.searchDepth, 'advanced');
  assert.equal(resolvePluginConfig({ searchDepth: ' basic ' }).shim.searchDepth, 'basic');
  assert.equal(resolvePluginConfig({ searchDepth: 'deep' }).shim.searchDepth, '');
});

test('apiKeyRef 必须是环境变量名形状，否则退回默认（凭据库会拒绝别的形状）', () => {
  assert.equal(resolvePluginConfig({ apiKeyRef: 'MY_TAVILY_KEY' }).apiKeyRef, 'MY_TAVILY_KEY');
  assert.equal(resolvePluginConfig({ apiKeyRef: 'bad-ref' }).apiKeyRef, 'TAVILY_API_KEY');
  assert.equal(resolvePluginConfig({ apiKeyRef: '1ABC' }).apiKeyRef, 'TAVILY_API_KEY');
});

test('tavilyBaseUrl 去掉末尾斜杠', () => {
  assert.equal(resolvePluginConfig({ tavilyBaseUrl: 'http://mock:1/' }).shim.tavilyBaseUrl, 'http://mock:1');
});

test('.env 解析：忽略注释与空行，只按第一个 = 切分，文件不存在返回空对象', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavily-cfg-'));
  const path = join(dir, '.env');
  writeFileSync(path, ['# 注释', '', 'A=1', 'B=has=equals', 'C=', '=noKey', '  D  =  spaced  '].join('\n'), 'utf8');
  const env = parseEnvFile(path);
  assert.equal(env.A, '1');
  assert.equal(env.B, 'has=equals');
  assert.equal(env.C, '');
  assert.equal(env.D, 'spaced');
  assert.equal(Object.keys(env).includes(''), false);
  assert.deepEqual(parseEnvFile(join(dir, 'missing.env')), {});
});

test('独立运行：旧版环境变量映射到同一套配置', () => {
  const resolved = resolvePluginConfig(
    configFromEnv({ LISTEN: '127.0.0.1:9999', TAVILY_MAX_RESULTS: '3', TAVILY_SEARCH_DEPTH: 'basic' }),
  );
  assert.equal(resolved.host, '127.0.0.1');
  assert.equal(resolved.port, 9999);
  assert.equal(resolved.shim.maxResults, 3);
  assert.equal(resolved.shim.searchDepth, 'basic');

  // LISTEN_HOST / LISTEN_PORT 优先于 LISTEN
  const split = resolvePluginConfig(configFromEnv({ LISTEN: '127.0.0.1:9999', LISTEN_PORT: '8888' }));
  assert.equal(split.port, 8888);
});
