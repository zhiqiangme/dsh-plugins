import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { targetPath } from '../lib/backend.js';
import { resolveConfig } from '../lib/config.js';
import { backendFixture, releaseFixture, finish } from '../fixtures/backend.mjs';

function seed(backend, version = '0.1.1', path = backend.paths.exe) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `magpie ${version}`); return path; }

test('默认独立目录，GET 不联网、不创建文件；路径必须为绝对 exe', async (t) => {
  const { backend, root } = backendFixture(t, { fetchImpl: () => { throw new Error('GET must not fetch'); } });
  const status = await backend.describe();
  assert.equal(status.installed, false);
  assert.ok(status.path.startsWith(root));
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => targetPath('relative.exe', backend.paths), /绝对路径/);
  assert.throws(() => targetPath(root, backend.paths), /exe/);
  assert.equal(resolveConfig({ magpiePath: status.path }).magpiePath, status.path);
  assert.throws(() => resolveConfig({ magpiePath: '../x.exe' }), /绝对路径/);
});

test('检查版本不安装；下载完成后程序、版本和可核验清单一致', async (t) => {
  const { backend, bytes } = backendFixture(t);
  assert.equal((await backend.check()).latest.version, '0.1.2');
  assert.equal(existsSync(backend.paths.exe), false);
  const accepted = backend.install();
  assert.equal(accepted.running, true);
  assert.equal((await finish(backend)).phase, 'installed');
  assert.deepEqual(readFileSync(backend.paths.exe), bytes);
  assert.equal((await backend.describe()).version, '0.1.2');
  const manifest = readdirSync(backend.paths.cache).find((f) => f.endsWith('.json'));
  assert.equal(JSON.parse(readFileSync(join(backend.paths.cache, manifest))).version, '0.1.2');
  assert.equal(existsSync(join(backend.paths.cache, 'install.lock')), false);
  assert.deepEqual(readdirSync(join(backend.paths.cache, 'downloads')), [], '安装成功后删除已校验的下载文件');
});

test('已保存路径变成目录时只在程序状态里报错，不让状态接口失败', async (t) => {
  const { backend, root } = backendFixture(t);
  const folder = join(root, 'folder.exe');
  mkdirSync(folder);
  const status = await backend.describe(folder);
  assert.equal(status.installed, false);
  assert.match(status.reason, /普通文件/);
  assert.equal(status.path, folder);
  assert.throws(() => backend.install(folder), /普通文件/);
});

test('升级指定已有路径，只替换程序并保留旧版备份、邻近配置和账号文件', async (t) => {
  const { backend, root } = backendFixture(t);
  const external = seed(backend, '0.1.1', join(root, 'portable', 'chosen.exe'));
  writeFileSync(join(dirname(external), 'settings.json'), 'keep settings');
  backend.install(external);
  assert.equal((await finish(backend)).phase, 'updated');
  assert.equal(readFileSync(external, 'utf8'), 'magpie 0.1.2');
  assert.equal(readFileSync(join(dirname(external), 'settings.json'), 'utf8'), 'keep settings');
  assert.equal(readFileSync(join(backend.paths.versions, readdirSync(backend.paths.versions)[0]), 'utf8'), 'magpie 0.1.1');
  assert.equal(existsSync(backend.paths.exe), false);
});

test('相同或更新版本不降级，运行中的程序拒绝升级且不下载', async (t) => {
  const { backend } = backendFixture(t);
  seed(backend, '0.1.3');
  let downloads = 0;
  const fetchImpl = backend.fetchImpl;
  backend.fetchImpl = async (url, options) => { if (url.includes('/download/')) downloads++; return fetchImpl(url, options); };
  backend.install();
  assert.equal((await finish(backend)).phase, 'up-to-date');
  assert.equal(downloads, 0);
  seed(backend, '0.1.1');
  backend.isRunning = async () => true;
  backend.install();
  assert.match((await finish(backend)).reason, /正在运行/);
  assert.equal(readFileSync(backend.paths.exe, 'utf8'), 'magpie 0.1.1');
  assert.equal(downloads, 0);
});

test('错误哈希、下载中断和暂存程序版本不符均保留旧文件且清理锁', async (t) => {
  const { backend } = backendFixture(t);
  seed(backend);
  const fixture = releaseFixture(); fixture.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  backend.fetchImpl = fixture.fetchImpl;
  backend.install();
  assert.match((await finish(backend)).reason, /SHA-256/);
  assert.equal(readFileSync(backend.paths.exe, 'utf8'), 'magpie 0.1.1');
  backend.fetchImpl = releaseFixture().fetchImpl;
  const probe = backend.probe;
  backend.probe = async (path, signal) => path.includes('.download.exe') ? '0.1.999' : probe(path, signal);
  backend.install();
  assert.match((await finish(backend)).reason, /版本.*不符/);
  assert.equal(readFileSync(backend.paths.exe, 'utf8'), 'magpie 0.1.1');
  assert.equal(existsSync(join(backend.paths.cache, 'install.lock')), false);
  assert.equal(readdirSync(backend.paths.current).some((p) => p.endsWith('.download.exe')), false);
});

test('替换后的程序验证失败时自动恢复旧版，清单不写成新版本', async (t) => {
  const { backend } = backendFixture(t);
  seed(backend);
  const probe = backend.probe;
  backend.probe = async (path, signal) => {
    if (path === backend.paths.exe && readFileSync(path, 'utf8') === 'magpie 0.1.2') throw new Error('installed probe failed');
    return probe(path, signal);
  };
  backend.install();
  assert.match((await finish(backend)).reason, /已恢复旧程序/);
  assert.equal(readFileSync(backend.paths.exe, 'utf8'), 'magpie 0.1.1');
  assert.equal(readdirSync(backend.paths.cache).some((p) => p.endsWith('.json')), false);
});

test('未知程序不能覆盖；下载期间被外部修改或重新启动的目标也不能覆盖', async (t) => {
  const { backend } = backendFixture(t);
  seed(backend); writeFileSync(backend.paths.exe, 'other application');
  backend.install();
  assert.match((await finish(backend)).reason, /not magpie/);
  seed(backend);
  const fetchImpl = backend.fetchImpl;
  backend.fetchImpl = async (url, options) => {
    const response = await fetchImpl(url, options);
    if (url.includes('/download/')) writeFileSync(backend.paths.exe, 'magpie 0.1.9');
    return response;
  };
  backend.install();
  assert.match((await finish(backend)).reason, /发生变化/);
  assert.equal(readFileSync(backend.paths.exe, 'utf8'), 'magpie 0.1.9');
});

test('并发安装立即拒绝，跨实例文件锁防止重复替换，插件关闭取消下载', async (t) => {
  let releaseDownload, started;
  const ready = new Promise((r) => { started = r; });
  const { backend } = backendFixture(t);
  const fetchImpl = backend.fetchImpl;
  backend.fetchImpl = async (url, options) => {
    if (!url.includes('/download/')) return fetchImpl(url, options);
    started();
    return new Promise((resolve, reject) => { releaseDownload = resolve; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  };
  backend.install(); await ready;
  assert.throws(() => backend.install(), /正在检查/);
  assert.throws(() => backend.acquireLock(), /另一 DSH/);
  await backend.dispose();
  await finish(backend);
  assert.equal(existsSync(backend.paths.exe), false);
  assert.equal(existsSync(join(backend.paths.cache, 'install.lock')), false);
  assert.equal(backend.operation.phase, 'failed');
  assert.throws(() => backend.install(), /已关闭/);
  releaseDownload();
});

test('非 Windows 下载入口不可用，模型管理所需状态仍能读取', async (t) => {
  const { backend } = backendFixture(t, { platform: 'linux' });
  assert.equal((await backend.describe()).supported, false);
  assert.throws(() => backend.install(), /Windows/);
});

test('连续升级仅保留该目标最近三个旧版本，下载后重新启动会拒绝替换', async (t) => {
  const { backend } = backendFixture(t);
  seed(backend);
  for (const version of ['0.1.2', '0.1.3', '0.1.4', '0.1.5']) {
    backend.fetchImpl = releaseFixture(version).fetchImpl;
    backend.install();
    assert.equal((await finish(backend)).phase, 'updated');
  }
  assert.equal(readdirSync(backend.paths.versions).length, 3);
  let checks = 0;
  backend.isRunning = async () => ++checks > 1;
  backend.fetchImpl = releaseFixture('0.1.6').fetchImpl;
  backend.install();
  assert.match((await finish(backend)).reason, /正在运行/);
  assert.equal(readFileSync(backend.paths.exe, 'utf8'), 'magpie 0.1.5');
});

test('手动检查重新探测原文件并清除上次失败状态，不沿用瞬时探测错误', async (t) => {
  const { backend } = backendFixture(t);
  seed(backend);
  const probe = backend.probe;
  backend.probe = async () => { throw new Error('temporarily unavailable'); };
  assert.equal((await backend.describe()).version, null);
  backend.operation = { phase: 'failed', running: false, reason: 'old error' };
  backend.probe = probe;
  const checked = await backend.check();
  assert.equal(checked.version, '0.1.1');
  assert.equal(checked.operation, null);
});
