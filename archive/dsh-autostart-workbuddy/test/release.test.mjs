import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { downloadAsset, fetchChecksums, fetchLatestRelease, formatError, REPO, sha256, verifyChecksum } from '../lib/release.js';

test('wb2api 从 misakano 分支查询 Release，并保留 GitHub 资产摘要', async (t) => {
  const requests = [];
  const digest = `sha256:${'a'.repeat(64)}`;
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/releases/latest') ? {
      tag_name: 'v2026.11.15.2246', assets: [{ name: 'wb2api-panel-2026.11.15.2246-windows-amd64.zip', browser_download_url: 'https://example.test/backend.zip', digest }],
    } : { sha: 'f'.repeat(40) }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  assert.equal(REPO.owner, 'misakano7545');
  const latest = await fetchLatestRelease({ apiBase: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual(requests, [
    '/repos/misakano7545/workbuddy2api-panel/releases/latest',
    '/repos/misakano7545/workbuddy2api-panel/commits/v2026.11.15.2246',
  ]);
  assert.equal(latest.assets[0].digest, digest);
  assert.equal(latest.commit, 'f'.repeat(40));
});

test('无校验文件时 wb2api 可使用 GitHub SHA-256 摘要，缺失、格式错误和内容不符均拒绝', async () => {
  const archive = Buffer.from('downloaded backend');
  const name = 'wb2api-panel-2026.11.15.2246-windows-amd64.zip';
  const release = { assets: [{ name, digest: `sha256:${sha256(archive)}` }] };
  assert.equal((await fetchChecksums(release)).size, 0, 'Hub 未显式允许时继续要求校验文件');
  const checksums = await fetchChecksums(release, { allowAssetDigests: true });
  assert.equal(verifyChecksum(archive, name, checksums).ok, true);
  assert.equal(verifyChecksum(Buffer.from('corrupted'), name, checksums).ok, false);
  assert.equal(verifyChecksum(archive, 'other.zip', checksums).ok, false);
  for (const digest of [undefined, null, '', 'sha256:abc', `sha1:${'a'.repeat(64)}`, `sha256:${'g'.repeat(64)}`]) {
    const sums = await fetchChecksums({ assets: [{ name, digest }] }, { allowAssetDigests: true });
    assert.equal(verifyChecksum(archive, name, sums).ok, false, String(digest));
  }
});

test('已有校验文件时摘要不覆盖文件，校验文件下载失败也不退回摘要', async (t) => {
  const archive = Buffer.from('downloaded backend');
  let status = 200;
  const server = createServer((_req, res) => { res.writeHead(status); res.end(`${'a'.repeat(64)}  backend.zip\n`); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const release = { assets: [
    { name: 'backend.zip', digest: `sha256:${sha256(archive)}` },
    { name: 'checksums.txt', url: `http://127.0.0.1:${server.address().port}` },
  ] };
  const sums = await fetchChecksums(release, { allowAssetDigests: true });
  assert.equal(verifyChecksum(archive, 'backend.zip', sums).ok, false);
  status = 404;
  await assert.rejects(fetchChecksums(release, { allowAssetDigests: true }), /下载校验文件.*404/);
});

for (const phase of ['metadata', 'archive', 'checksums']) {
  test(`响应内容中断（${phase}）：错误保留请求上下文、socket 原因与错误码`, async (t) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': 1024, 'content-type': 'application/octet-stream' });
      res.write('partial');
      // 先让客户端收到响应头与部分内容，再模拟传输连接被关闭。
      const timer = setTimeout(() => res.destroy(), 30);
      res.on('close', () => clearTimeout(timer));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
    const url = `http://127.0.0.1:${server.address().port}`;
    const asset = { name: phase === 'archive' ? 'backend.zip' : 'checksums.txt', url };
    const request = phase === 'metadata'
      ? fetchLatestRelease({ apiBase: url, resolveCommit: false })
      : phase === 'archive' ? downloadAsset(asset) : fetchChecksums({ assets: [asset] });
    await assert.rejects(request, (error) => {
      assert.match(error.message, phase === 'metadata' ? /请求 http.*releases\/latest 失败/ : new RegExp(asset.name.replace('.', '\\.')));
      assert.match(error.message, /terminated/);
      assert.match(error.message, /UND_ERR_SOCKET/);
      assert.equal(error.cause.message, 'terminated');
      assert.equal(error.cause.cause.code, 'UND_ERR_SOCKET');
      if (phase === 'archive') assert.match(error.message, /已读取 7\/1024 字节/);
      assert.equal(formatError(error), error.message, '自动检查再次格式化时不重复追加已包含的原因');
      return true;
    });
  });
}

test('错误详情保留嵌套连接失败与 AggregateError 的错误码', () => {
  const socket = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
  const timeout = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
  const error = new TypeError('fetch failed', { cause: new AggregateError([socket, timeout]) });
  assert.match(formatError(error), /fetch failed.*ECONNRESET: socket reset.*ETIMEDOUT: connection timed out/);
});
