import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../fixtures/http-fixture.mjs';
import { downloadCached } from '../lib/download.js';

function file(t) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'runtime.zip');
}
test('下载中断后按 Range 续传，进度包含字节数；成功缓存避免重复请求', async t => {
  const target = file(t), ranges = [], progress = [];
  const bytes = Buffer.from('0123456789');
  const url = await serve(t, (req, res) => {
    ranges.push(req.headers.range);
    if (ranges.length === 1) {
      res.writeHead(200, { 'content-length': 10 }); res.write(bytes.subarray(0, 4));
      setTimeout(() => res.destroy(), 15);
    } else {
      res.writeHead(206, { 'content-length': 6, 'content-range': 'bytes 4-9/10' }); res.end(bytes.subarray(4));
    }
  });
  assert.deepEqual(await downloadCached(url, target, { retryMs: 1, onProgress: p => progress.push(p) }), bytes);
  assert.deepEqual(ranges, [undefined, 'bytes=4-']);
  assert.equal(existsSync(`${target}.part`), false);
  assert.equal(progress.at(-1).received, 10);
  assert.equal(progress.at(-1).total, 10);
  assert.deepEqual(await downloadCached(url, target), bytes);
  assert.equal(ranges.length, 2);
});
test('重试耗尽后保留断点，重新安装时服务不支持 Range 也能完整重下', async t => {
  const target = file(t);
  let bad = true, seenRange;
  const url = await serve(t, (req, res) => {
    seenRange = req.headers.range;
    res.writeHead(200, { 'content-length': 6 });
    if (bad) { res.write('abc'); setTimeout(() => res.destroy(), 15); }
    else res.end('abcdef');
  });
  await assert.rejects(downloadCached(url, target, { attempts: 1 }), /缓存已保留/);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(`${target}.part`, 'utf8'), 'abc');
  bad = false;
  assert.equal((await downloadCached(url, target)).toString(), 'abcdef');
  assert.equal(seenRange, 'bytes=3-');
});
