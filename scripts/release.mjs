// 各独立包共享发布流程；只依赖 Node、Git 和 npm，不改变现有包结构。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPOSITORY = 'zhiqiangme/dsh-plugins';
export const PLUGINS = [
  { id: 'workbuddy', directory: 'dsh-autostart-workbuddy', name: '@zhiqiangme/dsh-autostart-workbuddy' },
  { id: 'opencode2api', directory: 'dsh-opencode2api', name: '@zhiqiangme/dsh-opencode2api' },
  { id: 'tavily-search', directory: 'dsh-tavily-search', name: '@zhiqiangme/dsh-tavily-search' },
  { id: 'magpie', directory: 'dsh-magpie', name: '@zhiqiangme/dsh-magpie' },
];

function pluginById(id) {
  const plugin = PLUGINS.find((item) => item.id === id);
  if (!plugin) throw new Error(`未知插件：${id}`);
  return plugin;
}

// 当前只发布三段数字的正式版；预发布需要另外约定 npm dist-tag。
export function compareVersions(left, right) {
  const parse = (version) => {
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error(`版本号必须是无前导零的三段正式版：${version}`);
    }
    return version.split('.').map(BigInt);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function command(executable, args, cwd, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args[0]} 失败：${result.error?.message || result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
  return result.stdout?.trim() || '';
}

function git(cwd, ...args) {
  return command('git', args, cwd);
}

function manifestAt(cwd, sha, plugin, optional = false) {
  // 新增独立插件在 push.before 尚不存在；仅缺文件算新包，Git/JSON 错误仍应停止发布。
  if (optional && !git(cwd, 'ls-tree', '--name-only', sha, '--', `${plugin.directory}/package.json`)) return undefined;
  return JSON.parse(git(cwd, 'show', `${sha}:${plugin.directory}/package.json`));
}

function validateManifest(plugin, manifest) {
  if (manifest.name !== plugin.name || manifest.private) throw new Error(`${plugin.id} 的包名或 private 配置不正确`);
  compareVersions(manifest.version, manifest.version);
  if (manifest.repository?.url !== `git+https://github.com/${REPOSITORY}.git`
      || manifest.repository.directory !== plugin.directory) {
    throw new Error(`${plugin.id} 的 repository 必须指向 ${REPOSITORY}/${plugin.directory}`);
  }
}

export function planReleases({ cwd = process.cwd(), before, manual = false, plugin, sha } = {}) {
  const head = git(cwd, 'rev-parse', 'HEAD');
  let target = head;
  if (manual) {
    pluginById(plugin);
    if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('补发必须指定原始发布提交的完整 40 位 SHA');
    target = git(cwd, 'rev-parse', '--verify', `${sha}^{commit}`);
    git(cwd, 'merge-base', '--is-ancestor', target, head);
  } else {
    // 分支首次创建/强推没有可靠的版本差异基线，不能据此批量发布历史版本。
    if (!/^[a-f0-9]{40}$/.test(before || '') || /^0+$/.test(before)) throw new Error('缺少有效的 push.before；请指定原始提交手动补发');
    git(cwd, 'merge-base', '--is-ancestor', before, head);
  }
  const releases = [];
  for (const item of manual ? [pluginById(plugin)] : PLUGINS) {
    const current = manifestAt(cwd, target, item);
    validateManifest(item, current);
    if (!manual) {
      const previous = manifestAt(cwd, before, item, true);
      if (previous) {
        const comparison = compareVersions(current.version, previous.version);
        if (comparison < 0) throw new Error(`${item.id} 版本号不能倒退：${previous.version} → ${current.version}`);
        if (comparison === 0) continue;
      }
    }
    releases.push({ plugin: item.id, version: current.version });
  }
  return { sha: target, releases };
}

export function validatePack(plugin, manifest, packed) {
  if (packed.name !== plugin.name || packed.version !== manifest.version || !/^[\w.-]+\.tgz$/.test(packed.filename)) {
    throw new Error('npm pack 产物的包名、版本或文件名不正确');
  }
  const files = new Set(packed.files.map((item) => item.path));
  const required = ['package.json', 'README.md', 'LICENSE', manifest.main, manifest.icon, manifest.dsh?.bundle?.patch];
  const exports = (value) => typeof value === 'string' ? [value] : Object.values(value || {}).flatMap(exports);
  required.push(...exports(manifest.exports).filter((path) => !path.includes('*')));
  for (const path of required) {
    if (path && !files.has(path.replace(/^\.\//, ''))) throw new Error(`发布包缺少文件：${path}`);
  }
  for (const path of files) {
    if (!/^(package\.json|README\.md|LICENSE|cordis\.patch\.yml|(?:lib|icons|locale)\/[^\s]+)$/.test(path)
        || /(?:^|\/)(?:\.env(?:\..*)?|node_modules|test|fixtures)(?:\/|$)|\.(?:exe|dll|pem|key)$/i.test(path)
        || path.split('/').includes('..')) {
      throw new Error(`发布包包含非预期文件：${path}`);
    }
  }
}

function packPackage(plugin, manifest, cwd) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-release-'));
  try {
    // 发布 job 固定在 Linux；禁止生命周期脚本改变已经测试过的源码。
    const [packed] = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], join(cwd, plugin.directory)));
    validatePack(plugin, manifest, packed);
    const file = join(directory, packed.filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
    if (packed.integrity !== integrity) throw new Error('npm pack 产物完整性不匹配');
    return { file, integrity, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function registryMetadata(name, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return { versions: {} };
  if (!response.ok) throw new Error(`npm 查询失败：HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata.versions || typeof metadata.versions !== 'object') throw new Error('npm 返回了无效的版本元数据');
  return metadata;
}

export async function registryVersion(name, version, fetchImpl = fetch) {
  // 包列表可能在发布后仍返回旧缓存，精确版本端点用于发布确认和重跑防重发。
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm 精确版本查询失败：HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.name !== name || manifest.version !== version || typeof manifest.dist?.integrity !== 'string') {
    throw new Error('npm 返回了无效的精确版本元数据');
  }
  return manifest;
}

// 2026-10-19 opencode2api 26.10.19 的 npm 命令成功后，版本超过 5 分钟才可见。
// 前段快速核对，之后每 30 秒轮询，留出约 10 分钟的传播窗口；期间绝不重复发布。
export const PUBLISH_VISIBILITY_DELAYS = [0, 2_000, 5_000, 10_000, 15_000, ...Array(19).fill(30_000)];

export async function waitForPublishedVersion(name, version, integrity, {
  readVersion = registryVersion,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = console.log,
  // 等待期间只读核对；发布命令成功后绝不自动重发。
  delays = PUBLISH_VISIBILITY_DELAYS,
} = {}) {
  let waited = 0;
  for (const [index, delay] of delays.entries()) {
    if (delay) await wait(delay);
    waited += delay;
    const published = await readVersion(name, version);
    if (!published) {
      log(`npm ${name}@${version} 暂未可见（第 ${index + 1}/${delays.length} 次核对，累计等待 ${waited / 1_000} 秒）`);
      continue;
    }
    verifyPublished({ versions: { [version]: published } }, version, integrity);
    log(`npm ${name}@${version} 已可见，包完整性核对通过`);
    return;
  }
  throw new Error(`npm 发布命令已成功，但等待 ${waited / 1_000} 秒后精确版本仍未可见；请使用原始 SHA 重跑补齐 GitHub Release`);
}

export function verifyPublished(metadata, version, integrity) {
  const existing = metadata.versions[version];
  if (existing) {
    if (existing.dist?.integrity !== integrity) throw new Error(`${version} 已存在，但发布包内容不同，不能覆盖`);
    return true;
  }
  for (const published of Object.keys(metadata.versions)) {
    if (/^\d+\.\d+\.\d+$/.test(published) && compareVersions(version, published) <= 0) {
      throw new Error(`${version} 必须高于 npm 已发布版本 ${published}`);
    }
  }
  return false;
}

export function githubClient(token, fetchImpl = fetch) {
  return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} 失败：HTTP ${response.status}`);
    return response.json();
  };
}

async function tagCommit(api, tag) {
  const ref = await api(`git/ref/tags/${tag}`, { allowMissing: true });
  if (!ref) return undefined;
  let object = ref.object;
  // 同时接受历史 annotated tag 和本流程创建的 lightweight tag。
  for (let depth = 0; object.type === 'tag' && depth < 5; depth += 1) {
    object = (await api(`git/tags/${object.sha}`)).object;
  }
  if (object.type !== 'commit') throw new Error(`${tag} 未指向有效提交`);
  return object.sha;
}

function releaseNotes(cwd, plugin, version, sha, tag) {
  const previous = git(cwd, 'tag', '--merged', sha, '--list', `${plugin.id}-v*`)
    .split('\n').filter((name) => name && name !== tag && /^\d+\.\d+\.\d+$/.test(name.slice(plugin.id.length + 2)))
    .filter((name) => compareVersions(name.slice(plugin.id.length + 2), version) < 0)
    .sort((a, b) => compareVersions(b.slice(plugin.id.length + 2), a.slice(plugin.id.length + 2)))[0];
  const history = git(cwd, 'log', '--format=- %s (%h)', previous ? `${previous}..${sha}` : sha, '--', plugin.directory);
  return `${plugin.name}@${version}\n\n源码提交：${sha}\n\n## 更新\n\n${history || '版本更新。'}\n\n## 安装 / 更新\n\n\`\`\`powershell\ndsh plugin --profile desktop add ${plugin.name}@${version}\ndsh plugin --profile desktop update --latest ${plugin.name}\n\`\`\`\n\n更新后重启 DSH。\n`;
}

export async function publishRelease({ cwd, plugin: id, sha }, {
  api = githubClient(process.env.GH_TOKEN), metadata = registryMetadata, versionMetadata = registryVersion, pack = packPackage,
  // npm 的输出直接交给 Actions；认证或网络重试卡住时最多等待 5 分钟。
  publish = (file) => command('npm', ['publish', file, '--access', 'public', '--tag', 'latest', '--ignore-scripts', '--registry', 'https://registry.npmjs.org'], cwd,
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 5 * 60_000 }),
  log = console.log,
} = {}) {
  const plugin = pluginById(id);
  if (git(cwd, 'rev-parse', 'HEAD') !== sha || git(cwd, 'status', '--porcelain')) throw new Error('发布源码必须是指定 SHA 的干净检出');
  const manifest = manifestAt(cwd, sha, plugin);
  validateManifest(plugin, manifest);
  const version = manifest.version;
  const tag = `${plugin.id}-v${version}`;
  const existingTag = await tagCommit(api, tag);
  if (existingTag && existingTag !== sha) throw new Error(`${tag} 已指向其他提交，不能移动 tag`);
  const packed = pack(plugin, manifest, cwd);
  try {
    const state = await metadata(plugin.name);
    const exactVersion = await versionMetadata(plugin.name, version);
    const versions = exactVersion ? { ...state.versions, [version]: exactVersion } : state.versions;
    const alreadyPublished = verifyPublished({ versions }, version, packed.integrity);
    const body = releaseNotes(cwd, plugin, version, sha, tag);
    if (!existingTag) await api('git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha } });
    if (!alreadyPublished) {
      log(`开始发布 npm ${plugin.name}@${version}（源码 ${sha}）`);
      await publish(packed.file);
      log('npm 发布命令已成功，开始等待版本可见并核对包完整性');
      await waitForPublishedVersion(plugin.name, version, packed.integrity, { readVersion: versionMetadata, log });
    } else {
      log(`npm ${plugin.name}@${version} 已存在且包完整性一致，跳过 npm 发布`);
    }
    const release = await api(`releases/tags/${tag}`, { allowMissing: true });
    if (!release) {
      // npm 核对通过后直接创建正式 Release；多插件共用仓库，不抢占整个仓库的 Latest。
      await api('releases', { method: 'POST', body: { tag_name: tag, target_commitish: sha, name: tag, body, draft: false, make_latest: 'false' } });
    } else if (release.prerelease) {
      throw new Error(`${tag} 已有 prerelease，请先核对 GitHub Release 状态`);
    }
    return { plugin: id, version, tag, sha, alreadyPublished, draft: release ? release.draft === true : false };
  } finally {
    packed.cleanup();
  }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { source: { type: 'string', default: '.' } } });
  // 直接运行 CLI 的发布动作只允许来自 main 上的官方工作流。
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('发布流程必须从 main 分支运行');
  const cwd = resolve(values.source);
  if (positionals[0] === 'plan') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
    if (!manual && process.env.GITHUB_EVENT_NAME !== 'push') throw new Error('只接受 main push 或手动补发');
    const plan = planReleases({ cwd, before: event.before, manual, plugin: process.env.RELEASE_PLUGIN, sha: process.env.RELEASE_SHA });
    const outputs = { sha: plan.sha, has_releases: String(plan.releases.length > 0), matrix: JSON.stringify({ include: plan.releases }) };
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(plan, null, 2));
  } else if (positionals[0] === 'publish') {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPOSITORY || !process.env.GH_TOKEN) {
      throw new Error('发布只允许在官方仓库的 GitHub Actions 中运行');
    }
    if (compareVersions(command('npm', ['--version'], cwd), '11.5.1') < 0) {
      throw new Error('npm Trusted Publishing 需要 npm ≥11.5.1');
    }
    const result = await publishRelease({ cwd, plugin: process.env.RELEASE_PLUGIN, sha: process.env.RELEASE_SHA });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published ${result.tag}: https://github.com/${REPOSITORY}/releases/tag/${result.tag}\n`);
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error('用法：node scripts/release.mjs plan | publish [--source <checkout>]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
