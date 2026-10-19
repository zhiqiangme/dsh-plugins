/**
 * 从 jasonxu114514/opencode2api 的 GitHub Release 选择 Windows 资产。
 * 使用相邻的 <archive>.sha256 校验下载内容，绝不安装未校验的程序。
 */

import { createHash } from 'node:crypto';

/** 上游仓库。 */
export const REPO = Object.freeze({ owner: 'jasonxu114514', name: 'opencode2api' });

export const DEFAULT_API_BASE = 'https://api.github.com';

/** 正式资产使用下划线命名，例如 opencode2api_v1.4.0_windows_amd64.zip。 */
export const WINDOWS_ASSET_PATTERN = /_windows_(amd64|arm64)\.zip$/i;


export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 有 token 就用：匿名调用 GitHub API 只有 60 次/小时，本机 `gh` 已登录的话
 * 把 token 放进 GITHUB_TOKEN / GH_TOKEN 环境变量即可（插件不去翻别人的凭据文件）。
 */
function requestHeaders(env) {
  const token = typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim()
    : typeof env?.GH_TOKEN === 'string' ? env.GH_TOKEN.trim()
    : '';
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-opencode2api',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

const requestSignal = (signal, timeoutMs) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

async function getJson(url, { env, timeoutMs = 20_000, signal } = {}) {
  let response;
  try {
    response = await fetch(url, { headers: requestHeaders(env), signal: requestSignal(signal, timeoutMs) });
  } catch (error) {
    throw new Error(`请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const hint = response.status === 403 || response.status === 429 ? '（可能是 GitHub API 限流，配置 GITHUB_TOKEN 可提高额度）' : '';
    throw new Error(`${url} 返回 ${response.status}${hint}`);
  }
  return response.json();
}

/**
 * 查最新 release，并解析出它对应的 commit。
 *
 * 为什么要额外查 commit：release 的 `target_commitish` 只写 `main`，
 * 而本地 exe 里能读到的只有 commit（`vcs.revision`）。要判定"是否最新"，
 * 必须把 tag 换算成 commit 才能比较。
 */
export async function fetchLatestRelease({ env, apiBase = DEFAULT_API_BASE, timeoutMs, signal } = {}) {
  const release = await getJson(`${apiBase}/repos/${REPO.owner}/${REPO.name}/releases/latest`, { env, timeoutMs, signal });
  const tag = typeof release?.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag) throw new Error('release 数据里没有 tag_name');

  const commitInfo = await getJson(`${apiBase}/repos/${REPO.owner}/${REPO.name}/commits/${encodeURIComponent(tag)}`, {
    env,
    timeoutMs,
    signal,
  });
  const commit = typeof commitInfo?.sha === 'string' ? commitInfo.sha : '';

  const assets = Array.isArray(release.assets)
    ? release.assets
        .filter((asset) => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
        .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 }))
    : [];

  return {
    tag,
    commit,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    notes: typeof release.body === 'string' ? release.body : '',
    assets,
  };
}

/** 从资产列表里挑出 Windows 产物；挑不到就明确报错（而不是拿错平台的包去替换）。 */
export function pickWindowsAsset(assets, arch = process.arch) {
  const target = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!target) throw new Error(`不支持的 Windows 架构：${arch}`);
  const asset = (assets ?? []).find((item) => item.name.endsWith(`_windows_${target}.zip`));
  if (!asset) {
    const names = (assets ?? []).map((item) => item.name).join(', ') || '(无资产)';
    throw new Error(`release 里没有 windows_${target} 产物，现有资产：${names}`);
  }
  return asset;
}

/**
 * 解析 `sha256sum` 风格的内容：`<64位hash>  <文件名>`，允许前后空行与注释。
 *
 * @returns {Map<string, string>} 文件名 → 小写 sha256
 */
export function parseChecksums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

/** 下载资产到内存；进度通过 onProgress(已下载字节, 总字节) 回调。 */
export async function downloadAsset(asset, { env, timeoutMs = 120_000, onProgress, signal } = {}) {
  let response;
  try {
    response = await fetch(asset.url, { headers: requestHeaders(env), signal: requestSignal(signal, timeoutMs) });
  } catch (error) {
    throw new Error(`下载 ${asset.name} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`下载 ${asset.name} 返回 ${response.status}`);

  const total = Number(response.headers.get('content-length')) || asset.size || 0;
  const chunks = [];
  let received = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      onProgress?.(received, total);
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    received = buffer.length;
    onProgress?.(received, total);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 取同一 release 里的对应 .sha256；缺失时返回空表，由安装器拒绝安装。 */
export async function fetchChecksums(release, { env, timeoutMs, assetName, signal } = {}) {
  // 上游每个压缩包单独发布 <archive>.sha256，不提供汇总 checksums.txt。
  const name = assetName ? `${assetName}.sha256` : `${pickWindowsAsset(release.assets).name}.sha256`;
  const asset = (release.assets ?? []).find((item) => item.name === name);
  if (!asset) return new Map();
  const response = await fetch(asset.url, { headers: requestHeaders(env), signal: requestSignal(signal, timeoutMs ?? 30_000) });
  if (!response.ok) throw new Error(`下载 ${name} 返回 ${response.status}`);
  return parseChecksums(await response.text());
}

/**
 * 校验下载下来的字节。
 *
 * @returns {{ ok: boolean, reason?: string, actual: string, expected?: string }}
 */
export function verifyChecksum(buffer, assetName, checksums) {
  const actual = sha256(buffer);
  if (!checksums || checksums.size === 0) {
    return { ok: false, reason: 'release 没有提供匹配的 .sha256，拒绝安装未校验的产物', actual };
  }
  const expected = checksums.get(assetName);
  if (!expected) return { ok: false, reason: `校验和文件里没有 ${assetName}`, actual };
  if (expected !== actual) {
    return { ok: false, reason: `sha256 不匹配（期望 ${expected}，实际 ${actual}）`, actual, expected };
  }
  return { ok: true, actual, expected };
}
