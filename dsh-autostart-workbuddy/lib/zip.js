/**
 * 极简 ZIP 读取器：只服务一个场景——从 release 资产里取出 `wb2api.exe`。
 *
 * 为什么自己写：本插件只依赖 node: 内置模块（见 services.js 顶部注释），而 Node 自带
 * zlib 却没有 zip 容器解析；为了取一个文件去引依赖不值当。真正需要的很少：
 * 中央目录 → 本地头 → inflateRaw。
 *
 * ZIP64、加密条目、多卷一律**明确拒绝**——8MB 的 exe 用不到这些形态，
 * 认不出来就报错，比按猜测解压安全。
 *
 * 不做 CRC 校验：调用方在解压前已经核对过整个 zip 的 sha256（见 release.js），
 * 再叠一层 CRC 只是重复劳动。
 */

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** EOCD 之后最多还有 64KB 的注释，所以从尾部往前扫这个范围。 */
const EOCD_MAX_SCAN = 66_000;

function findEocd(buffer) {
  const from = Math.max(0, buffer.length - EOCD_MAX_SCAN);
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 列出归档里的条目（只读中央目录，不碰数据）。
 *
 * @returns {{ name: string, method: number, flags: number, compressedSize: number, uncompressedSize: number, localOffset: number }[]}
 */
export function listZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到中央目录结尾记录');

  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('不支持 ZIP64 归档');
  }
  if (cdOffset + cdSize > buffer.length) throw new Error('ZIP 中央目录越界（文件被截断？）');

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length) throw new Error('ZIP 中央目录项越界');
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) throw new Error('ZIP 中央目录项签名不符');

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      flags: buffer.readUInt16LE(offset + 8),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 取出单个条目的内容；压缩方式只支持 stored(0) 与 deflate(8)。 */
export function extractZipEntry(buffer, wanted) {
  const entry = listZipEntries(buffer).find((item) => item.name === wanted);
  if (!entry) throw new Error(`ZIP 里没有 ${wanted}`);
  if (entry.flags & 0x1) throw new Error(`${wanted} 是加密条目，拒绝解压`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${wanted} 使用了不支持的压缩方式 ${entry.method}`);
  }
  if (entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff) {
    throw new Error('不支持 ZIP64 条目');
  }

  const local = entry.localOffset;
  if (local + 30 > buffer.length) throw new Error('ZIP 本地头越界');
  if (buffer.readUInt32LE(local) !== SIG_LOCAL) throw new Error('ZIP 本地头签名不符');

  // 本地头的名字/扩展区长度可能与中央目录不同（扩展区尤其常见），必须以本地头为准。
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error('ZIP 条目数据越界');

  const raw = buffer.subarray(start, end);
  const data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`${wanted} 解压后大小不符（期望 ${entry.uncompressedSize}，实际 ${data.length}）`);
  }
  return data;
}
