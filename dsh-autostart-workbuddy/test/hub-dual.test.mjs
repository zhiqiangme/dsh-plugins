import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolvePluginConfig } from '../lib/config.js';
import { describeHubSettings, describeModels, setHubMode } from '../lib/web.js';
import { HUB_ROUTER_PATH, syncModels } from '../lib/models.js';
import { createHubRouter } from '../lib/hub-router.js';
import { diagnose } from '../lib/diagnostics.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

/**
 * 假 hub：与 v1.7.16 的 _request_realm 同序——绑定区域的 Key 优先，其次 X-Realm 头，最后看板全局出口。
 * cn-secret / gl-secret / hw-secret 是绑定 Key；其余 Key 视为未绑定，boundShared 时模拟网关 Key 在 HUB 里被绑到国际。
 * codearts 模拟在 HUB 设置里启用了 CodeArts（/health 才报 configured），codeartsDown 模拟它的目录取不到。
 */
async function setup(t) {
  const hub = { realm: 'intl', wrongBinding: false, boundShared: false, codearts: false, codeartsDown: false, hits: [], chats: [] };
  const server = createServer(async (req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ realm: hub.realm, accounts: 1, accounts_ready: 1, ...(hub.codearts ? { codearts: { configured: true, accounts: 1, healthy: 1 } } : {}) }));
    const key = req.headers.authorization;
    const bound = key === 'Bearer cn-secret' ? 'cn' : key === 'Bearer gl-secret' ? 'intl' : key === 'Bearer hw-secret' ? 'codearts' : hub.boundShared ? 'intl' : '';
    const realm = hub.wrongBinding ? 'intl' : bound || req.headers['x-realm'] || hub.realm;
    hub.hits.push([req.url, realm]);
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      hub.chats.push({ ...JSON.parse(Buffer.concat(chunks)), realm, key });
    }
    if (realm === 'codearts' && hub.codeartsDown) { res.writeHead(502); return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    // CodeArts 的目录没有 credits，catalog.source 也不是 remote。
    const data = realm === 'codearts' ? [{ id: 'shared', name: 'Shared' }, { id: 'GLM-5.2', name: 'GLM-5.2' }] : [{ id: 'shared', name: 'Shared', credits: 'x0.00' }];
    res.end(JSON.stringify(req.url.endsWith('/models') ? { realm, data } : { realm }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, baseURL: `http://127.0.0.1:${server.address().port}` } }, {});
  const editor = createFakeConfigEditor(profileRows());
  const credentials = createFakeCredentials();
  const options = { resolved, editor, credentials, env: {} };
  const router = createHubRouter({ resolved, editor: () => editor, credentials: () => credentials, env: {} });
  const proxy = createServer((req, res) => router.handle(req, res));
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  resolved.models.hubProxyBaseURL = `http://127.0.0.1:${proxy.address().port}${HUB_ROUTER_PATH}/`;
  t.after(() => new Promise((done) => { router.stop(); proxy.closeAllConnections(); proxy.close(done); }));
  const config = () => editor.entry('llm-pi-ai').options.config;
  return { hub, resolved, editor, credentials, options, config };
}

/** 按 llm-pi-ai 的方式发一条对话：provider 的 headers 加上凭据库里 apiKeyEnv 的值。 */
async function chatRealm(provider, credentials, model = provider.models[0].id) {
  const key = (await credentials.resolve(provider.apiKeyEnv)).value;
  const reply = await fetch(`${provider.baseURL}chat/completions`, { method: 'POST', headers: { ...provider.headers, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) });
  assert.equal(reply.status, 200, await reply.clone().text());
  return (await reply.json()).realm;
}

test('HUB 双区域：只有一个 WorkBuddy 分组，CN / GL 同名模型独立路由且不受看板切换影响', async (t) => {
  const { hub, resolved, editor, credentials, options, config } = await setup(t);
  const saved = await setHubMode({ ...options, enabled: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.sync.state, 'updated');
  const { workbuddy } = config().providers;
  assert.deepEqual(Object.keys(config().providers), ['openrouter', 'workbuddy']);
  assert.deepEqual(workbuddy.models.map(({ id, name }) => ({ id, name })), [
    { id: 'cn:shared', name: 'Shared CN Free' }, { id: 'global:shared', name: 'Shared GL Free' },
  ]);
  assert.equal(workbuddy.apiKeyEnv, 'WORKBUDDY_HUB_KEY');
  assert.ok(!credentials.sets.some((row) => /_CN$|_GLOBAL$/.test(row.ref)));
  assert.equal(await chatRealm(workbuddy, credentials, 'cn:shared'), 'cn');
  assert.equal(await chatRealm(workbuddy, credentials, 'global:shared'), 'intl');
  assert.ok(hub.chats.every((chat) => chat.model === 'shared'), 'HUB 收到裸模型 id');

  hub.realm = 'cn';
  const switched = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  assert.equal(switched.state, 'unchanged');
  assert.equal(switched.realm, 'dual');
  assert.equal(config().providers.workbuddy.models[0].name, 'Shared CN Free');
  assert.equal(await chatRealm(config().providers.workbuddy, credentials, 'global:shared'), 'intl', '看板切到 CN 后 GL 仍走国际');

  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  assert.deepEqual(snapshot.models.map((row) => row.id), ['cn:shared', 'global:shared']);
  assert.equal(snapshot.realm, 'dual');
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'unchanged');

  assert.equal((await setHubMode({ ...options, enabled: false })).ok, true);
  assert.equal(config().providers['workbuddy-hub-cn'], undefined);
  assert.equal(config().providers['workbuddy-hub-global'], undefined);
  assert.equal(config().providers.workbuddy.models[0].id, 'shared');
  assert.equal(config().providers.workbuddy.baseURL, `${resolved.models.baseURL}/v1/`, '关闭后恢复直连 HUB');
  assert.ok(config().providers.openrouter);
});

test('区域 Key 是可选覆盖：同一分组按区域取专用凭据，Key 不进 profile 和返回值', async (t) => {
  const { hub, credentials, options, config } = await setup(t);
  const saved = await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' });
  assert.equal(saved.ok, true);
  assert.equal(await chatRealm(config().providers.workbuddy, credentials, 'cn:shared'), 'cn');
  assert.equal(await chatRealm(config().providers.workbuddy, credentials, 'global:shared'), 'intl');
  assert.deepEqual(hub.chats.map((chat) => chat.key), ['Bearer cn-secret', 'Bearer gl-secret']);
  assert.ok(!JSON.stringify(config()).includes('cn-secret'));
  assert.ok(!JSON.stringify(saved).includes('gl-secret'));
  assert.deepEqual(saved.settings, { enabled: true, keys: { cn: 'saved', global: 'saved', codearts: 'missing', follow: 'saved' } });
});

test('未勾选双区域时也保存表单里的三个 Key，重新读取能确认状态，留空不会删除', async (t) => {
  const { resolved, editor, credentials, options, config } = await setup(t);
  const saved = await setHubMode({ ...options, enabled: false, cnKey: 'cn-secret', globalKey: 'gl-secret', followKey: 'follow-secret' });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.settings, { enabled: false, keys: { cn: 'saved', global: 'saved', codearts: 'missing', follow: 'saved' } });
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_CN, 'cn-secret');
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_GLOBAL, 'gl-secret');
  assert.equal(credentials.values.WORKBUDDY_HUB_KEY, 'follow-secret');
  const savedModels = editor.entry('dsh-autostart-workbuddy').options.config.models;
  assert.equal(savedModels.hubApiKeyRef, 'WORKBUDDY_HUB_KEY');
  assert.equal(savedModels.apiKeyRef, undefined, 'HUB 表单不再污染 wb2api 的引用');
  assert.equal(config().providers['workbuddy-hub-cn'], undefined, '保存 Key 不擅自开启固定分组');
  assert.equal(resolved.models.hubDual, false);
  assert.deepEqual(await describeHubSettings(options), saved.settings, '重新打开页面由凭据服务读取持久化状态');
  assert.doesNotMatch(JSON.stringify({ saved, edits: editor.edits }), /cn-secret|gl-secret|follow-secret/);
  const writes = credentials.sets.length;
  const again = await setHubMode({ ...options, enabled: false, cnKey: '', globalKey: '', followKey: '' });
  assert.equal(again.ok, true);
  assert.deepEqual(again.settings, saved.settings);
  assert.equal(credentials.sets.length, writes, '空输入保留已保存的值');
});

test('关闭双区域时保存单个区域 Key；绑定错误先拒绝，不写入其它表单值', async (t) => {
  const { hub, editor, credentials, options } = await setup(t);
  hub.wrongBinding = true;
  const rejected = await setHubMode({ ...options, enabled: false, cnKey: 'cn-secret', globalKey: 'gl-secret' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /CN 区域 Key/);
  assert.deepEqual(editor.edits, []);
  assert.deepEqual(credentials.sets, []);
  hub.wrongBinding = false;
  assert.equal((await setHubMode({ ...options, enabled: false, cnKey: 'cn-secret' })).ok, true);
  assert.deepEqual((await describeHubSettings(options)).keys, { cn: 'saved', global: 'missing', codearts: 'missing', follow: 'saved' });
});

test('Key 状态区分存储、环境、缺失和读取失败，只返回状态', async (t) => {
  const { options } = await setup(t);
  assert.deepEqual((await describeHubSettings(options)).keys, { cn: 'missing', global: 'missing', codearts: 'missing', follow: 'missing' });
  const credentials = createFakeCredentials({ stored: { CUSTOM_KEY: 'custom-secret', WORKBUDDY_PROXY_KEY_CN: 'cn-secret' }, env: { WORKBUDDY_PROXY_KEY_GLOBAL: 'env-secret' } });
  const resolved = { ...options.resolved, models: { ...options.resolved.models, apiKeyRef: 'CUSTOM_KEY' } };
  const result = await describeHubSettings({ ...options, resolved, credentials });
  assert.deepEqual(result.keys, { cn: 'saved', global: 'environment', codearts: 'missing', follow: 'saved' });
  assert.doesNotMatch(JSON.stringify(result), /secret|CUSTOM_KEY/);
  const failed = await describeHubSettings({ ...options, credentials: { resolve: async () => { throw new Error('private-secret'); } } });
  assert.deepEqual(failed.keys, { cn: 'unavailable', global: 'unavailable', codearts: 'unavailable', follow: 'unavailable' });
});

test('设置落盘后同步抛错，仍确认保存成功，不把同步失败误报为保存失败', async (t) => {
  const { editor, credentials, options } = await setup(t);
  editor.onUpdate('dsh-autostart-workbuddy', () => {
    credentials.resolve = async () => { throw new Error('private-secret'); };
  });
  const saved = await setHubMode({ ...options, enabled: false, followKey: 'follow-secret' });
  assert.equal(saved.ok, true);
  assert.equal(credentials.values.WORKBUDDY_HUB_KEY, 'follow-secret');
  assert.equal(saved.sync.state, 'failed');
  assert.doesNotMatch(JSON.stringify(saved), /private-secret|follow-secret/);
});

test('网关 Key 在 HUB 里绑了区域时 X-Realm 无效：拒绝开启；只给被挡住的区域补 Key 即可', async (t) => {
  const { hub, editor, credentials, options, config } = await setup(t);
  hub.boundShared = true;
  const refused = await setHubMode({ ...options, enabled: true });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /跟随面板切换/);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);

  // 网关 Key 绑的是国际：只补 CN 区域 Key，GL 继续用网关 Key。
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret' })).ok, true);
  assert.equal(config().providers.workbuddy.apiKeyEnv, 'WORKBUDDY_HUB_KEY');
  assert.equal(await chatRealm(config().providers.workbuddy, credentials, 'cn:shared'), 'cn');
  assert.equal(await chatRealm(config().providers.workbuddy, credentials, 'global:shared'), 'intl');
});

test('区域 Key 绑定错误和 provider 名称冲突时，不保存模式或凭据', async (t) => {
  const { hub, editor, credentials, options } = await setup(t);
  hub.wrongBinding = true;
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' })).ok, false);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);
  hub.wrongBinding = false;
  editor.entry('llm-pi-ai').options.config.providers['workbuddy-hub-cn'] = { apiKeyEnv: 'USER_KEY' };
  assert.equal((await setHubMode({ ...options, enabled: true })).ok, false);
  assert.deepEqual(editor.edits, []); assert.deepEqual(credentials.sets, []);
});

test('从旧版双区域升级：合并旧分组并保留区域凭据和其它 provider', async (t) => {
  const { resolved, editor, credentials, config } = await setup(t);
  const providers = config().providers;
  const legacy = (ref) => ({ displayName: 'old', apiKeyEnv: ref, baseURL: providers.workbuddy.baseURL, api: 'openai-completions', models: [] });
  providers['workbuddy-hub-cn'] = legacy('WORKBUDDY_PROXY_KEY_CN');
  providers['workbuddy-hub-global'] = legacy('WORKBUDDY_PROXY_KEY_GLOBAL');
  providers.workbuddy = { ...providers.workbuddy, models: [] };
  await credentials.set('WORKBUDDY_PROXY_KEY_CN', 'cn-secret');
  await credentials.set('WORKBUDDY_PROXY_KEY_GLOBAL', 'gl-secret');
  const result = await syncModels({ spec: resolved.spec, models: { ...resolved.models, hubDual: true }, editor, credentials, env: {} });
  assert.equal(result.state, 'updated');
  assert.deepEqual(config().providers.workbuddy.models.map((model) => model.id), ['cn:shared', 'global:shared']);
  assert.equal(config().providers['workbuddy-hub-cn'], undefined);
  assert.equal(config().providers['workbuddy-hub-global'], undefined);
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_CN, 'cn-secret');
  assert.ok(config().providers.openrouter);
});

test('未绑定 Key 单独存入凭据库，关闭双区域后可以继续跟随看板出口', async (t) => {
  const { hub, resolved, editor, credentials, options } = await setup(t);
  const enabled = await setHubMode({ ...options, enabled: true, followKey: 'follow-secret' });
  assert.equal(enabled.ok, true);
  assert.equal((await credentials.resolve('WORKBUDDY_HUB_KEY')).value, 'follow-secret');
  assert.ok(!JSON.stringify(editor.edits).includes('follow-secret'));
  hub.realm = 'cn';
  assert.equal((await setHubMode({ ...options, enabled: false })).ok, true);
  const provider = editor.entry('llm-pi-ai').options.config.providers.workbuddy;
  assert.equal(provider.models[0].name, 'Shared CN Free');
  assert.equal(resolved.models.apiKeyRef, 'WORKBUDDY_HUB_KEY');
});

test('双区域诊断遮盖所有 Key，白名单暂时缺席时不清空分组', async (t) => {
  const { resolved, editor, credentials, options } = await setup(t);
  await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret', globalKey: 'gl-secret' });
  const report = await diagnose({ ...options, service: { recentStderr: ['cn-secret gl-secret'] }, driver: {
    title: 'fixture', probe: async () => ({ ok: true, servable: true, healthy: 2, total: 2 }),
  } });
  assert.deepEqual(report.checks.find((check) => check.id === 'models').detail, { count: 2, realm: 'dual' });
  assert.ok(!JSON.stringify(report).includes('cn-secret'));
  assert.ok(!JSON.stringify(report).includes('gl-secret'));
  assert.ok(!report.checks.some((check) => check.id === 'credential' && !check.ok));
  resolved.models.only = ['cn:missing'];
  resolved.models.rules = { freeOnly: true };
  const before = structuredClone(editor.entry('llm-pi-ai').options.config);
  const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  assert.equal(result.state, 'skipped');
  assert.deepEqual(editor.entry('llm-pi-ai').options.config, before);
});

test('CodeArts：启用后以 HW 列出且默认不勾选，勾选后进同一分组并走 codearts 出口', async (t) => {
  const { hub, resolved, editor, credentials, options, config } = await setup(t);
  hub.codearts = true;
  resolved.models.only = ['cn:shared', 'global:shared'];
  assert.equal((await setHubMode({ ...options, enabled: true })).ok, true);
  assert.deepEqual(config().providers.workbuddy.models.map((model) => model.id), ['cn:shared', 'global:shared'], '没勾过 CodeArts 不把整个目录灌进 DSH');

  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  const row = snapshot.models.find((item) => item.id === 'codearts:GLM-5.2');
  assert.deepEqual([row.label, row.credits, row.price, row.selected], ['GLM-5.2 HW', '', null, false], '没有倍率不能显示成 Free');

  resolved.models.only = ['cn:shared', 'global:shared', 'codearts:GLM-5.2'];
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'updated');
  const { workbuddy } = config().providers;
  assert.deepEqual(workbuddy.models.map(({ id, name }) => ({ id, name })), [
    { id: 'cn:shared', name: 'Shared CN Free' }, { id: 'global:shared', name: 'Shared GL Free' }, { id: 'codearts:GLM-5.2', name: 'GLM-5.2 HW' },
  ]);
  assert.equal(await chatRealm(workbuddy, credentials, 'codearts:GLM-5.2'), 'codearts');
  assert.equal(hub.chats.at(-1).model, 'GLM-5.2', 'HUB 收到裸模型 id');
  assert.equal(await chatRealm(workbuddy, credentials, 'cn:shared'), 'cn', '同名模型按前缀分开路由');

  resolved.models.only = ['cn:shared', 'global:shared'];
  assert.equal((await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} })).state, 'updated');
  assert.deepEqual(config().providers.workbuddy.models.map((model) => model.id), ['cn:shared', 'global:shared'], '全部取消勾选就能去掉 CodeArts');
});

test('CodeArts：同步全部时一起进分组；没启用时不向 HUB 发 codearts 出口', async (t) => {
  const { hub, options, config } = await setup(t);
  assert.equal((await setHubMode({ ...options, enabled: true })).ok, true);
  assert.deepEqual(config().providers.workbuddy.models.map((model) => model.id), ['cn:shared', 'global:shared']);
  assert.ok(!hub.hits.some(([, realm]) => realm === 'codearts'), '旧 HUB 不认识这个出口，不能试探');
  hub.codearts = true;
  assert.equal((await setHubMode({ ...options, enabled: true })).ok, true);
  assert.deepEqual(config().providers.workbuddy.models.map((model) => model.id), ['cn:shared', 'global:shared', 'codearts:shared', 'codearts:GLM-5.2']);
});

test('CodeArts 取不到目录不拖累 CN / GL：已勾选的 HW 模型保留，面板说明原因，取消勾选才移除', async (t) => {
  const { hub, resolved, editor, credentials, options, config } = await setup(t);
  const sync = () => syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  const ids = () => config().providers.workbuddy.models.map((model) => model.id);
  const all = ['cn:shared', 'global:shared', 'codearts:GLM-5.2'];
  hub.codearts = true;
  resolved.models.only = all;
  assert.equal((await setHubMode({ ...options, enabled: true })).ok, true);
  assert.deepEqual(ids(), all);

  hub.codeartsDown = true;
  assert.equal((await sync()).state, 'unchanged');
  assert.deepEqual(ids(), all);
  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  assert.equal(snapshot.ok, true, 'CN / GL 的勾选页照常打开');
  assert.match(snapshot.skipped, /HW 模型接口失败/);
  assert.equal(snapshot.models.find((row) => row.id === 'codearts:GLM-5.2').unavailable, true);

  hub.codeartsDown = false;
  hub.codearts = false;
  assert.equal((await sync()).state, 'unchanged', 'HUB 关掉 CodeArts 不抹掉用户的勾选');
  assert.deepEqual(ids(), all);
  resolved.models.only = ['cn:shared', 'global:shared'];
  assert.equal((await sync()).state, 'updated');
  assert.deepEqual(ids(), ['cn:shared', 'global:shared']);
});

test('网关 Key 绑了区域时 CodeArts 只跳过并说明；HW Key 校验通过才保存，走错出口的不写入', async (t) => {
  const { hub, resolved, credentials, options, config } = await setup(t);
  hub.codearts = true;
  hub.boundShared = true;
  assert.equal((await setHubMode({ ...options, enabled: true, cnKey: 'cn-secret' })).ok, true);
  assert.deepEqual(config().providers.workbuddy.models.map((model) => model.id), ['cn:shared', 'global:shared']);
  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  assert.match(snapshot.skipped, /X-Realm 无法切到 HW/);

  const rejected = await setHubMode({ ...options, enabled: true, codeartsKey: 'gl-secret' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /HW/);
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_CODEARTS, undefined);

  const saved = await setHubMode({ ...options, enabled: true, codeartsKey: 'hw-secret' });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.keys.codearts, 'saved');
  assert.equal(await chatRealm(config().providers.workbuddy, credentials, 'codearts:GLM-5.2'), 'codearts');
  assert.equal(hub.chats.at(-1).key, 'Bearer hw-secret');
  assert.doesNotMatch(JSON.stringify({ saved, config: config() }), /hw-secret/);
});

test('HUB 没启用 CodeArts 时填 HW Key 直接拒绝，不把校验不了的 Key 存进凭据库', async (t) => {
  const { credentials, options } = await setup(t);
  const rejected = await setHubMode({ ...options, enabled: true, codeartsKey: 'hw-secret' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /没有启用 CodeArts/);
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY_CODEARTS, undefined);
});

test('单出口切到 CodeArts：勾选按 codearts: 分开记，DSH 里是裸 id 加 HW 标记', async (t) => {
  const { hub, resolved, editor, credentials, options, config } = await setup(t);
  hub.codearts = true;
  hub.realm = 'codearts';
  resolved.models.only = ['cn:shared'];
  const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: {} });
  assert.equal(result.state, 'updated');
  assert.equal(result.realm, 'codearts');
  assert.deepEqual(config().providers.workbuddy.models.map(({ id, name }) => ({ id, name })), [{ id: 'shared', name: 'Shared HW' }, { id: 'GLM-5.2', name: 'GLM-5.2 HW' }], '这个出口没勾过就是全部');
  const snapshot = await describeModels({ ...options, spec: resolved.spec, models: resolved.models, gateway: 'hub' });
  assert.equal(snapshot.realm, 'codearts');
  assert.deepEqual(snapshot.models.map((row) => row.id), ['codearts:shared', 'codearts:GLM-5.2']);
});
