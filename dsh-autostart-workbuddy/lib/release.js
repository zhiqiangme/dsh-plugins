/**
 * GitHub Release 通道：查最新 release、挑资产、下载、核对 checksums。
 *
 * 为什么更新源是 Release 而不是 main 分支：main 随时会动，而且不带校验和；
 * release 是 CI 打包好的产物 + `checksums.txt`，能校验、能固定版本、能回滚。
 *
 * 这一层只管网络与字节，不碰文件布局（那是 backend.js 的事），
 * 所以测试可以把它指向本地假服务器，不需要真的访问 GitHub。
 *
 * 只依赖 node: 内置模块（fetch / crypto 都是 Node 内置）。
 */

import { createHash } from 'node:crypto';

/** 上游仓库（wb2api）。hub 网关用自己的仓库，经 `repo` 参数传进来（见 lib/hub.js）。 */
export const REPO = Object.freeze({ owner: 'linguo2625469', name: 'workbuddy2api-panel' });

export const DEFAULT_API_BASE = 'https://api.github.com';

/** 我们只吃 Windows 版产物；命名形如 `wb2api-panel-v1.13.0-windows-amd64.zip`。 */
export const WINDOWS_ASSET_PATTERN = /-windows-amd64\.zip$/i;

/** 校验和文件名。 */
export const CHECKSUMS_NAME = 'checksums.txt';

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
    'user-agent': 'dsh-autostart-workbuddy',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** 超时与插件关闭任一发生都取消请求，包体读取也沿用同一个信号。 */
const requestSignal = (signal, timeoutMs) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

/** fetch 的 message 常只有 terminated / fetch failed；底层 socket 错误与错误码在 cause 里。 */
export function formatError(error) {
  const parts = [];
  // 异常链可能有循环或包含大量连接失败，最多展开 10 个节点，避免面板被错误信息撑满。
  const seen = new Set();
  function visit(value) {
    if (value == null || seen.has(value) || seen.size >= 10) return;
    seen.add(value);
    const message = value instanceof Error ? value.message : String(value);
    const detail = value.code ? `${value.code}: ${message}` : message;
    // 网络层的包装错误已经包含原因时，不再把同一段重复展示。
    if (detail && !parts.some((part) => part.includes(detail))) parts.push(detail);
    if (seen.size < 10) {
      visit(value.cause);
      if (value instanceof AggregateError) value.errors.forEach(visit);
    }
  }
  visit(error);
  return parts.join(' ← ');
}

async function getJson(url, { env, timeoutMs = 20_000, signal } = {}) {
  try {
    const response = await fetch(url, { headers: requestHeaders(env), signal: requestSignal(signal, timeoutMs) });
    if (!response.ok) {
      const hint = response.status === 403 || response.status === 429 ? '（可能是 GitHub API 限流，配置 GITHUB_TOKEN 可提高额度）' : '';
      throw new Error(`返回 ${response.status}${hint}`);
    }
    // await 必须留在 try 内：响应头成功后，JSON 内容仍可能传到一半就断开。
    return await response.json();
  } catch (error) {
    throw new Error(`请求 ${url} 失败：${formatError(error)}`, { cause: error });
  }
}

/**
 * 查最新 release，并解析出它对应的 commit。
 *
 * 为什么要额外查 commit：release 的 `target_commitish` 只写 `main`，
 * 而本地 exe 里能读到的只有 commit（`vcs.revision`）。要判定"是否最新"，
 * 必须把 tag 换算成 commit 才能比较。
 */
export async function fetchLatestRelease({ env, apiBase = DEFAULT_API_BASE, timeoutMs, repo = REPO, resolveCommit = true, signal } = {}) {
  const release = await getJson(`${apiBase}/repos/${repo.owner}/${repo.name}/releases/latest`, { env, timeoutMs, signal });
  const tag = typeof release?.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag) throw new Error('release 数据里没有 tag_name');

  // hub 的版本身份是包内 release-manifest.json 的 tag，不需要 commit：省一次 API 调用（匿名额度只有 60 次/小时）。
  let commit = '';
  if (resolveCommit) {
    const commitInfo = await getJson(`${apiBase}/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(tag)}`, {
      env,
      timeoutMs,
      signal,
    });
    commit = typeof commitInfo?.sha === 'string' ? commitInfo.sha : '';
  }

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
export function pickWindowsAsset(assets, pattern = WINDOWS_ASSET_PATTERN, label = 'windows-amd64') {
  const asset = (assets ?? []).find((item) => pattern.test(item.name));
  if (!asset) {
    const names = (assets ?? []).map((item) => item.name).join(', ') || '(无资产)';
    throw new Error(`release 里没有 ${label} 产物，现有资产：${names}`);
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
  let received = 0;
  let total = asset.size || 0;
  try {
    const response = await fetch(asset.url, { headers: requestHeaders(env), signal: requestSignal(signal, timeoutMs) });
    if (!response.ok) throw new Error(`返回 ${response.status}`);

    total = Number(response.headers.get('content-length')) || total;
    const chunks = [];
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
  } catch (error) {
    throw new Error(`下载 ${asset.name} 失败（已读取 ${received}/${total || '?'} 字节）：${formatError(error)}`, { cause: error });
  }
}

/**
 * 取同一 release 里的校验和文件；没有就返回空表（调用方据此决定是否强制校验）。
 * `names` 按先后找第一个存在的（hub 同时发 checksums.txt 与 SHA256SUMS，内容一致）。
 */
export async function fetchChecksums(release, { env, apiBase = DEFAULT_API_BASE, timeoutMs, names = [CHECKSUMS_NAME], signal } = {}) {
  const asset = names.map((name) => (release.assets ?? []).find((item) => item.name === name)).find(Boolean);
  if (!asset) return new Map();
  try {
    const response = await fetch(asset.url, { headers: requestHeaders(env), signal: requestSignal(signal, timeoutMs ?? 30_000) });
    if (!response.ok) throw new Error(`返回 ${response.status}`);
    return parseChecksums(await response.text());
  } catch (error) {
    throw new Error(`下载校验文件 ${asset.name} 失败：${formatError(error)}`, { cause: error });
  }
}

/**
 * 校验下载下来的字节。
 *
 * @returns {{ ok: boolean, reason?: string, actual: string, expected?: string }}
 */
export function verifyChecksum(buffer, assetName, checksums) {
  const actual = sha256(buffer);
  if (!checksums || checksums.size === 0) {
    return { ok: false, reason: 'release 没有提供 checksums.txt，拒绝安装未校验的产物', actual };
  }
  const expected = checksums.get(assetName);
  if (!expected) return { ok: false, reason: `checksums.txt 里没有 ${assetName}`, actual };
  if (expected !== actual) {
    return { ok: false, reason: `sha256 不匹配（期望 ${expected}，实际 ${actual}）`, actual, expected };
  }
  return { ok: true, actual, expected };
}
