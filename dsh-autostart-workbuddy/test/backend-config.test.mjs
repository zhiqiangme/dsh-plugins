/**
 * 后端 config.json 的 cn.chat_base 补写：只动这一项、不覆盖用户手填值、首次启动后补写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cnChatBaseHooks, DEFAULT_CN_CHAT_BASE, ensureCnChatBase } from '../lib/backend-config.js';
import { resolvePluginConfig } from '../lib/config.js';
import { ManagedService } from '../lib/services.js';

const DUMMY = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));
const silent = { info() {}, warn() {}, error() {} };

function tempConfig(content) {
  const dir = mkdtempSync(join(tmpdir(), 'autostart-wb-cfg-'));
  const path = join(dir, 'config.json');
  if (content !== undefined) writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { dir, path, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

test('缺 cn 段：补上 cn.chat_base，其余键原样保留', () => {
  const cfg = tempConfig({ api_key: 'k', global: { enabled: true, chat_base: '' }, listen: '127.0.0.1:7863' });
  const result = ensureCnChatBase(cfg.path, DEFAULT_CN_CHAT_BASE);
  assert.equal(result.state, 'patched');
  assert.deepEqual(cfg.read(), {
    api_key: 'k',
    global: { enabled: true, chat_base: '' },
    listen: '127.0.0.1:7863',
    cn: { chat_base: DEFAULT_CN_CHAT_BASE },
  });
  assert.equal(existsSync(`${cfg.path}.tmp`), false);
});

test('wb2api 生成的空串按未设置处理，同段其它键保留', () => {
  const cfg = tempConfig({ cn: { chat_base: '', other: 1 } });
  assert.equal(ensureCnChatBase(cfg.path, DEFAULT_CN_CHAT_BASE).state, 'patched');
  assert.deepEqual(cfg.read().cn, { chat_base: DEFAULT_CN_CHAT_BASE, other: 1 });
});

test('已是期望值：不重写文件', () => {
  const raw = '{\n  "cn": { "chat_base": "https://www.workbuddy.cn" }\n}';
  const cfg = tempConfig(raw);
  assert.equal(ensureCnChatBase(cfg.path, DEFAULT_CN_CHAT_BASE).state, 'unchanged');
  assert.equal(readFileSync(cfg.path, 'utf8'), raw);
});

test('用户手填的非空值不覆盖', () => {
  const cfg = tempConfig({ cn: { chat_base: 'https://copilot.tencent.com' } });
  const result = ensureCnChatBase(cfg.path, DEFAULT_CN_CHAT_BASE);
  assert.deepEqual(result, { state: 'kept-user', value: 'https://copilot.tencent.com' });
  assert.equal(cfg.read().cn.chat_base, 'https://copilot.tencent.com');
});

test('期望值为空串 = 插件不管，连文件都不读', () => {
  assert.equal(ensureCnChatBase(join(tmpdir(), 'nope', 'config.json'), '').state, 'disabled');
});

test('文件不存在 / 非法 JSON：分别报 missing / error，不写文件', () => {
  const missing = tempConfig();
  assert.equal(ensureCnChatBase(missing.path, DEFAULT_CN_CHAT_BASE).state, 'missing');
  assert.equal(existsSync(missing.path), false);

  const broken = tempConfig('{ not json');
  assert.equal(ensureCnChatBase(broken.path, DEFAULT_CN_CHAT_BASE).state, 'error');
  assert.equal(readFileSync(broken.path, 'utf8'), '{ not json');
});

test('带 BOM 的 config.json 也能补写', () => {
  const cfg = tempConfig(`\uFEFF${JSON.stringify({ api_key: 'k' })}`);
  assert.equal(ensureCnChatBase(cfg.path, DEFAULT_CN_CHAT_BASE).state, 'patched');
  assert.equal(cfg.read().cn.chat_base, DEFAULT_CN_CHAT_BASE);
});

test('插件配置 cnChatBase：缺省 www.workbuddy.cn，显式空串关闭，自定义值去空白', () => {
  const env = { PATH: '', DSH_WORKBUDDY_BACKEND_ROOT: 'C:\\tmp\\wb-root' };
  assert.equal(resolvePluginConfig({}, env).cnChatBase, DEFAULT_CN_CHAT_BASE);
  assert.equal(resolvePluginConfig({ cnChatBase: '' }, env).cnChatBase, '');
  assert.equal(resolvePluginConfig({ cnChatBase: ' https://x.example ' }, env).cnChatBase, 'https://x.example');
  // 非字符串退回默认。
  assert.equal(resolvePluginConfig({ cnChatBase: 1 }, env).cnChatBase, DEFAULT_CN_CHAT_BASE);
});

test('钩子：config.json 已存在时 spawn 前写好', () => {
  const cfg = tempConfig({ api_key: 'k' });
  const lines = [];
  const hooks = cnChatBaseHooks({ spec: { cwd: cfg.dir }, cnChatBase: DEFAULT_CN_CHAT_BASE }, { ...silent, info: (l) => lines.push(l) });
  hooks.beforeSpawn();
  assert.equal(cfg.read().cn.chat_base, DEFAULT_CN_CHAT_BASE);
  hooks.afterStart(); // 已写过，不再重复
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /下次启动/);
});

test('钩子：首次启动（spawn 前没有 config.json）在拉起成功后补写', () => {
  const cfg = tempConfig();
  const lines = [];
  const hooks = cnChatBaseHooks({ spec: { cwd: cfg.dir }, cnChatBase: DEFAULT_CN_CHAT_BASE }, { ...silent, info: (l) => lines.push(l) });
  hooks.beforeSpawn();
  assert.equal(existsSync(cfg.path), false);
  // 模拟 wb2api 首次运行生成默认配置。
  writeFileSync(cfg.path, JSON.stringify({ api_key: 'k', cn: { chat_base: '' } }));
  hooks.afterStart();
  assert.equal(cfg.read().cn.chat_base, DEFAULT_CN_CHAT_BASE);
  assert.match(lines.at(-1), /下次启动后端时生效/);
});

/** 借一个空闲端口：先 listen(0) 拿到系统分配，再关掉交给子进程使用。 */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

test('ManagedService：beforeSpawn 在拉起前、afterStart 在就绪后调用；钩子抛错不影响启动', async () => {
  const port = await freePort();
  const calls = [];
  const warnings = [];
  const service = new ManagedService(
    {
      key: 'workbuddy',
      title: 'dummy',
      host: '127.0.0.1',
      port,
      exe: process.execPath,
      args: [DUMMY],
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port), TEST_MODE: 'listen' },
      logDir: mkdtempSync(join(tmpdir(), 'autostart-wb-log-')),
      logName: 'dummy',
      readinessTimeoutMs: 10_000,
      stopTimeoutMs: 5_000,
    },
    { ...silent, warn: (l) => warnings.push(l) },
    {
      beforeSpawn: () => {
        calls.push(['before', service.isAlive()]);
        throw new Error('boom');
      },
      afterStart: () => calls.push(['after', service.isAlive()]),
    },
  );
  try {
    const result = await service.ensureRunning();
    assert.equal(result.state, 'started');
    assert.deepEqual(calls, [['before', false], ['after', true]]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /beforeSpawn 出错：boom/);
  } finally {
    await service.stop('测试结束');
  }
});
