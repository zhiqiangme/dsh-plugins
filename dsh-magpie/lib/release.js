// 沿用 WorkBuddy 的 Release → 下载 → SHA-256 校验流程；Magpie 发布在独立仓库，产物是裸 exe。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export const RELEASE_REPO = 'yetone/magpie-releases';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const MAX_DOWNLOAD = 256 * 1024 * 1024;
// 慢速网络下 60 MB 可能要下十几分钟，不设总时长；只在持续无数据时断开并续传。
const IDLE_TIMEOUT = 30_000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY = 2_000;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const versionOf = (value) => /^v?(\d+\.\d+\.\d+)$/.exec(String(value ?? '').trim())?.[1];
export function compareVersions(a, b) {
  if (!versionOf(a) || !versionOf(b)) throw new Error('Magpie 版本号无效');
  const left = versionOf(a).split('.').map(Number), right = versionOf(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function formatError(error) {
  const parts = [], seen = new Set();
  function visit(current) {
    // 聚合连接错误和 cause 可能成环或很长，限制展开量，避免错误面板失控。
    if (!current || seen.has(current) || seen.size >= 8) return;
    seen.add(current);
    const detail = `${current.code ? `${current.code}: ` : ''}${current.message ?? String(current)}`;
    if (detail && !parts.some((part) => part.includes(detail))) parts.push(detail);
    visit(current.cause);
    if (current instanceof AggregateError) current.errors.forEach(visit);
  }
  visit(error);
  return parts.join(' ← ');
}
const signalFor = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
function assetURL(asset, tag) {
  const url = new URL(asset.url);
  const prefix = `https://github.com/${RELEASE_REPO}/releases/download/${encodeURIComponent(tag)}/`;
  if (!url.href.startsWith(prefix) || url.href !== `${prefix}${encodeURIComponent(asset.name)}`) throw new Error('Magpie 安装包地址不是官方 Release');
  return url.href;
}

export async function fetchRelease({ env = process.env, fetchImpl = fetch, signal, arch = process.arch } = {}) {
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!cpu) throw new Error('Magpie 下载仅支持 Windows x64 / ARM64');
  try {
    const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
    const response = await fetchImpl(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-magpie', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: signalFor(signal, 20_000) });
    if (!response.ok) throw new Error(`查询 Magpie Release 返回 HTTP ${response.status}${[403, 429].includes(response.status) ? '（可能是 GitHub 限流）' : ''}`);
    const body = await response.json();
    const version = versionOf(body.tag_name);
    if (!version || body.draft || body.prerelease) throw new Error('Magpie Release 不是有效的正式版本');
    const name = `magpie-windows-${cpu}.exe`;
    const asset = body.assets?.find((item) => item.name === name);
    if (!asset || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_DOWNLOAD) throw new Error(`Release 缺少有效的 ${name} 安装包`);
    const selected = { name, size: asset.size, url: asset.browser_download_url, digest: asset.digest };
    assetURL(selected, body.tag_name);
    const sums = body.assets?.find((item) => item.name === 'SHA256SUMS');
    const checksum = sums ? { name: sums.name, url: sums.browser_download_url } : undefined;
    if (checksum) assetURL(checksum, body.tag_name);
    return { tag: body.tag_name, version, url: `https://github.com/${RELEASE_REPO}/releases/tag/${encodeURIComponent(body.tag_name)}`, publishedAt: body.published_at, asset: selected, checksum };
  } catch (error) { throw new Error(`检查 Magpie Release 失败：${formatError(error)}`, { cause: error }); }
}

async function readAsset(asset, { fetchImpl, signal, maxBytes, onProgress }) {
  let received = 0;
  try {
    const response = await fetchImpl(asset.url, { headers: { 'user-agent': 'dsh-magpie' }, signal: signalFor(signal, 180_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parts = [];
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      received = bytes.length; parts.push(bytes);
    } else for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) throw new Error('下载超过大小限制');
      parts.push(Buffer.from(chunk)); onProgress?.(received, asset.size || received);
    }
    if (received > maxBytes || (asset.size && received !== asset.size)) throw new Error('下载不完整或大小不符');
    signal?.throwIfAborted();
    return Buffer.concat(parts);
  } catch (error) {
    throw new Error(`下载 ${asset.name} 失败（${received}/${asset.size || '?'} 字节）：${formatError(error)}`, { cause: error });
  }
}

const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (!ms) return resolve();
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', stop); resolve(); }
  function stop() { clearTimeout(timer); reject(signal.reason); }
  signal?.addEventListener('abort', stop, { once: true });
});

/** 把剩余字节续写进 file；服务器忽略 Range 时从头覆盖。返回本次结束时的文件长度。 */
async function appendAsset(asset, file, start, { fetchImpl, signal, onProgress }) {
  const idle = new AbortController();
  let timer;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error(`${IDLE_TIMEOUT / 1000} 秒没有收到数据`)), IDLE_TIMEOUT); };
  kick();
  const handle = await open(file, start ? 'r+' : 'w');
  let offset = start;
  try {
    const response = await fetchImpl(asset.url, {
      headers: { 'user-agent': 'dsh-magpie', ...(start ? { range: `bytes=${start}-` } : {}) },
      signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
    });
    if (start && response.status === 416) { await handle.truncate(0); throw new Error('续传位置无效，已清除部分文件'); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (start && response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(response.headers?.get?.('content-range') ?? '');
      if (Number(range?.[1]) !== start) { await handle.truncate(0); throw new Error('服务器返回的续传范围不符，已清除部分文件'); }
    } else if (start) { offset = 0; await handle.truncate(0); }
    const chunks = response.body ?? [Buffer.from(await response.arrayBuffer())];
    for await (const chunk of chunks) {
      kick();
      if (offset + chunk.length > asset.size) throw new Error('下载超过 Release 声明的大小');
      await handle.write(chunk, 0, chunk.length, offset);
      offset += chunk.length;
      onProgress?.(offset, asset.size);
    }
    return offset;
  } finally { clearTimeout(timer); await handle.close(); }
}

/**
 * 安装包按预期哈希命名，写在 partialDir：断线后本次自动续传，失败后再点下载也从已有字节续传；
 * 换了 Release（哈希不同）不会续到旧文件上。校验通过的文件由调用方在安装成功后删除。
 */
async function downloadAsset(asset, expected, { fetchImpl, signal, onProgress, partialDir, retryDelayMs }) {
  mkdirSync(partialDir, { recursive: true });
  const file = join(partialDir, `${asset.name}.${expected.slice(0, 16)}.part`);
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    let start = sizeOf(file);
    if (start > asset.size) { rmSync(file, { force: true }); start = 0; }
    if (start === asset.size) break;
    try {
      if (await appendAsset(asset, file, start, { fetchImpl, signal, onProgress }) === asset.size) break;
      throw new Error('下载不完整或大小不符');
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await wait(retryDelayMs * attempt, signal);
    }
  }
  const received = sizeOf(file);
  if (received !== asset.size) {
    throw new Error(`下载 ${asset.name} 失败（${received}/${asset.size} 字节，已尝试 ${MAX_ATTEMPTS} 次，再次点击会继续下载）：${formatError(lastError)}`, { cause: lastError });
  }
  const bytes = readFileSync(file);
  if (sha256(bytes) !== expected) { rmSync(file, { force: true }); throw new Error('Magpie 安装包 SHA-256 不匹配，已删除下载文件，现有程序未更改'); }
  return { bytes, file };
}

export async function downloadRelease(release, { fetchImpl = fetch, signal, onProgress, partialDir, retryDelayMs = RETRY_DELAY } = {}) {
  if (!partialDir) throw new Error('缺少下载缓存目录');
  assetURL(release.asset, release.tag);
  let expected = /^sha256:([a-f0-9]{64})$/i.exec(release.asset.digest ?? '')?.[1]?.toLowerCase();
  if (!expected) {
    if (!release.checksum) throw new Error('官方 Release 未提供 SHA-256，拒绝安装未校验的文件');
    assetURL(release.checksum, release.tag);
    const text = (await readAsset(release.checksum, { fetchImpl, signal, maxBytes: 64 * 1024 })).toString('utf8');
    expected = text.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line)).find((match) => match?.[2] === release.asset.name)?.[1]?.toLowerCase();
    if (!expected) throw new Error('SHA256SUMS 缺少当前 Magpie 安装包的校验值');
  }
  const { bytes, file } = await downloadAsset(release.asset, expected, { fetchImpl, signal, onProgress, partialDir, retryDelayMs });
  return { bytes, sha256: expected, file };
}
