/**
 * 四个插件的官方更新都靠动态 inject 读 remote.pluginManager。各插件自己的测试用假 remote，
 * 测不出 cordis「不许读未声明服务」的限制，这里用真实 cordis 和宿主相同的服务结构跑一遍。
 * cordis 来自 dsh-presets-zh 的测试依赖，CI 在运行本目录之前已经安装。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Context, Service } from '../../dsh-presets-zh/node_modules/@deepseek-ai/cordis/lib/index.js';

const PLUGINS = [
  ['dsh-presets-zh', '@zhiqiangme/dsh-presets-zh'],
  ['dsh-tavily-search', '@zhiqiangme/dsh-tavily-search'],
  ['dsh-magpie', '@zhiqiangme/dsh-magpie'],
  ['dsh-autostart-workbuddy', '@zhiqiangme/dsh-autostart-workbuddy'],
];
const INSTALLED = '26.1.1';
const LATEST = '26.1.2';

/** 版本路由答「有新版」，其余（dshmarket 探测）一律没有。 */
async function respond(path) {
  const body = { ok: true, currentVersion: INSTALLED, latestVersion: LATEST, updateAvailable: true };
  return String(path).includes('/version') ? new Response(JSON.stringify(body)) : new Response('{}', { status: 404 });
}

function loadClient(dir) {
  const source = readFileSync(new URL(`../../${dir}/lib/client.js`, import.meta.url), 'utf8');
  let registration;
  const window = {
    __ModuleLoader__: { load: (value) => { registration = value; } },
    crypto: webcrypto,
    navigator: {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } };
  // eslint-disable-next-line no-new-func -- 故意在沙箱里跑浏览器 bundle
  new Function('window', 'document', 'console', 'fetch', source)(window, document, console, respond);
  return registration.factory(() => ({}));
}

class Remote extends Service {
  constructor(ctx) {
    super(ctx, 'remote');
    this.owner = ctx;
  }

  $on() {
    return () => {};
  }
}

class PluginManager extends Service {
  constructor(ctx, host) {
    super(ctx, 'remote.pluginManager');
    this.state = host;
  }

  async listBundles() {
    const { packageName, enabled } = this.state;
    const bundle = { name: packageName, version: INSTALLED, source: `${packageName}@${INSTALLED}`, availability: 'profile', updatable: true, enabled };
    return { ok: true, value: [bundle] };
  }

  async listVersions() {
    const versions = [{ version: LATEST, bundle: true, prerelease: false, tags: ['latest'] }];
    return { ok: true, value: { status: 'listed', installed: INSTALLED, registry: 'https://registry.example/', versions } };
  }

  /** 宿主的 bundle-in-use：先把插件移出启用列表，再拒绝卸载。 */
  async updateBundle() {
    this.state.enabled = false;
    await this.state.duringUpdate?.();
    const result = { application: 'failed', error: { code: 'bundle-in-use' } };
    return { ok: true, value: { from: INSTALLED, to: LATEST, step: 'remove', result } };
  }

  async setBundleEnabled(_name, enabled) {
    this.state.enabled = enabled;
    return { ok: true, value: { application: 'applied' } };
  }
}

/** 宿主把 Remote 命名空间挂成 remote 的子 fiber，和插件不在同一分支，这正是未声明读取失败的原因。 */
async function bootHost() {
  const root = new Context();
  await root.plugin({ name: 'host', apply(ctx) { new Remote(ctx); } });
  const mountManager = (host) => root.get('remote').owner.plugin({ name: 'remote.pluginManager', apply(ctx) { new PluginManager(ctx, host); } });
  return { root, mountManager };
}

/** 和插件 apply 里的接法一致：只声明 remote，官方接口由 connectPluginManager 接上。 */
async function bootPlugin(root, module) {
  let updater;
  const fiber = root.plugin({
    name: 'plugin-client',
    inject: ['remote'],
    apply(ctx) {
      updater = module.createPluginUpdater(ctx.remote);
      module.connectPluginManager(ctx, updater);
    },
  });
  await fiber;
  return { fiber, updater };
}

async function until(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('等待超时');
}

test('cordis 不许读未声明的服务：命名空间存在时抛错，所以必须走动态 inject', async () => {
  const { root, mountManager } = await bootHost();
  await mountManager({ packageName: 'x', enabled: true });
  let read;
  await root.plugin({ name: 'undeclared', inject: ['remote'], apply(ctx) { read = () => ctx.remote.pluginManager; } });
  assert.throws(read, /without inject/);
});

for (const [dir, packageName] of PLUGINS) {
  test(`${dir}：官方接口晚于插件挂载也能接上，已检查过的结果随之切到官方路径`, async () => {
    const { root, mountManager } = await bootHost();
    const { updater } = await bootPlugin(root, loadClient(dir));
    await updater.check();
    assert.equal(updater.getSnapshot().manager.phase, 'unsupported');
    await mountManager({ packageName, enabled: true });
    await until(() => updater.getSnapshot().manager.phase === 'ready');
    assert.equal(updater.getSnapshot().manager.candidate, LATEST);
  });

  test(`${dir}：宿主拒绝卸载且更新途中本插件被卸载时，仍用留住的接口补回启用状态`, async () => {
    const { root, mountManager } = await bootHost();
    const host = { packageName, enabled: true };
    await mountManager(host);
    const { fiber, updater } = await bootPlugin(root, loadClient(dir));
    await until(async () => {
      await updater.check();
      return updater.getSnapshot().manager.phase === 'ready';
    });
    host.duringUpdate = () => fiber.dispose();
    await updater.startUpdate();
    const { operation } = updater.getSnapshot();
    assert.equal(operation.inUse, true);
    assert.equal(operation.reselectFailure, undefined);
    assert.equal(host.enabled, true);
  });
}
