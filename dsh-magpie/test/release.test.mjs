import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRelease, downloadRelease, compareVersions, formatError, RELEASE_API, sha256 } from '../lib/release.js';
import { releaseFixture } from '../fixtures/backend.mjs';

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

test('下载报告进度并核对官方 digest；GitHub token 仅用于查询 API', async () => {
  const fixture = releaseFixture(), calls = [], progress = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return fixture.fetchImpl(url, options); };
  const release = await fetchRelease({ arch: 'x64', env: { GITHUB_TOKEN: 'fixture-token' }, fetchImpl });
  const downloaded = await downloadRelease(release, { fetchImpl, onProgress: (...args) => progress.push(args) });
  assert.deepEqual(downloaded.bytes, fixture.bytes);
  assert.equal(downloaded.sha256, sha256(fixture.bytes));
  assert.deepEqual(progress.at(-1), [fixture.bytes.length, fixture.bytes.length]);
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token');
  assert.equal(calls[1].options.headers.authorization, undefined);
});

test('无 digest 时使用 SHA256SUMS；无校验、错误哈希、非官方地址和异常版本拒绝', async () => {
  const fixture = releaseFixture();
  const release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  release.asset.digest = undefined;
  await assert.rejects(downloadRelease(release, { fetchImpl: fixture.fetchImpl }), /未提供/);
  release.checksum = { name: 'SHA256SUMS', url: fixture.asset.browser_download_url.replace(fixture.asset.name, 'SHA256SUMS') };
  const fetchImpl = async (url, options) => url === release.checksum.url
    ? { ok: true, body: (async function* () { yield Buffer.from(`${sha256(fixture.bytes)}  ${fixture.asset.name}\n`); })() } : fixture.fetchImpl(url, options);
  assert.deepEqual((await downloadRelease(release, { fetchImpl })).bytes, fixture.bytes);
  release.asset.digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(downloadRelease(release, { fetchImpl }), /不匹配/);
  release.asset.url = 'https://example.com/untrusted.exe';
  await assert.rejects(downloadRelease(release, { fetchImpl }), /官方/);
  fixture.release.prerelease = true;
  await assert.rejects(fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl }), /正式版本/);
});

test('截断或中途断流的下载保留字节数和底层原因，查询失败明确报告', async () => {
  const fixture = releaseFixture(), release = await fetchRelease({ arch: 'x64', fetchImpl: fixture.fetchImpl });
  await assert.rejects(downloadRelease(release, { fetchImpl: async () => ({ ok: true, body: (async function* () { yield Buffer.from('x'); })() }) }), /下载不完整/);
  await assert.rejects(downloadRelease(release, { fetchImpl: async () => ({ ok: true, body: (async function* () { yield Buffer.from('x'); throw new Error('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }); })() }) }), /1\/.*ECONNRESET/);
  await assert.rejects(fetchRelease({ arch: 'x64', fetchImpl: async (url) => { assert.equal(url, RELEASE_API); return { ok: false, status: 403 }; } }), /403.*限流/);
  await assert.rejects(fetchRelease({ arch: 'x64', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }); } }) }), /Release.*ECONNRESET/);
  const loop = new Error('loop'); loop.cause = loop;
  assert.equal(formatError(loop), 'loop');
  assert.match(formatError(new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })], 'connect failed')), /ECONNREFUSED/);
});
