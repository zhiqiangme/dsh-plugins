/**
 * 后端版本管理测试：版本识别、检查更新、更新（下载→校验→切换→健康检查）、回滚。
 *
 * 全程离线：假 release 服务器（fixtures/dummy-server.mjs 的 http-release 模式）
 * 提供 release 元数据、commit 解析、zip 资产与 checksums，健康探针走 http-health 模式。
 * 被"更新"的 exe 是几十字节的假二进制（MZ + Go buildinfo 字符串），不碰真实 8MB 的产物。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adoptCurrentBinary,
  applyUpdate,
  backendPaths,
  checkForUpdate,
  describeBackend,
  installBackend,
  localVersion,
  pruneVersions,
  probeHealthz,
  readBuildInfo,
  readManifest,
  rollbackBackend,
  listVersions,
  uninstallBackend,
  versionDirName,
  writeManifest,
} from '../lib/backend.js';
import { isFile } from '../lib/services.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));

const OLD_REVISION = 'a'.repeat(40);
const NEW_COMMIT = 'f'.repeat(40);

function startFixture(env = {}) {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, TEST_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('fixture 启动超时')), 10_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /listening (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fixture 提前退出 code=${code}`));
    });
  });
  return { child, ready, stop: () => child.kill() };
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** 造一个"装了某个版本"的后端根目录。 */
function tempBackendRoot(revision = OLD_REVISION) {
  const root = mkdtempSync(join(tmpdir(), 'wb-backend-'));
  const paths = backendPaths({ DSH_WORKBUDDY_BACKEND_ROOT: root });
  mkdirSync(paths.current, { recursive: true });
  writeFileSync(paths.exe, fakeExe(revision));
  writeFileSync(paths.config, JSON.stringify({ listen: '127.0.0.1:7863', api_key: 'k' }, null, 2));
  return { root, paths };
}

function fakeExe(revision, { time = '2026-10-01T00:00:00Z' } = {}) {
  return Buffer.from(`MZ fake\nvcs.revision=${revision}\nvcs.time=${time}\nvcs.modified=false\n`, 'utf8');
}

/** 替身 ManagedService：只记录调用，不真的起进程。 */
function fakeService(port, { stopResult = { stopped: true, skipped: false }, startResult = { state: 'started' } } = {}) {
  const calls = [];
  return {
    calls,
    spec: { host: '127.0.0.1', port },
    port,
    isAlive: () => false,
    async stop(reason) {
      calls.push(['stop', reason]);
      return stopResult;
    },
    async ensureRunning() {
      calls.push(['start']);
      return startResult;
    },
  };
}

test('readBuildInfo：读出 revision / 构建时间 / modified', () => {
  const { paths } = tempBackendRoot();
  const info = readBuildInfo(paths.exe);
  assert.equal(info.revision, OLD_REVISION);
  assert.equal(info.builtAt, '2026-10-01T00:00:00Z');
  assert.equal(info.modified, false);

  assert.equal(readBuildInfo(join(paths.current, '不存在.exe')), null);
});

test('versionDirName：优先 tag，没有 tag 用 commit 前 7 位，非法字符会被替换', () => {
  assert.equal(versionDirName('v1.13.0', NEW_COMMIT), 'v1.13.0');
  assert.equal(versionDirName(null, NEW_COMMIT), 'unknown-fffffff');
  assert.equal(versionDirName('v1.13.0/../evil', null), 'v1.13.0-..-evil');
  assert.equal(versionDirName(null, null), 'unknown');
});

test('localVersion：没有清单时 managed=false，纳管后带 tag 且 drifted 可检测', () => {
  const { paths } = tempBackendRoot();
  const before = localVersion(paths);
  assert.equal(before.revision, OLD_REVISION);
  assert.equal(before.managed, false);
  assert.equal(before.tag, null);

  adoptCurrentBinary(paths, { tag: 'v1.13.0' });
  const after = localVersion(paths);
  assert.equal(after.managed, true);
  assert.equal(after.tag, 'v1.13.0');
  assert.equal(after.drifted, false);

  // 手动把 exe 换成别的版本 → 清单与二进制不一致
  writeFileSync(paths.exe, fakeExe('b'.repeat(40)));
  assert.equal(localVersion(paths).drifted, true);
});

test('describeBackend：不联网也能给出布局与版本快照', () => {
  const { paths } = tempBackendRoot();
  const snapshot = describeBackend(paths);
  assert.equal(snapshot.exeExists, true);
  assert.equal(snapshot.configExists, true);
  assert.equal(snapshot.version.revision, OLD_REVISION);
  assert.deepEqual(snapshot.history, []);
});

test('probeHealthz：认 service 字段，拒绝非 workbuddy2api 的应答', async () => {
  const health = startFixture({ TEST_MODE: 'http-health' });
  const port = await health.ready;
  try {
    const ok = await probeHealthz({ port });
    assert.equal(ok.ok, true);
    assert.equal(ok.servable, true);
    assert.equal(ok.healthy, 3);
  } finally {
    health.stop();
  }

  const empty = await freePort();
  const failed = await probeHealthz({ port: empty, timeoutMs: 1_000 });
  assert.equal(failed.ok, false);
});

test('probeHealthz：没有可用账号时上游回 503，只要身份对就算后端正常（servable=false）', async () => {
  const noAccounts = startFixture({ TEST_MODE: 'http-health', TEST_HEALTHY: '0' });
  try {
    const result = await probeHealthz({ port: await noAccounts.ready });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.servable, false);
    assert.equal(result.total, 0);
  } finally {
    noAccounts.stop();
  }

  // 503 但不是 workbuddy2api：端口被别的服务占着，仍然算失败。
  const stranger = startFixture({ TEST_MODE: 'http-health', TEST_HEALTHY: '0', TEST_HEALTH_SERVICE: 'other' });
  try {
    const result = await probeHealthz({ port: await stranger.ready });
    assert.equal(result.ok, false);
    assert.match(result.reason, /503/);
  } finally {
    stranger.stop();
  }
});

test('checkForUpdate：识别可更新，并在 TTL 内命中缓存', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths } = tempBackendRoot();
  try {
    const first = await checkForUpdate({ paths, env: {}, apiBase });
    assert.equal(first.updateAvailable, true);
    assert.equal(first.upToDate, false);
    assert.equal(first.local.revision, OLD_REVISION);
    assert.equal(first.latest.tag, 'v9.9.9');
    assert.equal(first.latest.commit, NEW_COMMIT);
    assert.equal(first.fromCache, false);

    // 第二次：TTL 内应当直接用缓存（服务器停掉也照样能答）
    release.stop();
    const second = await checkForUpdate({ paths, env: {}, apiBase });
    assert.equal(second.fromCache, true);
    assert.equal(second.latest.tag, 'v9.9.9');
  } finally {
    release.stop();
  }
});

test('applyUpdate：下载→校验→切换→健康检查→写清单，旧版本进历史目录', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const port = await health.ready;
  const { paths } = tempBackendRoot();
  const service = fakeService(port);
  try {
    const result = await applyUpdate({ paths, env: {}, apiBase, service, keepVersions: 3 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'updated');
    assert.equal(result.health.healthy, 3);

    // 新版本就位
    assert.equal(readBuildInfo(paths.exe).revision, NEW_COMMIT);
    // 配置没被动过
    assert.equal(JSON.parse(readFileSync(paths.config, 'utf8')).api_key, 'k');
    // 清单
    const manifest = readManifest(paths);
    assert.equal(manifest.tag, 'v9.9.9');
    assert.equal(manifest.commit, NEW_COMMIT);
    assert.equal(manifest.previous.revision, OLD_REVISION);
    assert.match(manifest.asset, /windows-amd64\.zip$/);
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
    // 旧版本被归档
    const archived = join(paths.versions, versionDirName(null, OLD_REVISION), 'wb2api.exe');
    assert.equal(readBuildInfo(archived).revision, OLD_REVISION);
    // 服务被停过又起过
    assert.deepEqual(service.calls, [['stop', '更新后端'], ['start']]);
  } finally {
    release.stop();
    health.stop();
  }
});

test('applyUpdate：checksum 不匹配 → 拒绝安装，且一个字节都不动', async () => {
  const release = startFixture({ TEST_MODE: 'http-release', TEST_RELEASE_BAD_CHECKSUM: '1' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths } = tempBackendRoot();
  const before = readFileSync(paths.exe);
  try {
    const result = await applyUpdate({ paths, env: {}, apiBase, service: fakeService(await freePort()) });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'verify-failed');
    assert.match(result.reason, /sha256 不匹配/);
    assert.deepEqual(readFileSync(paths.exe), before);
    assert.equal(readManifest(paths), null);
  } finally {
    release.stop();
  }
});

test('applyUpdate：release 没有 checksums → 拒绝安装未校验的产物', async () => {
  const release = startFixture({ TEST_MODE: 'http-release', TEST_RELEASE_NO_CHECKSUMS: '1' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths } = tempBackendRoot();
  try {
    const result = await applyUpdate({ paths, env: {}, apiBase, service: fakeService(await freePort()) });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'verify-failed');
    assert.match(result.reason, /没有提供 checksums/);
  } finally {
    release.stop();
  }
});

test('applyUpdate：包内 exe 与 tag 的 commit 不符 → 拒绝安装', async () => {
  const release = startFixture({ TEST_MODE: 'http-release', TEST_RELEASE_EXE_REVISION: 'c'.repeat(40) });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths } = tempBackendRoot();
  const before = readFileSync(paths.exe);
  try {
    const result = await applyUpdate({ paths, env: {}, apiBase, service: fakeService(await freePort()) });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'binary-mismatch');
    // 未通过校验的暂存 exe 不留在 cache/ 里。
    assert.deepEqual(readdirSync(paths.cache).filter((name) => name.startsWith('staged-')), []);
    assert.deepEqual(readFileSync(paths.exe), before);
  } finally {
    release.stop();
  }
});

test('applyUpdate：健康检查失败 → 自动回滚到旧版本', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const { paths } = tempBackendRoot();
  const deadPort = await freePort(); // 没有服务在监听 → /healthz 必然失败
  const service = fakeService(deadPort);
  try {
    const result = await applyUpdate({ paths, env: {}, apiBase, service });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'health-failed');
    assert.equal(result.rolledBack, true);

    // 旧版本已经回来，且没有写清单
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION);
    assert.equal(readManifest(paths), null);
    // 失败的新版本被挪去 -failed，不留在 current
    const failedDirs = readdirSync(paths.versions).filter((name) => name.endsWith('-failed'));
    assert.equal(failedDirs.length, 1);
    // 挪文件前先停掉刚拉起的新进程，否则它会在 -failed 目录里继续占着端口。
    // （端口上原本没人监听，所以更新前那次 stop 被跳过。）
    assert.deepEqual(service.calls, [['start'], ['stop', '健康检查失败，回滚'], ['start']]);
  } finally {
    release.stop();
  }
});

test('applyUpdate：端口被非本插件进程占用 → 拒绝更新（不误杀别人的进程）', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const occupied = startFixture({ TEST_MODE: 'listen' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const port = await occupied.ready;
  const { paths } = tempBackendRoot();
  const before = readFileSync(paths.exe);
  try {
    // stop 返回 skipped 且端口仍在监听 = 不是我们拉起的
    const service = fakeService(port, { stopResult: { stopped: false, skipped: true } });
    const result = await applyUpdate({ paths, env: {}, apiBase, service });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'not-owned');
    assert.match(result.reason, /不是本插件拉起/);
    assert.deepEqual(readFileSync(paths.exe), before);
    assert.equal(service.calls.filter(([name]) => name === 'start').length, 0);
  } finally {
    release.stop();
    occupied.stop();
  }
});

test('rollbackBackend：装完新版再回滚，current 回到旧版本', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const port = await health.ready;
  const { paths } = tempBackendRoot();
  const service = fakeService(port);
  try {
    const updated = await applyUpdate({ paths, env: {}, apiBase, service });
    assert.equal(updated.ok, true);
    assert.equal(readBuildInfo(paths.exe).revision, NEW_COMMIT);

    const rolled = await rollbackBackend({ paths, service });
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    assert.equal(rolled.state, 'rolled-back');
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION);

    // 回滚后清单指向旧版本，且 previous 指向刚被换下去的新版本（可以再切回来）
    const manifest = readManifest(paths);
    assert.equal(manifest.commit, OLD_REVISION);
    assert.equal(manifest.source, 'rollback');
    assert.equal(manifest.previous.revision, NEW_COMMIT);
  } finally {
    release.stop();
    health.stop();
  }
});

test('rollbackBackend：回滚后健康检查失败 → 恢复当前版本，上一版本原样留在 versions/ 可再次回滚', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const healthyPort = await health.ready;
  const { paths } = tempBackendRoot();
  try {
    const updated = await applyUpdate({ paths, env: {}, apiBase, service: fakeService(healthyPort) });
    assert.equal(updated.ok, true);
    const previousExe = join(paths.versions, versionDirName(null, OLD_REVISION), 'wb2api.exe');
    assert.ok(isFile(previousExe), '更新后旧版本应在 versions/ 里');

    // 没人监听的端口：/healthz 必然失败，模拟"旧版本一时没起来"。
    const failed = await rollbackBackend({ paths, service: fakeService(await freePort()) });
    assert.equal(failed.ok, false);
    assert.equal(failed.state, 'health-failed');
    assert.equal(readBuildInfo(paths.exe).revision, NEW_COMMIT, 'current 应恢复成回滚前的版本');
    assert.equal(readBuildInfo(previousExe)?.revision, OLD_REVISION, '上一版本必须放回原处');
    assert.deepEqual(readdirSync(paths.versions).filter((name) => name.endsWith('-failed')), []);

    // 偶发失败之后再点一次回滚，照样能成功。
    const retried = await rollbackBackend({ paths, service: fakeService(healthyPort) });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(readBuildInfo(paths.exe).revision, OLD_REVISION);
  } finally {
    release.stop();
    health.stop();
  }
});

test('rollbackBackend：没有上一版本记录时明确拒绝', async () => {
  const { paths } = tempBackendRoot();
  const result = await rollbackBackend({ paths, service: fakeService(await freePort()) });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'no-previous');
});

test('pruneVersions：只保留最近 N 个历史版本', () => {
  const { paths } = tempBackendRoot();
  for (const name of ['v1', 'v2', 'v3', 'v4']) {
    mkdirSync(join(paths.versions, name), { recursive: true });
    writeFileSync(join(paths.versions, name, 'wb2api.exe'), fakeExe('d'.repeat(40)));
  }
  const removed = pruneVersions(paths, 2);
  assert.equal(removed.length, 2);
  assert.equal(readdirSync(paths.versions).length, 2);
});

test('pruneVersions：回滚目标即使最旧也保留，-failed 不占名额', () => {
  const { paths } = tempBackendRoot();
  // exe 修改时间是当初下载的时间：回滚过再更新时，上一版本可能是最旧的那个。
  const stamps = { v1: 1, v2: 2, v3: 3, 'v4-failed': 4 };
  for (const [name, at] of Object.entries(stamps)) {
    const exe = join(paths.versions, name, 'wb2api.exe');
    mkdirSync(join(paths.versions, name), { recursive: true });
    writeFileSync(exe, fakeExe('d'.repeat(40)));
    utimesSync(exe, at * 1000, at * 1000);
  }
  writeManifest(paths, { tag: 'v5', commit: 'e'.repeat(40), previous: { tag: 'v1', revision: 'a'.repeat(40) } });
  assert.deepEqual(pruneVersions(paths, 2).sort(), ['v2', 'v4-failed']);
  assert.deepEqual(readdirSync(paths.versions).sort(), ['v1', 'v3']);
});

test('installBackend：已安装时拒绝，一个字节都不动', async () => {
  const { paths } = tempBackendRoot();
  const before = readFileSync(paths.exe);

  const result = await installBackend({ paths, env: {}, service: fakeService(await freePort()) });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'already-installed');
  assert.match(result.reason, /已安装/);
  assert.deepEqual(readFileSync(paths.exe), before);
});

test('installBackend：未安装时从 release 装上、启动并写清单', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const port = await health.ready;
  const { paths } = tempBackendRoot();
  rmSync(paths.exe); // 模拟"还没装"
  const service = fakeService(port);
  try {
    const result = await installBackend({ paths, env: {}, apiBase, service });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'installed');
    assert.equal(readBuildInfo(paths.exe).revision, NEW_COMMIT);
    assert.equal(readManifest(paths).tag, 'v9.9.9');
    assert.deepEqual(service.calls, [['stop', '更新后端'], ['start']]);
  } finally {
    release.stop();
    health.stop();
  }
});

test('installBackend：新装的后端还没登录账号（/healthz 503）→ 照样装上，不回滚', async () => {
  const release = startFixture({ TEST_MODE: 'http-release' });
  const health = startFixture({ TEST_MODE: 'http-health', TEST_HEALTHY: '0' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const port = await health.ready;
  const { paths } = tempBackendRoot();
  rmSync(paths.exe);
  const service = fakeService(port);
  try {
    const result = await installBackend({ paths, env: {}, apiBase, service });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'installed');
    assert.equal(result.health.servable, false);
    assert.equal(readBuildInfo(paths.exe).revision, NEW_COMMIT);
    assert.equal(readManifest(paths).tag, 'v9.9.9');
    assert.deepEqual(listVersions(paths), [], '不应出现 -failed 目录');
    assert.deepEqual(service.calls, [['stop', '更新后端'], ['start']]);
  } finally {
    release.stop();
    health.stop();
  }
});

test('uninstallBackend：没装时明确拒绝', async () => {
  const { paths } = tempBackendRoot();
  rmSync(paths.exe);
  const result = await uninstallBackend({ paths, service: fakeService(await freePort()) });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'not-installed');
});

test('uninstallBackend：删程序文件与缓存，但保留 config.json 与 data/', async () => {
  const { paths } = tempBackendRoot();
  // 造点历史版本、缓存与数据，验证删除边界
  mkdirSync(join(paths.versions, 'v1.0.0'), { recursive: true });
  writeFileSync(join(paths.versions, 'v1.0.0', 'wb2api.exe'), fakeExe('e'.repeat(40)));
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(join(paths.data, 'state.json'), '{}');
  mkdirSync(paths.cache, { recursive: true });
  writeFileSync(join(paths.cache, 'wb2api-panel-v9.9.9-windows-amd64.zip'), 'zip');

  const result = await uninstallBackend({ paths, service: fakeService(await freePort()) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'uninstalled');

  assert.equal(isFile(paths.exe), false, 'exe 应被删除');
  assert.equal(readManifest(paths), null, '清单应被删除');
  assert.equal(readdirSync(paths.versions).length, 0, '历史版本应被清空');
  assert.equal(readdirSync(paths.cache).length, 0, '下载缓存应被清空');

  assert.equal(isFile(paths.config), true, 'config.json 必须保留');
  assert.equal(isFile(join(paths.data, 'state.json')), true, 'data/ 必须保留');
  assert.ok(result.kept.some((item) => item.includes('config.json')));
});

test('uninstallBackend：端口被非本插件进程占用时拒绝，什么都不删', async () => {
  const occupied = startFixture({ TEST_MODE: 'listen' });
  const port = await occupied.ready;
  const { paths } = tempBackendRoot();
  try {
    const service = fakeService(port, { stopResult: { stopped: false, skipped: true } });
    const result = await uninstallBackend({ paths, service });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'not-owned');
    assert.equal(isFile(paths.exe), true, '拒绝时不能删任何文件');
    assert.equal(isFile(paths.config), true);
  } finally {
    occupied.stop();
  }
});
