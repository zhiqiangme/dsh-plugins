/**
 * ZIP 读取器测试。
 *
 * 夹具用 fixtures/zip-builder.mjs 现场构造（stored / deflate 两种都覆盖），
 * 保证测试不依赖外部打包工具。读取器另外用真实的 GitHub release 包手工校验过
 * （v1.13.0 的 windows-amd64.zip，deflate，8.5MB）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { buildZip, crc32 } from '../fixtures/zip-builder.mjs';
import { extractZipEntry, listZipEntries } from '../lib/zip.js';

const EXE = Buffer.from('MZ-fake-opencode2api-binary\0vcs.revision=deadbeef', 'utf8');
const README = Buffer.from('# 说明\n中文内容\n', 'utf8');

test('listZipEntries：读出条目名、压缩方式与大小', () => {
  const zip = buildZip([
    { name: 'opencode2api.exe', data: EXE, method: 8 },
    { name: 'README.md', data: README, method: 0 },
  ]);
  const entries = listZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['opencode2api.exe', 'README.md'],
  );
  assert.equal(entries[0].method, 8);
  assert.equal(entries[0].uncompressedSize, EXE.length);
  assert.equal(entries[1].method, 0);
  assert.equal(entries[1].compressedSize, README.length);
});

test('extractZipEntry：stored(0) 原样取出', () => {
  const zip = buildZip([{ name: 'README.md', data: README, method: 0 }]);
  assert.deepEqual(extractZipEntry(zip, 'README.md'), README);
});

test('extractZipEntry：deflate(8) 正确解压，且真的被压缩过', () => {
  const big = Buffer.from('重复内容'.repeat(2000), 'utf8');
  const zip = buildZip([{ name: 'opencode2api.exe', data: big, method: 8 }]);
  const entry = listZipEntries(zip)[0];
  assert.ok(entry.compressedSize < big.length, '夹具应当确实压缩了');

  const out = extractZipEntry(zip, 'opencode2api.exe');
  assert.equal(out.length, big.length);
  assert.deepEqual(out, big);
});

test('extractZipEntry：多条目按名字精确命中，不误取同名子串', () => {
  const zip = buildZip([
    { name: 'opencode2api.exe', data: Buffer.from('wrong'), method: 0 },
    { name: 'bin/opencode2api.exe', data: Buffer.from('right'), method: 0 },
  ]);
  assert.equal(extractZipEntry(zip, 'bin/opencode2api.exe').toString('utf8'), 'right');
  assert.equal(extractZipEntry(zip, 'opencode2api.exe').toString('utf8'), 'wrong');
});

test('extractZipEntry：UTF-8 文件名可用', () => {
  const zip = buildZip([{ name: '配置说明.md', data: README, method: 8 }]);
  assert.deepEqual(extractZipEntry(zip, '配置说明.md'), README);
});

test('明确报错：找不到条目 / 非法 ZIP / 文件被截断', () => {
  const zip = buildZip([{ name: 'opencode2api.exe', data: EXE, method: 8 }]);

  assert.throws(() => extractZipEntry(zip, 'nope.exe'), /ZIP 里没有 nope\.exe/);
  assert.throws(() => listZipEntries(Buffer.from('这不是 zip')), /不是合法的 ZIP/);

  const truncated = zip.subarray(0, zip.length - 40);
  assert.throws(() => listZipEntries(truncated), /ZIP|截断/);
});

test('明确报错：不支持的压缩方式与加密标记', () => {
  // 手工把中央目录里的 method 改成 12（bzip2），读取器应当拒绝而不是乱解
  const zip = buildZip([{ name: 'opencode2api.exe', data: EXE, method: 8 }]);
  const patched = Buffer.from(zip);
  const centralOffset = patched.length - 22 - (46 + 'opencode2api.exe'.length);
  patched.writeUInt16LE(12, centralOffset + 10);
  assert.throws(() => extractZipEntry(patched, 'opencode2api.exe'), /不支持的压缩方式 12/);

  // 加密位（flag bit0）也要拒绝
  const encrypted = Buffer.from(zip);
  encrypted.writeUInt16LE(0x1, centralOffset + 8);
  assert.throws(() => extractZipEntry(encrypted, 'opencode2api.exe'), /加密条目/);
});

test('crc32：与已知值一致（夹具自身可信）', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  // deflate 夹具不依赖 CRC 校验，但写进头里的值应当是真的
  const zip = buildZip([{ name: 'x', data: Buffer.from('hello'), method: 0 }]);
  assert.equal(zip.readUInt32LE(14), crc32(Buffer.from('hello')));
  assert.ok(deflateRawSync(Buffer.from('hello')).length > 0);
});
