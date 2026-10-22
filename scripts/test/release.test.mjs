import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGINS, REPOSITORY, compareVersions, githubClient, planReleases,
  PUBLISH_VISIBILITY_DELAYS, publishRelease, registryMetadata, registryVersion, validatePack, verifyPublished, waitForPublishedVersion,
} from '../release.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function manifest(plugin, version = '26.10.15') {
  return {
    name: plugin.name, version, main: 'lib/index.js', icon: 'icons/test.svg',
    repository: { url: `git+https://github.com/${REPOSITORY}.git`, directory: plugin.directory },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js', './locale/*.json': './locale/*.json' },
  };
}

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '--initial-branch=main');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'config', 'user.email', 'release@example.invalid');
  const setVersion = (id, version) => {
    const plugin = PLUGINS.find((item) => item.id === id);
    mkdirSync(join(cwd, plugin.directory), { recursive: true });
    writeFileSync(join(cwd, plugin.directory, 'package.json'), JSON.stringify(manifest(plugin, version)));
  };
  const commit = (message = '调整(repo)：测试提交') => {
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  for (const plugin of PLUGINS) setVersion(plugin.id, '26.10.15');
  return { cwd, setVersion, commit, before: commit('初始版本') };
}

test('版本比较：日期按数字排序，支持跨月跨年，拒绝非法版本及预发布', () => {
  assert.equal(compareVersions('26.10.16', '26.10.15'), 1);
  assert.equal(compareVersions('26.11.1', '26.10.31'), 1);
  assert.equal(compareVersions('27.1.1', '26.12.31'), 1);
  assert.equal(compareVersions('26.10.16', '26.10.16'), 0);
  assert.equal(compareVersions('26.10.9', '26.10.10'), -1);
  for (const version of ['26.010.16', '26.10.16.1', '26.10.16-1', 'v26.10.16', undefined]) {
    assert.throws(() => compareVersions(version, '26.10.16'), /三段正式版/);
  }
});

test('push 计划：扫描整个 push 范围，独立选择版本有变更的包', (t) => {
  const repo = repository(t);
  repo.setVersion('workbuddy', '26.10.16');
  repo.commit('调整(workbuddy)：发布版本');
  repo.setVersion('tavily-search', '26.10.16');
  repo.commit('调整(tavily-search)：发布版本');
  writeFileSync(join(repo.cwd, 'README.md'), '文档改动');
  const sha = repo.commit('文档(repo)：补充说明');
  assert.deepEqual(planReleases({ cwd: repo.cwd, before: repo.before }), {
    sha, releases: [{ plugin: 'workbuddy', version: '26.10.16' }, { plugin: 'tavily-search', version: '26.10.16' }],
  });
});

test('push 计划：代码和文档有变化但版本未变时不发布', (t) => {
  const repo = repository(t);
  writeFileSync(join(repo.cwd, PLUGINS[0].directory, 'index.js'), '// 修改代码');
  const sha = repo.commit();
  assert.deepEqual(planReleases({ cwd: repo.cwd, before: repo.before }), { sha, releases: [] });
});

test('push 计划：新增 Magpie 包在基线中不存在时只计划新包，不补发旧包', (t) => {
  const repo = repository(t);
  git(repo.cwd, 'rm', '-r', '--', 'dsh-magpie');
  const before = repo.commit('新增前基线');
  repo.setVersion('magpie', '26.10.22');
  const sha = repo.commit('新增 Magpie');
  assert.deepEqual(planReleases({ cwd: repo.cwd, before }), { sha, releases: [{ plugin: 'magpie', version: '26.10.22' }] });
});

test('push 计划：拒绝版本倒退和没有差异基线的首次 push', (t) => {
  const repo = repository(t);
  repo.setVersion('workbuddy', '26.10.14');
  repo.commit();
  assert.throws(() => planReleases({ cwd: repo.cwd, before: repo.before }), /不能倒退/);
  assert.throws(() => planReleases({ cwd: repo.cwd, before: '0'.repeat(40) }), /push.before/);
});

test('手动补发：指定原始 SHA，后续 main 版本不会混入发布', (t) => {
  const repo = repository(t);
  repo.setVersion('workbuddy', '26.10.16');
  const original = repo.commit();
  repo.setVersion('workbuddy', '26.10.17');
  repo.commit();
  assert.deepEqual(planReleases({ cwd: repo.cwd, manual: true, plugin: 'workbuddy', sha: original }), {
    sha: original, releases: [{ plugin: 'workbuddy', version: '26.10.16' }],
  });
  assert.throws(() => planReleases({ cwd: repo.cwd, manual: true, plugin: 'unknown', sha: original }), /未知插件/);
  assert.throws(() => planReleases({ cwd: repo.cwd, manual: true, plugin: 'workbuddy', sha: 'main' }), /40 位 SHA/);
});

test('手动补发：拒绝 main 之外的提交', (t) => {
  const repo = repository(t);
  git(repo.cwd, 'checkout', '-qb', 'other');
  repo.setVersion('workbuddy', '26.10.16');
  const unrelated = repo.commit();
  git(repo.cwd, 'checkout', '-q', 'main');
  assert.throws(() => planReleases({ cwd: repo.cwd, manual: true, plugin: 'workbuddy', sha: unrelated }), /merge-base 失败/);
});

test('发布清单：检查入口、图标、补丁、LICENSE，并拒绝测试、凭据和二进制', () => {
  const plugin = PLUGINS[0];
  const pkg = manifest(plugin);
  const paths = ['package.json', 'README.md', 'LICENSE', 'lib/index.js', 'lib/client.js', 'icons/test.svg', 'cordis.patch.yml', 'locale/zh-CN.json'];
  const packed = (files = paths) => ({ name: plugin.name, version: pkg.version, filename: 'plugin-26.10.15.tgz', files: files.map((path) => ({ path })) });
  validatePack(plugin, pkg, packed());
  assert.throws(() => validatePack(plugin, pkg, packed(paths.filter((path) => path !== 'lib/client.js'))), /缺少文件/);
  for (const path of ['test/a.test.mjs', 'fixtures/server.js', 'lib/.env', 'lib/token.key', 'lib/backend.exe', 'lib/../token']) {
    assert.throws(() => validatePack(plugin, pkg, packed([...paths, path])), /非预期文件/);
  }
});

test('npm 查询：只有 404 代表包不存在，权限、限流和服务器错误必须报错', async () => {
  assert.deepEqual(await registryMetadata('test', async () => ({ status: 404 })), { versions: {} });
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(registryMetadata('test', async () => ({ status, ok: false })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(registryMetadata('test', async () => ({ ok: true, json: async () => ({}) })), /无效/);
});

test('npm 精确版本查询：使用独立端点和 no-cache，拒绝错误或不匹配的元数据', async () => {
  const published = { name: '@scope/pkg', version: '26.10.17', dist: { integrity: 'sha512-same' } };
  const result = await registryVersion(published.name, published.version, async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40scope%2Fpkg/26.10.17');
    assert.equal(options.headers['cache-control'], 'no-cache');
    return { ok: true, json: async () => published };
  });
  assert.deepEqual(result, published);
  assert.equal(await registryVersion(published.name, published.version, async () => ({ status: 404 })), undefined);
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(registryVersion(published.name, published.version, async () => ({ ok: false, status })), new RegExp(`HTTP ${status}`));
  }
  for (const invalid of [{}, { ...published, name: 'other' }, { ...published, version: '26.10.16' }, { ...published, dist: {} }]) {
    await assert.rejects(registryVersion(published.name, published.version, async () => ({ ok: true, json: async () => invalid })), /无效/);
  }
});

test('发布后核对：允许精确版本延迟可见，等待期间只读，不重复发布', async () => {
  let reads = 0;
  const waits = [];
  const logs = [];
  await waitForPublishedVersion('@scope/pkg', '26.10.17', 'sha512-same', {
    readVersion: async (name, version) => {
      assert.equal(name, '@scope/pkg');
      assert.equal(version, '26.10.17');
      reads += 1;
      return reads < 3 ? undefined : { dist: { integrity: 'sha512-same' } };
    },
    wait: async (ms) => waits.push(ms), delays: [0, 1, 2], log: (message) => logs.push(message),
  });
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /暂未可见.*1\/3.*累计等待 0 秒/);
  assert.match(logs[1], /暂未可见.*2\/3/);
  assert.match(logs[2], /已可见.*完整性核对通过/);
});

test('发布后核对：默认等待窗口约 10 分钟，覆盖超过 5 分钟的 npm 可见延迟', async () => {
  const waits = [];
  let reads = 0;
  await assert.rejects(waitForPublishedVersion('pkg', '26.10.17', 'sha512-same', {
    readVersion: async () => { reads += 1; return undefined; }, wait: async (ms) => waits.push(ms), log: () => {},
  }), /发布命令已成功.*等待 602 秒.*原始 SHA/);
  const total = waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 590_000 && total <= 620_000, `总等待 ${total}ms`);
  assert.equal(reads, PUBLISH_VISIBILITY_DELAYS.length);
  // 旧的 5 分钟窗口会失败；模拟 6 分钟后才可见，仍应完成完整性核对。
  let elapsed = 0;
  await waitForPublishedVersion('pkg', '26.10.17', 'sha512-same', {
    readVersion: async () => (elapsed >= 360_000 ? { dist: { integrity: 'sha512-same' } } : undefined),
    wait: async (ms) => { elapsed += ms; }, log: () => {},
  });
  assert.ok(elapsed >= 360_000);
});

test('发布后核对：不可见时有等待上限，完整性冲突和认证失败不误报成功', async () => {
  let reads = 0;
  await assert.rejects(waitForPublishedVersion('pkg', '26.10.17', 'sha512-same', {
    readVersion: async () => { reads += 1; return undefined; }, wait: async () => {}, delays: [0, 1],
  }), /发布命令已成功.*原始 SHA/);
  assert.equal(reads, 2);
  await assert.rejects(waitForPublishedVersion('pkg', '26.10.17', 'sha512-same', {
    readVersion: async () => ({ dist: { integrity: 'sha512-different' } }),
  }), /内容不同/);
  await assert.rejects(waitForPublishedVersion('pkg', '26.10.17', 'sha512-same', {
    readVersion: async () => { throw new Error('HTTP 403'); },
  }), /HTTP 403/);
});

test('GitHub 查询：只把显式允许的 404 当作不存在', async () => {
  const api = githubClient('test', async () => ({ status: 404, ok: false }));
  assert.equal(await api('git/ref/tags/test', { allowMissing: true }), undefined);
  await assert.rejects(api('git/refs', { method: 'POST', body: {} }), /HTTP 404/);
  await assert.rejects(githubClient('test', async () => ({ status: 403, ok: false }))('git/ref/tags/test', { allowMissing: true }), /HTTP 403/);
});

test('已发布版本：内容一致才幂等跳过；拒绝覆盖、倒退和乱序发布', () => {
  assert.equal(verifyPublished({ versions: {} }, '26.10.16', 'sha512-same'), false);
  assert.equal(verifyPublished({ versions: { '26.10.16': { dist: { integrity: 'sha512-same' } } } }, '26.10.16', 'sha512-same'), true);
  assert.throws(() => verifyPublished({ versions: { '26.10.16': { dist: { integrity: 'sha512-other' } } } }, '26.10.16', 'sha512-same'), /内容不同/);
  assert.throws(() => verifyPublished({ versions: { '26.10.17': {} } }, '26.10.16', 'sha512-same'), /必须高于/);
});

function publishing(t, { existing = false, later = false } = {}) {
  const repo = repository(t);
  const sha = git(repo.cwd, 'rev-parse', 'HEAD');
  const calls = [];
  const state = {
    tag: existing ? sha : undefined, release: undefined, failRelease: false,
    metadata: { versions: existing ? { '26.10.15': { dist: { integrity: 'sha512-same' } } } : {} },
  };
  if (later) state.metadata.versions['26.10.17'] = {};
  const adapters = {
    api: async (path, { method = 'GET', body } = {}) => {
      if (path.startsWith('git/ref/tags/')) return state.tag ? { object: { type: 'commit', sha: state.tag } } : undefined;
      if (path === 'git/refs' && method === 'POST') { calls.push('tag'); state.tag = body.sha; return {}; }
      if (path.startsWith('releases/tags/')) return state.release;
      if (path === 'releases' && method === 'POST') {
        calls.push('release');
        if (state.failRelease) { state.failRelease = false; throw new Error('GitHub 暂时不可用'); }
        state.release = body;
        return body;
      }
      throw new Error(`非预期 API：${path}`);
    },
    pack: () => { calls.push('pack'); return { file: '/tmp/package.tgz', integrity: 'sha512-same', cleanup: () => calls.push('cleanup') }; },
    metadata: async () => state.metadata,
    versionMetadata: async (_name, version) => state.metadata.versions[version],
    publish: async () => { calls.push('npm'); state.metadata.versions['26.10.15'] = { dist: { integrity: 'sha512-same' } }; },
    log: () => {},
  };
  return { repo, state, calls, adapters, options: { cwd: repo.cwd, plugin: 'workbuddy', sha } };
}

test('发布顺序：先锁定 tag，再发 npm，核对成功后创建 Release', async (t) => {
  const context = publishing(t);
  const result = await publishRelease(context.options, context.adapters);
  assert.equal(result.tag, 'workbuddy-v26.10.15');
  assert.equal(result.alreadyPublished, false);
  assert.deepEqual(context.calls, ['pack', 'tag', 'npm', 'release', 'cleanup']);
  assert.match(context.state.release.body, /dsh plugin --profile desktop add @zhiqiangme\/dsh-autostart-workbuddy@26\.10\.15/);
  assert.equal(context.state.release.draft, false);
  assert.equal(context.state.release.make_latest, 'false');
  assert.equal(result.draft, false);
});

test('重跑保留已有 Release 状态，不改动已有草案或把正式版降回草案', async (t) => {
  for (const draft of [true, false]) {
    const context = publishing(t, { existing: true });
    context.state.release = { draft, prerelease: false };
    const result = await publishRelease(context.options, context.adapters);
    assert.equal(result.draft, draft);
    assert.deepEqual(context.calls, ['pack', 'cleanup']);
    assert.equal(context.state.release.draft, draft);
  }
});

test('已有预发布 Release 时停止，不擅自修改预发布状态', async (t) => {
  const context = publishing(t, { existing: true });
  context.state.release = { draft: false, prerelease: true };
  await assert.rejects(publishRelease(context.options, context.adapters), /已有 prerelease/);
  assert.deepEqual(context.calls, ['pack', 'cleanup']);
});

test('包列表缓存过期但精确版本已存在时，只补 Release，不再发 npm', async (t) => {
  const context = publishing(t, { existing: true });
  context.adapters.metadata = async () => ({ versions: {} });
  const result = await publishRelease(context.options, context.adapters);
  assert.equal(result.alreadyPublished, true);
  assert.deepEqual(context.calls, ['pack', 'release', 'cleanup']);
});

test('npm 发布后包列表始终滞后，精确版本可见即可完成 Release', async (t) => {
  const context = publishing(t);
  context.adapters.metadata = async () => ({ versions: {} });
  const result = await publishRelease(context.options, context.adapters);
  assert.equal(result.alreadyPublished, false);
  assert.deepEqual(context.calls, ['pack', 'tag', 'npm', 'release', 'cleanup']);
});

test('失败恢复：npm 成功而 Release 失败，重跑只补 Release', async (t) => {
  const context = publishing(t);
  context.state.failRelease = true;
  await assert.rejects(publishRelease(context.options, context.adapters), /暂时不可用/);
  const result = await publishRelease(context.options, context.adapters);
  assert.equal(result.alreadyPublished, true);
  assert.equal(context.calls.filter((call) => call === 'npm').length, 1);
  assert.equal(context.calls.filter((call) => call === 'tag').length, 1);
  await publishRelease(context.options, context.adapters);
  assert.equal(context.calls.filter((call) => call === 'release').length, 2);
  assert.equal(context.calls.filter((call) => call === 'cleanup').length, 3);
});

test('已有 tag 指向其他提交时，在打包和 npm 发布之前停止', async (t) => {
  const context = publishing(t);
  context.state.tag = 'f'.repeat(40);
  await assert.rejects(publishRelease(context.options, context.adapters), /不能移动 tag/);
  assert.deepEqual(context.calls, []);
});

test('接受指向相同提交的历史 annotated tag', async (t) => {
  const context = publishing(t, { existing: true });
  const originalApi = context.adapters.api;
  context.adapters.api = async (path, options) => {
    if (path.startsWith('git/ref/tags/')) return { object: { type: 'tag', sha: 'a'.repeat(40) } };
    if (path.startsWith('git/tags/')) return { object: { type: 'commit', sha: context.options.sha } };
    return originalApi(path, options);
  };
  await publishRelease(context.options, context.adapters);
  assert.deepEqual(context.calls, ['pack', 'release', 'cleanup']);
});

test('同版本内容冲突、npm 查询失败时都不创建 tag 或 Release', async (t) => {
  const context = publishing(t, { existing: true });
  context.state.metadata.versions['26.10.15'].dist.integrity = 'sha512-different';
  await assert.rejects(publishRelease(context.options, context.adapters), /内容不同/);
  context.adapters.metadata = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(publishRelease(context.options, context.adapters), /HTTP 503/);
  assert.deepEqual(context.calls, ['pack', 'cleanup', 'pack', 'cleanup']);
});

test('npm 发布失败时保留 tag，且不生成成功的 GitHub Release', async (t) => {
  const context = publishing(t);
  context.adapters.publish = async () => { throw new Error('OIDC 未配置'); };
  await assert.rejects(publishRelease(context.options, context.adapters), /OIDC 未配置/);
  assert.equal(context.state.tag, context.options.sha);
  assert.equal(context.state.release, undefined);
  assert.deepEqual(context.calls, ['pack', 'tag', 'cleanup']);
});

test('旧版本尚未发布且 npm 已有更高版本时停止；已发布旧版本可补 Release 而不改 latest', async (t) => {
  const context = publishing(t, { later: true });
  await assert.rejects(publishRelease(context.options, context.adapters), /必须高于/);
  context.state.metadata.versions['26.10.15'] = { dist: { integrity: 'sha512-same' } };
  await publishRelease(context.options, context.adapters);
  assert.equal(context.calls.includes('npm'), false);
  assert.ok(context.state.release);
});

test('拒绝脏源码检出，避免工作目录内容与 tag 不一致', async (t) => {
  const context = publishing(t);
  writeFileSync(join(context.repo.cwd, 'untracked.txt'), 'unexpected');
  await assert.rejects(publishRelease(context.options, context.adapters), /干净检出/);
  assert.deepEqual(context.calls, []);
});

test('仓库各实际 package.json 均符合发布映射', () => {
  for (const plugin of PLUGINS) {
    const pkg = JSON.parse(readFileSync(new URL(`../../${plugin.directory}/package.json`, import.meta.url), 'utf8'));
    assert.equal(pkg.name, plugin.name);
    assert.equal(pkg.repository.directory, plugin.directory);
    compareVersions(pkg.version, pkg.version);
  }
});
