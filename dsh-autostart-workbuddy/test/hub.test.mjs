/**
 * 第二种后端网关 workbuddy2api-hub：目录布局、版本识别、安装 / 更新 / 回滚 / 卸载（整目录切换）、
 * 健康探针、密钥沿用与生成、配置解析，以及网关切换与模型命名。
 *
 * 全程离线：假 hub release 与假 /health 都来自 fixtures/dummy-server.mjs，
 * 后端进程用替身 service 代替（不真的起 Python）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../lib/config.js';
import { gatewayDriver, normalizeGateway } from '../lib/gateway.js';
import {
  applyHubUpdate,
  checkHubUpdate,
  describeHub,
  hubKeyHooks,
  hubPaths,
  installHub,
  localHubVersion,
  probeHubHealth,
  readHubApiKey,
  rollbackHub,
  uninstallHub,
} from '../lib/hub.js';
import { fetchModels, modelDisplayName } from '../lib/models.js';
import { readPanelKey, selectGateway } from '../lib/web.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));

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
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fixture 提前退出 code=${code}`));
    });
  });
  return { ready, stop: () => child.kill() };
}

/** 替身 ManagedService：只记录调用，不真的起进程。 */
function fakeService(port) {
  const calls = [];
  return {
    calls,
    spec: { host: '127.0.0.1', port },
    port,
    async stop(reason) {
      calls.push(['stop', reason]);
      return { stopped: true };
    },
    async ensureRunning() {
      calls.push(['start']);
      return { state: 'started' };
    },
  };
}

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wb-hub-'));
  return { root, env: { DSH_WORKBUDDY_BACKEND_ROOT: root }, paths: hubPaths({ DSH_WORKBUDDY_BACKEND_ROOT: root }) };
}

/** 在 versions/ 或 current/ 下造一个"装好的" hub 目录。 */
function fakeHubDir(dir, tag) {
  mkdirSync(join(dir, 'python'), { recursive: true });
  writeFileSync(join(dir, 'wb_proxy.py'), `# ${tag}\n`);
  writeFileSync(join(dir, 'python', 'python.exe'), 'MZ');
  writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ tag, root: 'wb-proxy' }));
}

test('hubPaths：hub 在插件数据根下单独一个目录，账号与用量在 data/ 下', () => {
  const { root, paths } = tempRoot();
  assert.equal(paths.plugin.root, root);
  assert.equal(paths.root, join(root, 'hub'));
  assert.equal(paths.exe, join(root, 'hub', 'backend', 'current', 'python', 'python.exe'));
  assert.equal(paths.accounts, join(root, 'hub', 'data', 'accounts'));
  assert.equal(paths.usage, join(root, 'hub', 'data', 'usage'));
});

test('gateway：非法值退回 wb2api，两种网关的操作集各自独立', () => {
  assert.equal(normalizeGateway('hub'), 'hub');
  assert.equal(normalizeGateway('HUB'), 'wb2api');
  assert.equal(normalizeGateway(undefined), 'wb2api');
  assert.equal(gatewayDriver('hub').id, 'hub');
  assert.equal(gatewayDriver({ gateway: 'wb2api' }).panelPath, '/panel');
  assert.equal(gatewayDriver('hub').panelPath, '/');
});

test('probeHubHealth：认 accounts 字段；带 service 的应答（别的服务）判失败', async () => {
  const ok = startFixture({ TEST_MODE: 'http-hub-health', TEST_HUB_ACCOUNTS: '2' });
  try {
    const result = await probeHubHealth({ port: await ok.ready });
    assert.deepEqual({ ok: result.ok, servable: result.servable, total: result.total }, { ok: true, servable: true, total: 2 });
  } finally {
    ok.stop();
  }
  const empty = startFixture({ TEST_MODE: 'http-hub-health', TEST_HUB_ACCOUNTS: '0' });
  try {
    const result = await probeHubHealth({ port: await empty.ready });
    assert.equal(result.ok, true);
    assert.equal(result.servable, false, '没有可用账号：进程正常，但目录不可信');
  } finally {
    empty.stop();
  }
  const foreign = startFixture({ TEST_MODE: 'http-hub-health', TEST_HUB_FOREIGN: '1' });
  try {
    assert.equal((await probeHubHealth({ port: await foreign.ready })).ok, false);
  } finally {
    foreign.stop();
  }
});

test('installHub：下载→校验→整包解到 current/→健康检查→记安装来源；不查 commit', async () => {
  const release = startFixture({ TEST_MODE: 'http-hub-release', TEST_RELEASE_TAG: 'v1.7.14' });
  const health = startFixture({ TEST_MODE: 'http-hub-health', TEST_HUB_ACCOUNTS: '0' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const service = fakeService(await health.ready);
  const { paths } = tempRoot();
  try {
    const result = await installHub({ paths, env: {}, apiBase, service });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'installed');
    assert.equal(result.health.servable, false, '新装的 hub 没账号也算装好');
    assert.ok(existsSync(join(paths.current, 'wb_proxy.py')));
    assert.ok(existsSync(paths.exe));
    assert.equal(localHubVersion(paths).tag, 'v1.7.14', '版本取自放进目录里的 release-manifest.json');
    assert.equal(JSON.parse(readFileSync(paths.state, 'utf8')).source, 'github-release');
    // 端口上已有（替身）进程在听：换目录前先停，再拉起新版本。
    assert.deepEqual(service.calls.map(([name]) => name), ['stop', 'start']);
    assert.ok(existsSync(paths.accounts), '账号目录在 data/ 下预先建好');

    const again = await installHub({ paths, env: {}, apiBase, service });
    assert.equal(again.state, 'already-installed');
    const snapshot = describeHub(paths);
    assert.equal(snapshot.gateway, 'hub');
    assert.equal(snapshot.exeExists, true);
    assert.equal(snapshot.root, paths.plugin.root, '彻底卸载清的是插件整体数据根');
  } finally {
    release.stop();
    health.stop();
  }
});

test('applyHubUpdate：旧目录进 versions/，hub 的 data/ 原样保留；rollbackHub 换回旧版本', async () => {
  const release = startFixture({ TEST_MODE: 'http-hub-release', TEST_RELEASE_TAG: 'v1.8.0', TEST_HUB_SHA256SUMS_ONLY: '1' });
  const health = startFixture({ TEST_MODE: 'http-hub-health' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const service = fakeService(await health.ready);
  const { paths } = tempRoot();
  fakeHubDir(paths.current, 'v1.7.14');
  mkdirSync(paths.accounts, { recursive: true });
  writeFileSync(join(paths.accounts, 'acc.json'), '{"uid":"u1"}');
  writeFileSync(paths.state, JSON.stringify({ tag: 'v1.7.14' }));
  try {
    const check = await checkHubUpdate({ paths, env: {}, apiBase, force: true });
    assert.equal(check.updateAvailable, true);
    assert.equal(check.latest.tag, 'v1.8.0');

    const updated = await applyHubUpdate({ paths, env: {}, apiBase, service });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(localHubVersion(paths).tag, 'v1.8.0');
    assert.ok(existsSync(join(paths.versions, 'v1.7.14', 'wb_proxy.py')), '旧版本整目录归档');
    assert.equal(readFileSync(join(paths.accounts, 'acc.json'), 'utf8'), '{"uid":"u1"}', '账号数据不受换版本影响');
    assert.deepEqual(JSON.parse(readFileSync(paths.state, 'utf8')).previous, { tag: 'v1.7.14' });

    const upToDate = await applyHubUpdate({ paths, env: {}, apiBase, service });
    assert.equal(upToDate.state, 'up-to-date');

    const rolled = await rollbackHub({ paths, service });
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    assert.equal(localHubVersion(paths).tag, 'v1.7.14');
    assert.ok(existsSync(join(paths.versions, 'v1.8.0', 'wb_proxy.py')), '回滚后被换下的版本仍可再换回来');
  } finally {
    release.stop();
    health.stop();
  }
});

test('applyHubUpdate：新版本健康检查失败 → 停掉、换回旧目录、重新拉起', async () => {
  const release = startFixture({ TEST_MODE: 'http-hub-release', TEST_RELEASE_TAG: 'v1.8.0' });
  const foreign = startFixture({ TEST_MODE: 'http-hub-health', TEST_HUB_FOREIGN: '1' });
  const apiBase = `http://127.0.0.1:${await release.ready}`;
  const service = fakeService(await foreign.ready);
  const { paths } = tempRoot();
  fakeHubDir(paths.current, 'v1.7.14');
  try {
    const result = await applyHubUpdate({ paths, env: {}, apiBase, service });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'health-failed');
    assert.equal(result.rolledBack, true);
    assert.equal(localHubVersion(paths).tag, 'v1.7.14', 'current 换回旧版本');
    assert.ok(existsSync(join(paths.versions, 'v1.8.0-failed')), '失败的新包留作排查');
    assert.deepEqual(service.calls.map(([name]) => name), ['stop', 'start', 'stop', 'start']);
  } finally {
    release.stop();
    foreign.stop();
  }
});

test('applyHubUpdate：包与 release 对不上、缺运行时、路径逃逸，一律拒绝且不动 current/', async () => {
  const cases = [
    [{ TEST_HUB_MANIFEST_TAG: 'v0.0.1' }, 'binary-mismatch'],
    [{ TEST_HUB_NO_RUNTIME: '1' }, 'binary-unknown'],
    [{ TEST_HUB_EVIL: '1' }, 'extract-failed'],
  ];
  for (const [env, state] of cases) {
    const release = startFixture({ TEST_MODE: 'http-hub-release', TEST_RELEASE_TAG: 'v1.8.0', ...env });
    const { root, paths } = tempRoot();
    fakeHubDir(paths.current, 'v1.7.14');
    const service = fakeService(1);
    try {
      const result = await applyHubUpdate({ paths, env: {}, apiBase: `http://127.0.0.1:${await release.ready}`, service });
      assert.equal(result.state, state, JSON.stringify(result));
      assert.equal(localHubVersion(paths).tag, 'v1.7.14');
      assert.deepEqual(service.calls, [], '没通过校验就不该停服');
      assert.equal(existsSync(join(root, 'hub', 'escaped.txt')), false);
      assert.equal(existsSync(join(paths.cache, 'escaped.txt')), false);
    } finally {
      release.stop();
    }
  }
});

test('uninstallHub：删程序与历史版本，保留 hub/data/', async () => {
  const health = startFixture({ TEST_MODE: 'http-hub-health' });
  const service = fakeService(await health.ready);
  const { paths } = tempRoot();
  fakeHubDir(paths.current, 'v1.7.14');
  fakeHubDir(join(paths.versions, 'v1.7.13'), 'v1.7.13');
  mkdirSync(paths.accounts, { recursive: true });
  writeFileSync(join(paths.accounts, 'acc.json'), '{}');
  try {
    const result = await uninstallHub({ paths, service });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(existsSync(paths.current), false);
    assert.equal(existsSync(paths.versions), false);
    assert.ok(existsSync(join(paths.accounts, 'acc.json')));
    assert.equal((await uninstallHub({ paths, service })).state, 'not-installed');
  } finally {
    health.stop();
  }
});

test('readHubApiKey：显式 → 环境变量 → wb2api 的 api_key → 插件存下的密钥', () => {
  const { paths } = tempRoot();
  assert.equal(readHubApiKey({ explicit: 'a', env: { WORKBUDDY_PROXY_KEY: 'b' }, wb2apiKey: 'c', paths }), 'a');
  assert.equal(readHubApiKey({ env: { WORKBUDDY_PROXY_KEY: 'b' }, wb2apiKey: 'c', paths }), 'b');
  assert.equal(readHubApiKey({ env: {}, wb2apiKey: 'c', paths }), 'c');
  assert.equal(readHubApiKey({ env: {}, paths }), '');
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.apiKeyFile, 'saved\n');
  assert.equal(readHubApiKey({ env: {}, paths }), 'saved');
});

test('hubKeyHooks：没有可沿用的密钥时生成一个，写进子进程环境与模型同步配置', () => {
  const { paths } = tempRoot();
  const resolved = { spec: { env: {} }, backend: { paths }, models: { apiKey: '' } };
  const lines = [];
  hubKeyHooks(resolved, { info: (line) => lines.push(line) }).beforeSpawn();
  const key = resolved.spec.env.API_KEY;
  assert.match(key, /^sk-[A-Za-z0-9_-]{20,}$/);
  assert.equal(resolved.models.apiKey, key);
  assert.equal(readFileSync(paths.apiKeyFile, 'utf8').trim(), key);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(key), false, '日志里不能出现密钥本身');

  // 已有密钥就不动。
  const kept = { spec: { env: { API_KEY: 'k' } }, backend: { paths }, models: { apiKey: 'k' } };
  hubKeyHooks(kept, { info() {} }).beforeSpawn();
  assert.equal(kept.spec.env.API_KEY, 'k');
});

test('resolvePluginConfig(gateway: hub)：python 跑 wb_proxy.py，数据目录走参数，密钥走环境变量', () => {
  const { root, env } = tempRoot();
  // 沿用 wb2api 的 api_key：DSH 凭据库里的 WORKBUDDY_PROXY_KEY 通常就是它。
  mkdirSync(join(root, 'backend', 'current'), { recursive: true });
  writeFileSync(join(root, 'backend', 'current', 'config.json'), JSON.stringify({ api_key: 'sk-from-wb2api' }));
  const hostEnv = { ...env, PATH: '', PYTHONHOME: 'C:\\elsewhere', PYTHONPATH: 'C:\\lib' };
  const resolved = resolvePluginConfig({ gateway: 'hub', exe: 'C:\\custom\\wb2api.exe', port: 7999 }, hostEnv);
  const paths = hubPaths(env);

  assert.equal(resolved.gateway, 'hub');
  assert.equal(resolved.backend.kind, 'hub');
  assert.equal(resolved.spec.exe, paths.exe, 'hub 不吃给 wb2api 配的 exe');
  assert.equal(resolved.managedExe, true);
  assert.deepEqual(resolved.spec.args, [
    paths.script, '--host', '127.0.0.1', '--port', '7999', '--accounts-dir', paths.accounts, '--usage-dir', paths.usage,
  ]);
  assert.equal(resolved.spec.env.API_KEY, 'sk-from-wb2api');
  assert.equal(resolved.spec.args.includes('sk-from-wb2api'), false, '密钥不进命令行');
  assert.equal(resolved.spec.env.PYTHONHOME, undefined, '宿主的 Python 设置不能漏给自带运行时');
  assert.equal(resolved.spec.env.PYTHONPATH, undefined);
  assert.equal(resolved.spec.env.PYTHONUNBUFFERED, '1');
  assert.equal(resolved.models.apiKey, 'sk-from-wb2api');
  assert.equal(resolved.models.panelConfig, '');
  assert.equal(resolved.backend.keepVersions, 2);

  // 国内版上游改址：缺省经 WB_CN_CHAT_UPSTREAM 传 www.workbuddy.cn；显式空串时不传，宿主环境里的同名变量也不漏过去。
  assert.equal(resolved.spec.env.WB_CN_CHAT_UPSTREAM, 'https://www.workbuddy.cn');
  const custom = resolvePluginConfig({ gateway: 'hub', cnChatBase: 'https://cn.example' }, hostEnv);
  assert.equal(custom.spec.env.WB_CN_CHAT_UPSTREAM, 'https://cn.example');
  const off = resolvePluginConfig({ gateway: 'hub', cnChatBase: '' }, { ...hostEnv, WB_CN_CHAT_UPSTREAM: 'https://leak' });
  assert.equal(off.spec.env.WB_CN_CHAT_UPSTREAM, undefined);

  // 默认仍是 wb2api，切换前后的配置解析互不影响。
  const plain = resolvePluginConfig({}, hostEnv);
  assert.equal(plain.gateway, 'wb2api');
  assert.equal(plain.spec.env.API_KEY, undefined);
});

test('modelDisplayName：hub 的裸 id 按应答顶层 realm 补 CN/GL 前缀', async () => {
  assert.equal(modelDisplayName({ id: 'hy3', name: 'Hy3', credits: 'x0.00', realm: 'cn' }), 'CN Hy3 Free');
  assert.equal(modelDisplayName({ id: 'hy3', name: 'Hy3', credits: 'x0.11', realm: 'intl' }), 'GL Hy3 0.11');
  assert.equal(modelDisplayName({ id: 'cn:hy3', name: 'Hy3', credits: 'x0.11', realm: 'intl' }), 'CN Hy3 0.11', 'id 自带前缀优先');
  assert.equal(modelDisplayName({ id: 'hy3', name: 'Hy3', credits: 'x0.11' }), 'Hy3 0.11');

  const server = startFixture({
    TEST_MODE: 'http-models',
    TEST_MODELS_JSON: JSON.stringify({ object: 'list', realm: 'cn', data: [{ id: 'hy3', name: 'Hy3' }, { id: 'x', realm: 'intl' }] }),
  });
  try {
    const fetched = await fetchModels({ baseURL: `http://127.0.0.1:${await server.ready}` });
    assert.equal(fetched.ok, true);
    assert.equal(fetched.realm, 'cn');
    assert.deepEqual(fetched.models.map((model) => model.realm), ['cn', 'intl'], '条目自带的 realm 不被覆盖');
  } finally {
    server.stop();
  }
});

function fakeEditor(config = {}) {
  const entry = { options: { id: 'dsh-autostart-workbuddy', config } };
  const writes = [];
  return {
    writes,
    entry,
    documentPath: 'C:\\profile\\cordis.patch.yml',
    entries: () => [entry],
    async edit(target, change) {
      const next = change(target.options.config);
      writes.push(next);
      target.options.config = next;
    },
  };
}

test('selectGateway：写 config.gateway（保留其它字段）；同值、非法值、忙碌中都不写', async () => {
  const editor = fakeEditor({ port: 7863, models: { enabled: true } });
  const switched = await selectGateway({ resolved: { gateway: 'wb2api' }, editor, gateway: 'hub' });
  assert.deepEqual(switched, { ok: true, state: 'switched', gateway: 'hub', previous: 'wb2api', restarting: true });
  assert.deepEqual(editor.writes, [{ port: 7863, models: { enabled: true }, gateway: 'hub' }]);

  assert.equal((await selectGateway({ resolved: { gateway: 'hub' }, editor, gateway: 'hub' })).state, 'unchanged');
  assert.equal((await selectGateway({ resolved: { gateway: 'hub' }, editor, gateway: 'nope' })).ok, false);
  assert.equal((await selectGateway({ resolved: { gateway: 'hub' }, editor, gateway: 'wb2api', busy: true })).ok, false);
  assert.equal((await selectGateway({ resolved: { gateway: 'hub' }, editor: undefined, gateway: 'wb2api' })).ok, false);
  assert.equal(editor.writes.length, 1);
});

test('readPanelKey：hub 还是出厂密码时给 admin；改过之后只有哈希，不给明文', () => {
  const accounts = mkdtempSync(join(tmpdir(), 'wb-hub-pw-'));
  const resolved = { gateway: 'hub', paths: { accounts } };
  // 从没打开过设置页：settings.json 不在，hub 认出厂密码。
  assert.deepEqual(readPanelKey(resolved), { ok: true, gateway: 'hub', key: 'admin', passwordDefault: true });

  writeFileSync(join(accounts, 'settings.json'), JSON.stringify({ panel_password_hash: '', panel_password_default: true }));
  assert.equal(readPanelKey(resolved).key, 'admin');

  writeFileSync(join(accounts, 'settings.json'), JSON.stringify({ panel_password_hash: 'ab12', panel_password_salt: 'cd', panel_password_default: false }));
  assert.deepEqual(readPanelKey(resolved), { ok: true, gateway: 'hub', key: '', passwordDefault: false });

  // 读不了（写到一半）时不冒充出厂密码。
  writeFileSync(join(accounts, 'settings.json'), '{"panel_password_hash": "ab');
  assert.equal(readPanelKey(resolved).key, '');
});
