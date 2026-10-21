import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { importWb2apiAccounts } from '../lib/hub-account-import.js';
import { hubKeyHooks, hubPaths } from '../lib/hub.js';
import { ManagedService } from '../lib/services.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'wb-hub-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = hubPaths({ DSH_WORKBUDDY_BACKEND_ROOT: root });
  const source = join(paths.plugin.data, 'auths');
  const lines = [];
  const logger = { info: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  const resolved = { backend: { paths }, spec: { env: { API_KEY: 'already-configured-key' } }, models: { apiKey: 'already-configured-key' } };
  return { paths, source, lines, logger, resolved };
}

function writeJson(path, row, prefix = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, prefix + JSON.stringify(row));
}

function credential(uid, { realm = 'cn', issuer, domain, expiresAt = 1_900_000_000_000 } = {}) {
  const claims = Buffer.from(JSON.stringify({ sub: uid, iss: issuer || (realm === 'cn' ? 'https://www.workbuddy.cn/' : 'https://www.workbuddy.ai/'), exp: 1_900_000_000 })).toString('base64url');
  return {
    account: { uid, nickname: 'Test account', enterpriseId: 'enterprise' },
    auth: { accessToken: `header.${claims}.signature`, refreshToken: `refresh-${uid}`, realm, domain: domain || (realm === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai'), expiresAt },
  };
}

test('hub 启动钩子即使已有 API Key 也首次导入授权，保留已有账号、设置与 wb2api 原文件', (t) => {
  const { paths, source, resolved, logger, lines } = setup(t);
  const cn = credential('cn-account');
  const global = credential('global-account', { realm: 'global', expiresAt: 1 });
  writeJson(join(source, 'cn.json'), cn);
  writeJson(join(source, 'global.json'), global);
  writeJson(join(source, 'already-exists.json'), credential('existing'));
  const kept = { uid: 'existing', accessToken: 'new-hub-token', refreshToken: 'new-hub-refresh', enabled: false, note: 'keep me' };
  writeJson(join(paths.accounts, 'custom-filename.json'), kept);
  const existingBytes = readFileSync(join(paths.accounts, 'custom-filename.json'));
  writeJson(join(paths.accounts, 'settings.json'), { panel_password_hash: 'keep-settings' });
  writeJson(join(paths.accounts, 'active_realm.json'), { realm: 'intl' });
  const sourceBytes = readFileSync(join(source, 'cn.json'));

  hubKeyHooks(resolved, logger).beforeSpawn();

  const imported = JSON.parse(readFileSync(join(paths.accounts, 'cn-account.json'), 'utf8'));
  assert.equal(imported.accessToken, cn.auth.accessToken);
  assert.equal(imported.refreshToken, cn.auth.refreshToken);
  assert.equal(imported.expiresAt, 1_900_000_000);
  assert.equal(imported.enterpriseId, 'enterprise');
  assert.equal(imported.realm, 'cn');
  assert.equal(imported.enabled, true);
  const intl = JSON.parse(readFileSync(join(paths.accounts, 'global-account.json'), 'utf8'));
  assert.equal(intl.realm, 'intl');
  assert.equal(intl.expiresAt, 1, '保留过期 accessToken 及 refreshToken，由 hub 刷新');
  assert.deepEqual(readFileSync(join(paths.accounts, 'custom-filename.json')), existingBytes);
  assert.equal(existsSync(join(paths.accounts, 'existing.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(paths.accounts, 'settings.json'), 'utf8')), { panel_password_hash: 'keep-settings' });
  assert.deepEqual(readFileSync(join(source, 'cn.json')), sourceBytes);
  assert.equal(resolved.spec.env.API_KEY, 'already-configured-key');
  const marker = JSON.parse(readFileSync(paths.accountsImportFile, 'utf8'));
  assert.deepEqual({ imported: marker.imported, skipped: marker.skipped, invalid: marker.invalid }, { imported: 2, skipped: 1, invalid: 0 });
  const report = JSON.stringify({ marker, lines });
  for (const secret of [cn.auth.accessToken, cn.auth.refreshToken, kept.accessToken, kept.refreshToken]) assert.ok(!report.includes(secret));
  assert.ok(readdirSync(paths.accounts).every((name) => !name.endsWith('.tmp')));
});

test('完成后不再导入：保留 hub 独立刷新的令牌，删除的账号不复活，wb2api 新增账号不自动同步', (t) => {
  const { paths, source } = setup(t);
  writeJson(join(source, 'keep.json'), credential('keep'));
  writeJson(join(source, 'delete.json'), credential('delete'));
  assert.equal(importWb2apiAccounts(paths).state, 'completed');
  writeJson(join(paths.accounts, 'keep.json'), { uid: 'keep', accessToken: 'hub-refreshed', refreshToken: 'hub-refresh' });
  rmSync(join(paths.accounts, 'delete.json'));
  writeJson(join(source, 'keep.json'), credential('keep', { expiresAt: 1 }));
  writeJson(join(source, 'new.json'), credential('new'));
  const marker = readFileSync(paths.accountsImportFile);
  assert.equal(importWb2apiAccounts(paths).state, 'already-imported');
  assert.equal(JSON.parse(readFileSync(join(paths.accounts, 'keep.json'), 'utf8')).accessToken, 'hub-refreshed');
  assert.equal(existsSync(join(paths.accounts, 'delete.json')), false);
  assert.equal(existsSync(join(paths.accounts, 'new.json')), false);
  assert.deepEqual(readFileSync(paths.accountsImportFile), marker);
});

test('未安装过 wb2api 时不写标记，之后首次有授权仍能导入；空目录成功扫描只执行一次', (t) => {
  const { paths, source } = setup(t);
  assert.equal(importWb2apiAccounts(paths).state, 'no-source');
  assert.equal(existsSync(paths.accountsImportFile), false);
  mkdirSync(source, { recursive: true });
  assert.deepEqual(importWb2apiAccounts(paths), { state: 'completed', imported: 0, skipped: 0, invalid: 0 });
  assert.equal(importWb2apiAccounts(paths).state, 'already-imported');
});

test('遵循 wb2api 的相对 auth_dir，并兼容带 BOM 的配置与凭证', (t) => {
  const { paths } = setup(t);
  writeJson(paths.plugin.config, { auth_dir: '../../../custom-auths' }, '\uFEFF');
  writeJson(join(paths.plugin.root, 'custom-auths', 'account.json'), credential('custom'), '\uFEFF');
  assert.equal(importWb2apiAccounts(paths).imported, 1);
  assert.ok(existsSync(join(paths.accounts, 'custom.json')));
});

test('区域以 token 为准，冲突域名归一；原始 uid 不能逃出账号目录', (t) => {
  const { paths, source } = setup(t);
  writeJson(join(source, 'account.json'), credential('../../cn-user', { realm: 'global', issuer: 'https://www.workbuddy.cn/', domain: 'www.workbuddy.ai' }));
  assert.equal(importWb2apiAccounts(paths).imported, 1);
  const imported = JSON.parse(readFileSync(join(paths.accounts, 'cn-user.json'), 'utf8'));
  assert.equal(imported.uid, 'cn-user');
  assert.equal(imported.realm, 'cn');
  assert.equal(imported.domain, 'copilot.tencent.com');
});

test('损坏或不支持的授权只跳过该文件，不泄露解析片段或覆盖设置；重复账号只导入一份', (t) => {
  const { paths, source, resolved, logger, lines } = setup(t);
  writeJson(join(source, 'valid.json'), credential('valid'));
  writeJson(join(source, 'duplicate.json'), credential('valid'));
  writeFileSync(join(source, 'broken.json'), '{"accessToken":"secret-in-broken-json');
  writeJson(join(source, 'encrypted.json'), { account: { uid: 'encrypted' }, auth: { accessToken: { $wbEncrypted: 'private-envelope' } } });
  writeJson(join(source, 'wrong-shape.json'), []);
  writeJson(join(source, 'reserved.json'), credential('settings'));
  hubKeyHooks(resolved, logger).beforeSpawn();
  const marker = JSON.parse(readFileSync(paths.accountsImportFile, 'utf8'));
  assert.equal(marker.imported, 1);
  assert.equal(marker.skipped, 1);
  assert.equal(marker.invalid, 4);
  assert.equal(existsSync(join(paths.accounts, 'settings.json')), false);
  assert.doesNotMatch(lines.join('\n'), /secret-in-broken-json|private-envelope/);
  assert.match(lines.join('\n'), /无效 4/);
});

test('hub 已有文件无法读取时保守保留并允许修复后重试，失败日志不泄露内容', (t) => {
  const { paths, source, resolved, logger, lines } = setup(t);
  writeJson(join(source, 'valid.json'), credential('valid'));
  mkdirSync(paths.accounts, { recursive: true });
  writeFileSync(join(paths.accounts, 'existing.json'), '{"accessToken":"private-existing-token');
  hubKeyHooks(resolved, logger).beforeSpawn();
  assert.equal(existsSync(paths.accountsImportFile), false);
  assert.equal(existsSync(join(paths.accounts, 'valid.json')), false);
  assert.doesNotMatch(lines.join('\n'), /private-existing-token/);
  assert.match(lines.join('\n'), /INVALID_JSON.*下次启动重试/);
  writeJson(join(paths.accounts, 'existing.json'), { uid: 'existing', accessToken: 'kept' });
  assert.equal(importWb2apiAccounts(paths).imported, 1);
});

test('目标目录不可写时不记完成，修复后重试；同名目标文件即使不是账号也不会被覆盖', (t) => {
  const { paths, source } = setup(t);
  writeJson(join(source, 'valid.json'), credential('valid'));
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.accounts, 'blocked');
  assert.equal(importWb2apiAccounts(paths).state, 'error');
  assert.equal(existsSync(paths.accountsImportFile), false);
  rmSync(paths.accounts);
  writeJson(join(paths.accounts, 'valid.json'), { userData: 'preserve' });
  assert.deepEqual(importWb2apiAccounts(paths), { state: 'completed', imported: 0, skipped: 1, invalid: 0 });
  assert.deepEqual(JSON.parse(readFileSync(join(paths.accounts, 'valid.json'), 'utf8')), { userData: 'preserve' });
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

test('真实进程托管流程在 spawn 前完成导入，hub 冷启动即可读取账号', async (t) => {
  // Windows 不能删除存活子进程的工作目录，先停进程再清理本用例目录。
  const { paths, source, resolved, logger, lines } = setup({ after() {} });
  writeJson(join(source, 'startup.json'), credential('startup'));
  const port = await freePort();
  const script = `const fs=require('node:fs');const p=process.argv[1];const a=JSON.parse(fs.readFileSync(p,'utf8'));if(a.uid!=='startup'||!a.refreshToken)process.exit(2);require('node:net').createServer(s=>s.end()).listen(Number(process.argv[2]),'127.0.0.1');`;
  const service = new ManagedService({
    key: 'workbuddy', title: 'hub-fixture', host: '127.0.0.1', port, exe: process.execPath,
    args: ['-e', script, join(paths.accounts, 'startup.json'), String(port)], cwd: paths.data,
    env: process.env, logDir: paths.logs, logName: 'fixture', readinessTimeoutMs: 5_000, stopTimeoutMs: 5_000,
  }, logger, hubKeyHooks(resolved, logger));
  t.after(async () => {
    await service.stop('test complete');
    rmSync(paths.plugin.root, { recursive: true, force: true });
  });
  const started = await service.ensureRunning();
  assert.equal(started.state, 'started', JSON.stringify({ started, lines }));
  assert.ok(existsSync(paths.accountsImportFile));
});

test('端口已被外部服务占用时不运行启动钩子，不修改运行中 hub 的授权目录', async (t) => {
  const { paths, source, resolved, logger } = setup(t);
  writeJson(join(source, 'existing.json'), credential('existing'));
  const server = createServer((socket) => socket.end());
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const service = new ManagedService({ title: 'hub-fixture', host: '127.0.0.1', port: server.address().port }, logger, hubKeyHooks(resolved, logger));
  assert.equal((await service.ensureRunning()).state, 'already-running');
  assert.equal(existsSync(paths.accountsImportFile), false);
  assert.equal(existsSync(paths.accounts), false);
});
