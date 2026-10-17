/**
 * 版本检查测试：版本号比较、多注册表取最高、部分失败、缓存与强制刷新。
 * 注册表全用本地 mock，不碰真实网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkLatestVersion, compareVersions, createVersionChecker, installationSource, PACKAGE_NAME, RUNNING_VERSION } from '../lib/update.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 起一个 mock 注册表：answer(url) 返回 [状态码, 响应体]；收到的路径记在 hits。 */
async function startRegistry(t, answer) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const [status, body] = answer(req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}

test('compareVersions：日期版本号、预发布、非法输入', () => {
  assert.ok(compareVersions('26.10.12', '26.10.11') > 0);
  assert.ok(compareVersions('26.9.30', '26.10.1') < 0, '按数字比，不按字符串比');
  assert.ok(compareVersions('27.1.1', '26.12.31') > 0, '跨年主版本号变大');
  assert.equal(compareVersions('26.10.11', 'v26.10.11'), 0);
  assert.ok(compareVersions('26.10.11-beta.1', '26.10.11') < 0, '预发布低于同号正式版');
  assert.ok(Number.isNaN(compareVersions('latest', '26.10.11')));
});

test('运行版本取自 package.json', () => {
  assert.equal(PACKAGE_NAME, PACKAGE.name);
  assert.equal(RUNNING_VERSION, PACKAGE.version);
});

test('file/link 安装由 profile 清单识别，强制检查也不请求 npm；npm 安装仍查注册表', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencode-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'node_modules', '@zhiqiangme', 'dsh-opencode2api');
  mkdirSync(packageDir, { recursive: true });
  const manifestPath = join(root, 'package.json');
  let requests = 0;
  const fetchImpl = async () => { requests++; return { ok: true, json: async () => ({ latest: '26.10.16' }) }; };
  for (const spec of ['file:D:/Project/plugin', 'link:../plugin']) {
    writeFileSync(manifestPath, JSON.stringify({ dependencies: { [PACKAGE_NAME]: spec } }));
    assert.equal(installationSource({ packageDir }), 'local');
    const check = createVersionChecker({ packageDir, fetchImpl });
    const result = await check({ force: true });
    assert.equal(result.ok, true);
    assert.equal(result.installSource, 'local');
    assert.equal(result.updateAvailable, false);
  }
  assert.equal(requests, 0);
  writeFileSync(manifestPath, JSON.stringify({ dependencies: { [PACKAGE_NAME]: '^26.10.15' } }));
  assert.equal((await checkLatestVersion({ packageDir, fetchImpl })).latestVersion, '26.10.16');
  assert.equal(requests, 2);
});

test('checkLatestVersion：作用域包名编码正确，取各注册表里最高的版本', async (t) => {
  const fast = await startRegistry(t, () => [200, { latest: '26.10.11' }]);
  const lagging = await startRegistry(t, () => [200, { latest: '26.10.20', beta: '26.11.1-beta.1' }]);
  const result = await checkLatestVersion({ name: '@scope/pkg', current: '26.10.11', registries: [fast.url, lagging.url] });
  assert.equal(fast.hits[0], '/-/package/@scope%2Fpkg/dist-tags');
  assert.equal(result.ok, true);
  assert.equal(result.latestVersion, '26.10.20');
  assert.equal(result.registry, lagging.url);
  assert.equal(result.updateAvailable, true);
});

test('checkLatestVersion：一个注册表 404（镜像未同步）不影响结果；已是最新时 updateAvailable=false', async (t) => {
  const missing = await startRegistry(t, () => [404, { error: 'not found' }]);
  const ok = await startRegistry(t, () => [200, { latest: '26.10.11' }]);
  const result = await checkLatestVersion({ name: 'pkg', current: '26.10.11', registries: [missing.url, ok.url] });
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
});

test('checkLatestVersion：全部失败时 ok=false，原因逐个列出注册表', async (t) => {
  const missing = await startRegistry(t, () => [404, {}]);
  const garbage = await startRegistry(t, () => [200, { latest: 'not-a-version' }]);
  const result = await checkLatestVersion({ name: 'pkg', current: '1.0.0', registries: [missing.url, garbage.url] });
  assert.equal(result.ok, false);
  assert.equal(result.currentVersion, '1.0.0');
  assert.match(result.reason, /HTTP 404/);
  assert.match(result.reason, /没有 latest 版本/);
});

test('checkLatestVersion：超时的注册表按失败处理', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    // AbortSignal.timeout 不保持事件循环存活；mock 要模拟真实请求的存活句柄。
    // 1 秒是未收到 abort 时的失败兜底，实际取消仍由下面的 20ms 超时触发。
    const pendingRequest = setTimeout(() => reject(new Error('mock fetch did not abort')), 1_000);
    signal.addEventListener('abort', () => {
      clearTimeout(pendingRequest);
      reject(new Error('timed out'));
    }, { once: true });
  });
  const result = await checkLatestVersion({ name: 'pkg', current: '1.0.0', registries: ['http://x'], fetchImpl: hang, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/);
});

test('createVersionChecker：成功结果按 TTL 缓存，force 绕过；失败不缓存', async (t) => {
  let latest = '26.10.12';
  let status = 200;
  const registry = await startRegistry(t, () => [status, { latest }]);
  let clock = 0;
  const check = createVersionChecker({ name: 'pkg', current: '26.10.11', registries: [registry.url], ttlMs: 1000, now: () => clock });

  assert.equal((await check()).latestVersion, '26.10.12');
  latest = '26.10.13';
  assert.equal((await check()).latestVersion, '26.10.12', 'TTL 内走缓存');
  assert.equal((await check({ force: true })).latestVersion, '26.10.13', 'force 绕过缓存');
  clock = 5000;
  latest = '26.10.14';
  assert.equal((await check()).latestVersion, '26.10.14', '过期后重新查询');

  status = 500;
  clock = 10_000;
  assert.equal((await check()).ok, false);
  status = 200;
  assert.equal((await check()).ok, true, '失败结果不缓存，下一次直接重试');
  assert.equal(registry.hits.length, 5);
});
