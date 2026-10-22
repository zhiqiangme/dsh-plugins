// 沿用 WorkBuddy 的 Release → 下载 → SHA-256 校验流程；Magpie 发布在独立仓库，产物是裸 exe。
import { createHash } from 'node:crypto';

export const RELEASE_REPO = 'yetone/magpie-releases';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const MAX_DOWNLOAD = 256 * 1024 * 1024;
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

export async function downloadRelease(release, { fetchImpl = fetch, signal, onProgress } = {}) {
  assetURL(release.asset, release.tag);
  let expected = /^sha256:([a-f0-9]{64})$/i.exec(release.asset.digest ?? '')?.[1]?.toLowerCase();
  if (!expected) {
    if (!release.checksum) throw new Error('官方 Release 未提供 SHA-256，拒绝安装未校验的文件');
    assetURL(release.checksum, release.tag);
    const text = (await readAsset(release.checksum, { fetchImpl, signal, maxBytes: 64 * 1024 })).toString('utf8');
    expected = text.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line)).find((match) => match?.[2] === release.asset.name)?.[1]?.toLowerCase();
    if (!expected) throw new Error('SHA256SUMS 缺少当前 Magpie 安装包的校验值');
  }
  const bytes = await readAsset(release.asset, { fetchImpl, signal, maxBytes: MAX_DOWNLOAD, onProgress });
  if (sha256(bytes) !== expected) throw new Error('Magpie 安装包 SHA-256 不匹配，现有程序未更改');
  return { bytes, sha256: expected };
}
