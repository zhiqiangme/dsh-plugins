import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvePluginConfig } from '../lib/config.js';
import { gatewayDriver, GATEWAY_IDS } from '../lib/gateway.js';
import { GatewayService } from '../lib/gateway-service.js';
import {
  applyTiaraUpdate,
  checkTiaraUpdate,
  describeTiara,
  ensureTiaraConfig,
  fetchTiaraSource,
  installTiara,
  localTiaraVersion,
  probeTiaraHealth,
  rollbackTiara,
  tiaraBinary,
  tiaraPaths,
  uninstallTiara,
} from '../lib/tiara.js';
import { backendPaths } from '../lib/backend.js';
import { ensureBackendConfig } from '../lib/backend-config.js';
import { panelApiKey } from '../lib/models.js';
import { serve } from '../fixtures/http-fixture.mjs';
import { buildZip } from '../fixtures/zip-builder.mjs';
import { extractZipTree } from '../lib/zip.js';

const target = (digit) => ({ commit: digit.repeat(40), tag: `main-${digit.repeat(12)}` });
function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'tiara-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return {
    root,
    env: { DSH_OPENCODE2API_BACKEND_ROOT: root },
    paths: tiaraPaths({ DSH_OPENCODE2API_BACKEND_ROOT: root }),
  };
}
function write(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}
async function prepare({ stagedDir, latest }) {
  write(join(stagedDir, 'src/proxy.js'), '// fixture');
  write(join(stagedDir, 'node_modules/express/package.json'), '{}');
  write(tiaraBinary(stagedDir), 'fixture binary');
  write(join(stagedDir, 'dsh-source.json'), JSON.stringify({ ...latest, version: '2.5.0' }));
}
async function serviceFor(t, paths) {
  let owned = true,
    broken;
  const calls = [];
  const url = await serve(t, (_req, res) => {
    const bad = localTiaraVersion(paths).revision === broken;
    res.end(JSON.stringify(bad ? { status: 'error' } : { status: 'ok', proxy: true }));
  });
  const port = Number(new URL(url).port);
  return {
    spec: { host: '127.0.0.1', port },
    port,
    calls,
    ensureRunning: async () => {
      calls.push('start');
      return { state: 'started' };
    },
    stop: async () => {
      calls.push('stop');
      return { stopped: owned };
    },
    setOwned: (value) => {
      owned = value;
    },
    setBroken: (value) => {
      broken = value;
    },
  };
}

test('网关解析只读、默认兼容旧后端；Tiara 不沿用 Go 的 exe/args/cwd', (t) => {
  const { root, env, paths } = temp(t);
  rmSync(root, { recursive: true });
  const old = resolvePluginConfig({}, env);
  assert.equal(old.gateway, 'jasonxu');
  assert.deepEqual(old.paths, backendPaths(env));
  assert.equal(resolvePluginConfig({ gateway: 'bad' }, env).gateway, 'jasonxu');
  const config = {
    gateway: 'tiara',
    exe: 'wrong.exe',
    cwd: 'wrong',
    args: ['-listen', 'bad'],
    port: 9123,
    tiaraServerPort: 9124,
    models: { only: ['saved'], apiKey: 'explicit' },
  };
  const resolved = resolvePluginConfig(config, env);
  assert.equal(resolved.spec.exe, process.execPath);
  assert.equal(resolved.spec.cwd, paths.current);
  assert.ok(resolved.spec.args[0].endsWith('tiara-runner.js'));
  assert.equal(resolved.spec.killTree, true);
  assert.equal(resolved.spec.env.DSH_TIARA_SERVER_PORT, '9124');
  assert.equal(resolved.spec.env.DSH_TIARA_API_KEY, 'explicit');
  assert.equal(resolved.models.panelConfig, paths.config);
  assert.equal(resolved.models.provider, old.models.provider);
  assert.equal(resolved.panelUrl, 'http://127.0.0.1:9123/panel');
  assert.equal(resolved.backend.keepVersions, 2);
  assert.equal(describeTiara(paths).exeExists, false, 'Node 存在不代表 Tiara 已安装');
  assert.equal(existsSync(root), false, '配置解析与首屏快照不能生成数据目录');
  assert.deepEqual(GATEWAY_IDS, ['jasonxu', 'tiara']);
  assert.equal(gatewayDriver(resolved).id, 'tiara');
});

test('两种网关密钥兼容凭据引用；首次生成后持久保留，状态快照不泄露', (t) => {
  const { env, paths } = temp(t);
  const old = backendPaths(env);
  ensureBackendConfig(old, resolvePluginConfig({}, env).spec);
  const original = panelApiKey(old.config);
  assert.equal(ensureTiaraConfig(paths).created, true);
  assert.equal(panelApiKey(paths.config), original);
  const config = JSON.parse(readFileSync(paths.config, 'utf8'));
  assert.ok(config.OPENCODE_SERVER_PASSWORD.length >= 24);
  assert.equal(ensureTiaraConfig(paths).created, false);
  assert.equal(JSON.stringify(describeTiara(paths)).includes(original), false);
  writeFileSync(paths.config, 'invalid');
  assert.throws(() => ensureTiaraConfig(paths), /缺少/);
  assert.equal(readFileSync(paths.config, 'utf8'), 'invalid');
});

test('Tiara 探针识别 proxy 标志，不把其他 /health 当作后端', async (t) => {
  let body = { status: 'ok', proxy: true };
  const url = await serve(t, (_req, res) => res.end(JSON.stringify(body)));
  const port = Number(new URL(url).port);
  assert.equal((await probeTiaraHealth({ port })).servable, true);
  body = { status: 'ok' };
  assert.equal((await probeTiaraHealth({ port })).ok, false);
  body = { status: 'ok', proxy: false };
  assert.equal((await probeTiaraHealth({ port })).ok, false);
});

test('源码检查按 commit 比较，遵守 TTL，首次查询不创建安装目录', async (t) => {
  const { root, env, paths } = temp(t);
  rmSync(root, { recursive: true });
  let count = 0;
  const apiBase = await serve(t, (req, res) => {
    count++;
    assert.equal(req.url, '/repos/TiaraBasori/OpenCode2API/commits/main');
    res.end(JSON.stringify({ sha: 'a'.repeat(40), commit: { committer: { date: '2026-10-19T00:00:00Z' } } }));
  });
  const checked = await checkTiaraUpdate({ paths, env, apiBase });
  assert.equal(checked.latest.tag, target('a').tag);
  assert.equal(checked.updateAvailable, true);
  assert.equal(existsSync(root), false);
  mkdirSync(paths.cache, { recursive: true });
  await checkTiaraUpdate({ paths, env, apiBase });
  const cached = await checkTiaraUpdate({ paths, env, apiBase });
  assert.equal(cached.fromCache, true);
  assert.equal(count, 2);
  await checkTiaraUpdate({ paths, env, apiBase, force: true });
  assert.equal(count, 3);
  const bad = await serve(t, (_req, res) => res.end(JSON.stringify({ sha: '../../x' })));
  await assert.rejects(fetchTiaraSource({ apiBase: bad }), /commit/);
});

test('安装、更新和双向回滚保留独立数据；准备失败和健康失败恢复原版本', async (t) => {
  const { paths, env } = temp(t);
  const service = await serviceFor(t, paths);
  const options = { paths, env, service, prepare };
  const installed = await installTiara({ ...options, target: target('a') });
  assert.equal(installed.state, 'installed');
  const config = readFileSync(paths.config, 'utf8');
  write(join(paths.data, 'share/sentinel'), 'sessions');
  assert.equal((await installTiara({ ...options, target: target('a') })).state, 'already-installed');
  const updated = await applyTiaraUpdate({ ...options, target: target('b') });
  assert.equal(updated.ok, true);
  assert.equal(localTiaraVersion(paths).previous.tag, target('a').tag);
  assert.equal((await rollbackTiara({ paths, service })).ok, true);
  assert.equal(localTiaraVersion(paths).revision, target('a').commit);
  assert.equal((await rollbackTiara({ paths, service })).ok, true);
  assert.equal(localTiaraVersion(paths).revision, target('b').commit);
  service.setBroken(target('c').commit);
  const failed = await applyTiaraUpdate({ ...options, target: target('c') });
  assert.equal(failed.rolledBack, true);
  assert.equal(localTiaraVersion(paths).revision, target('b').commit);
  const prepared = await applyTiaraUpdate({
    ...options,
    target: target('d'),
    prepare: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(prepared.state, 'prepare-failed');
  assert.equal(localTiaraVersion(paths).revision, target('b').commit);
  assert.equal(readFileSync(paths.config, 'utf8'), config);
  assert.equal(readFileSync(join(paths.data, 'share/sentinel'), 'utf8'), 'sessions');
  service.setOwned(false);
  assert.equal((await uninstallTiara({ paths, service })).state, 'not-owned');
  assert.equal(describeTiara(paths).exeExists, true);
  service.setOwned(true);
  assert.equal((await uninstallTiara({ paths, service })).ok, true);
  assert.equal(describeTiara(paths).exeExists, false);
  assert.equal(readFileSync(paths.config, 'utf8'), config);
});

test('新装失败没有伪装成成功；无效源码标识不进入文件操作', async (t) => {
  const { paths, env } = temp(t);
  const service = await serviceFor(t, paths);
  service.setBroken(target('a').commit);
  const result = await installTiara({ paths, env, service, prepare, target: target('a') });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(describeTiara(paths).exeExists, false);
  await assert.rejects(
    applyTiaraUpdate({ paths, env, service, prepare, target: { commit: 'a'.repeat(40), tag: '../../escape' } }),
    /无效/,
  );
});

test('源码 ZIP 路径越界拒绝，正常包按固定前缀解压', (t) => {
  const { root } = temp(t);
  const archive = buildZip([{ name: 'project/src/proxy.js', data: 'hello' }]);
  assert.equal(extractZipTree(archive, root, { prefix: 'project/' }), 1);
  assert.equal(readFileSync(join(root, 'src/proxy.js'), 'utf8'), 'hello');
  for (const name of ['project/../outside', 'project/C:/outside', 'project/dir/../../outside'])
    assert.throws(() => extractZipTree(buildZip([{ name, data: 'bad' }]), root, { prefix: 'project/' }), /不安全/);
});

test('内部端口冲突不启动或结束外部 OpenCode，配置冲突作为启动失败报告', async (t) => {
  const { env } = temp(t);
  const url = await serve(t, (_req, res) => res.end('{}'));
  const port = Number(new URL(url).port);
  const resolved = resolvePluginConfig({ gateway: 'tiara', port: 1, tiaraServerPort: port }, env);
  const service = new GatewayService(resolved.spec, { info() {}, warn() {}, error() {} });
  assert.match((await service.ensureRunning()).reason, /内部端口/);
  assert.equal(service.startedByUs, false);
  const invalid = resolvePluginConfig({ gateway: 'tiara', port: 10001, tiaraServerPort: 10001 }, env);
  assert.match((await new GatewayService(invalid.spec, console).ensureRunning()).reason, /不能/);
});

test('长安装期间插件关闭时丢弃暂存目录，不在释放后启动新后端', async (t) => {
  const { paths, env } = temp(t);
  const service = await serviceFor(t, paths);
  let starts = 0;
  service.ensureRunning = async () => {
    starts++;
    return { state: 'started' };
  };
  const result = await installTiara({
    paths,
    env,
    service,
    target: target('a'),
    prepare: async (options) => {
      await prepare(options);
      service.disposed = true;
    },
  });
  assert.equal(result.state, 'cancelled');
  assert.equal(starts, 0);
  assert.equal(describeTiara(paths).exeExists, false);
});

test('受管启动器等待 provider API 预热，再开放 Tiara API；停止回收整个进程树', async (t) => {
  const { paths, env } = temp(t);
  const { createServer } = await import('node:net');
  const free = () =>
    new Promise((r) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => r(port));
      });
    });
  write(join(paths.current, 'package.json'), JSON.stringify({ type: 'module' }));
  write(
    join(paths.current, 'src/proxy.js'),
    `
    import {createServer} from 'node:http';
    import {existsSync} from 'node:fs';
    import {join} from 'node:path';
    export const buildBackendConfigContent=()=> '{}';
    export function startProxy(config) {
      if(!existsSync(join(process.env.DSH_TIARA_DATA,'providers-ready')))throw new Error('catalog was not warmed');
      return {server:createServer((req,res)=>res.end(JSON.stringify(req.url==='/health'?{status:'ok',proxy:true}:{data:[{id:'fixture'}]}))).listen(config.PORT,config.BIND_HOST)};
    }
  `,
  );
  write(
    join(paths.data, 'workspace/serve'),
    `
    const {createServer}=require('node:http');
    const {writeFileSync}=require('node:fs');
    const {join}=require('node:path');
    const port=Number(process.argv[process.argv.indexOf('--port')+1]);
    createServer((req,res)=>{
      const wanted='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      if(req.headers.authorization!==wanted){res.writeHead(401);res.end('{}');return;}
      if(req.url==='/global/health'){res.end(JSON.stringify({healthy:true,version:'1.19.0'}));return;}
      if(req.url==='/config/providers'){setTimeout(()=>{writeFileSync(join(process.env.DSH_TIARA_DATA,'providers-ready'),'ready');res.end(JSON.stringify({providers:[]}));},150);return;}
      res.writeHead(404);res.end('{}');
    }).listen(port,'127.0.0.1');
  `,
  );
  mkdirSync(dirname(tiaraBinary(paths.current)), { recursive: true });
  copyFileSync(process.execPath, tiaraBinary(paths.current));
  const resolved = resolvePluginConfig(
    { gateway: 'tiara', port: await free(), tiaraServerPort: await free(), readinessTimeoutMs: 5000 },
    { ...process.env, ...env },
  );
  const service = new GatewayService(resolved.spec, { info() {}, warn() {}, error() {} });
  try {
    const result = await service.ensureRunning();
    assert.equal(result.state, 'started', result.reason);
    assert.equal(existsSync(join(paths.data, 'providers-ready')), true);
    const response = await fetch(`http://127.0.0.1:${resolved.spec.port}/v1/models`);
    assert.deepEqual((await response.json()).data, [{ id: 'fixture' }]);
  } finally {
    await service.stop('fixture done');
  }
  const { probeTcp } = await import('../lib/services.js');
  assert.equal(await probeTcp(resolved.spec.port), false);
  assert.equal(await probeTcp(Number(resolved.spec.env.DSH_TIARA_SERVER_PORT)), false);
});
