import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { downloadAsset, fetchChecksums, fetchLatestRelease, formatError } from '../lib/release.js';

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
