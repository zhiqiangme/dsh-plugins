import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRelease, downloadRelease, compareVersions, formatError, RELEASE_API, sha256 } from '../lib/release.js';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseFixture } from '../fixtures/backend.mjs';

// 每个测试独立的下载缓存目录；测试结束删除。
function cacheDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-magpie-download-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { partialDir: dir, retryDelayMs: 0 };
}

test('官方独立发布仓库选择完整 GUI exe，支持 x64 与 ARM64，版本按数字比较', async () => {
  for (const [arch, cpu] of [['x64', 'amd64'], ['arm64', 'arm64']]) {
    const fixture = releaseFixture('0.1.1322', cpu);
    fixture.release.assets.unshift({ name: `magpie-cli-windows-${cpu}.exe`, size: 10 });
    const release = await fetchRelease({ arch, fetchImpl: fixture.fetchImpl, env: {} });
    assert.equal(release.asset.name, `magpie-windows-${cpu}.exe`);
    assert.equal(release.version, '0.1.1322');
  }
  assert.ok(compareVersions('0.1.10', 'v0.1.9') > 0);
  assert.equal(compareVersions('v0.1.10', '0.1.10'), 0);
  assert.throws(() => compareVersions('bad', '1.0.0'), /无效/);
});

test('下载报告进度并核对官方 digest；GitHub token 仅用于查询 API', async (t) => {
  const fixture = releaseFixture(), calls = [], progress = [], cache = cacheDir(t);
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return fixture.fetchImpl(url, options); };
  const release = await fetchRelease({ arch: 'x64', env: { GITHUB_TOKEN: 'fixture-token' }, fetchImpl });
  const downloaded = await downloadRelease(release, { fetchImpl, ...cache, onProgress: (...args) => progress.push(args) });
  assert.deepEqual(downloaded.bytes, fixture.bytes);
  assert.equal(downloaded.sha256, sha256(fixture.bytes));
  assert.deepEqual(progress.at(-1), [fixture.bytes.length, fixture.bytes.length]);
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token');
  assert.equal(calls[1].options.headers.authorization, undefined);
});

test('无 digest 时使用 SHA256SUMS；无校验、错误哈希、非官方地址和异常版本拒绝', async (t) => {
  const fixture = releaseFixture(), cache = cacheDir(t);
  const release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  release.asset.digest = undefined;
  await assert.rejects(downloadRelease(release, { fetchImpl: fixture.fetchImpl, ...cache }), /未提供/);
  release.checksum = { name: 'SHA256SUMS', url: fixture.asset.browser_download_url.replace(fixture.asset.name, 'SHA256SUMS') };
  const fetchImpl = async (url, options) => url === release.checksum.url
    ? { ok: true, body: (async function* () { yield Buffer.from(`${sha256(fixture.bytes)}  ${fixture.asset.name}\n`); })() } : fixture.fetchImpl(url, options);
  assert.deepEqual((await downloadRelease(release, { fetchImpl, ...cache })).bytes, fixture.bytes);
  release.asset.digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(downloadRelease(release, { fetchImpl, ...cache }), /不匹配/);
  release.asset.url = 'https://example.com/untrusted.exe';
  await assert.rejects(downloadRelease(release, { fetchImpl, ...cache }), /官方/);
  fixture.release.prerelease = true;
  await assert.rejects(fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl }), /正式版本/);
});

test('截断或中途断流的下载保留字节数和底层原因，查询失败明确报告', async (t) => {
  const fixture = releaseFixture(), cache = cacheDir(t), release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  await assert.rejects(downloadRelease(release, { ...cache, fetchImpl: async () => ({ ok: true, body: (async function* () { yield Buffer.from('x'); })() }) }), /下载不完整/);
  await assert.rejects(downloadRelease(release, { ...cache, fetchImpl: async () => ({ ok: true, body: (async function* () { yield Buffer.from('x'); throw new Error('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }); })() }) }), /1\/.*ECONNRESET/);
  await assert.rejects(fetchRelease({ arch: 'x64', fetchImpl: async (url) => { assert.equal(url, RELEASE_API); return { ok: false, status: 403 }; } }), /403.*限流/);
  await assert.rejects(fetchRelease({ arch: 'x64', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }); } }) }), /Release.*ECONNRESET/);
  const loop = new Error('loop'); loop.cause = loop;
  assert.equal(formatError(loop), 'loop');
  assert.match(formatError(new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })], 'connect failed')), /ECONNREFUSED/);
});

// 模拟支持 Range 的下载源：按请求头返回剩余字节；cut 指定每次连接最多传多少字节后断开。
function rangeSource(fixture, cut) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    if (url !== fixture.asset.browser_download_url) return fixture.fetchImpl(url, options);
    const range = options.headers.range;
    requests.push(range);
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)[1]) : 0;
    const rest = fixture.bytes.subarray(start);
    return {
      ok: true, status: range ? 206 : 200,
      headers: new Headers(range ? { 'content-range': `bytes ${start}-${fixture.bytes.length - 1}/${fixture.bytes.length}` } : {}),
      body: (async function* () {
        yield rest.subarray(0, cut);
        if (rest.length > cut) throw Object.assign(new Error('terminated'), { code: 'ECONNRESET' });
      })(),
    };
  };
  return { fetchImpl, requests };
}

test('断线后用 Range 续传剩余字节，校验通过后返回完整安装包', async (t) => {
  const fixture = releaseFixture(), cache = cacheDir(t), source = rangeSource(fixture, 4);
  const release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  const progress = [];
  const downloaded = await downloadRelease(release, { ...cache, fetchImpl: source.fetchImpl, onProgress: (received) => progress.push(received) });
  assert.deepEqual(downloaded.bytes, fixture.bytes);
  assert.deepEqual(source.requests, [undefined, 'bytes=4-', 'bytes=8-']);
  assert.equal(progress.at(-1), fixture.bytes.length);
  assert.ok(existsSync(downloaded.file), '校验通过的文件交给调用方安装后删除');
});

test('超过重试次数时保留部分文件，再次下载从已有字节继续；服务器忽略 Range 时从头覆盖', async (t) => {
  const fixture = releaseFixture(), cache = cacheDir(t);
  const release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  const stalled = { fetchImpl: async () => { throw new Error('stalled'); } };
  // 先下 4 字节后一直失败。
  const first = rangeSource(fixture, 4);
  let calls = 0;
  await assert.rejects(downloadRelease(release, { ...cache, fetchImpl: (url, options) => (calls++ === 0 ? first.fetchImpl : stalled.fetchImpl)(url, options) }), /4\/\d+ 字节.*再次点击会继续下载/);
  const resumed = rangeSource(fixture, 1000);
  assert.deepEqual((await downloadRelease(release, { ...cache, fetchImpl: resumed.fetchImpl })).bytes, fixture.bytes);
  assert.deepEqual(resumed.requests, ['bytes=4-']);
  // 已完整且校验通过的文件直接复用，不再联网。
  assert.deepEqual((await downloadRelease(release, { ...cache, fetchImpl: async () => { throw new Error('不应联网'); } })).bytes, fixture.bytes);
  // 部分文件存在但服务器返回 200 全量内容：截断后从头写，不拼接出错误文件。
  const [part] = readdirSync(cache.partialDir);
  writeFileSync(join(cache.partialDir, part), 'garbage');
  assert.deepEqual((await downloadRelease(release, { ...cache, fetchImpl: fixture.fetchImpl })).bytes, fixture.bytes);
});

test('续传结果哈希不符时删除部分文件，下次从头下载', async (t) => {
  const fixture = releaseFixture(), cache = cacheDir(t);
  const release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  const source = rangeSource(fixture, 1000);
  await downloadRelease(release, { ...cache, fetchImpl: source.fetchImpl });
  const [part] = readdirSync(cache.partialDir);
  writeFileSync(join(cache.partialDir, part), Buffer.alloc(fixture.bytes.length, 0x78));
  await assert.rejects(downloadRelease(release, { ...cache, fetchImpl: source.fetchImpl }), /SHA-256 不匹配/);
  assert.deepEqual(readdirSync(cache.partialDir), []);
});
