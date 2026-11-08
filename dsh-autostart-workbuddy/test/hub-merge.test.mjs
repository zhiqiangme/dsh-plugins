import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginConfig } from '../lib/config.js';
import { createExitCredits, parseStamp, rankExits, readCodeArtsExpiry, readWorkBuddyExpiry } from '../lib/exit-credits.js';
import { conversationKey, createHubRouter, requestHasImage } from '../lib/hub-router.js';
import { HUB_PANEL_PASSWORD_REF, HUB_ROUTER_PATH, mergeKey, syncModels } from '../lib/models.js';
import { setHubMode } from '../lib/web.js';
import { createFakeConfigEditor, createFakeCredentials, profileRows } from '../fixtures/fake-config-editor.mjs';

const NOW = new Date(2026, 10, 5, 12, 0, 0).getTime();
const DAY = 86_400_000;

/** hub 写的是本地时间串。 */
function stamp(ms) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(ms);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 与实际目录同构：同一模型各出口的倍率、上下文、输出上限、视觉都可能不同。 */
const CATALOG = {
  cn: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', credits: 'x0.11', context_length: 1000000, max_output_tokens: 128000, supports_images: true },
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69', context_length: 1000000, max_output_tokens: 64000, supports_images: true },
    { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', credits: 'x0.97', context_length: 1000000, max_output_tokens: 32000, supports_images: true },
    { id: 'hy4std', name: 'Hy4', credits: 'x0.29', context_length: 960000, max_output_tokens: 64000, supports_images: true },
    { id: 'hy4free', name: 'Hy4', credits: 'x0.00', context_length: 960000, max_output_tokens: 64000, supports_images: true },
  ],
  intl: [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11', context_length: 1000000, max_output_tokens: 128000, supports_images: true },
    { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', credits: 'x0.97', context_length: 1000000, max_output_tokens: 32000, supports_images: true },
    { id: 'hy4std', name: 'Hy4', credits: 'x0.29', context_length: 1000000, max_output_tokens: 64000, supports_images: true },
    { id: 'hy4free', name: 'Hy4', credits: 'x0.00', context_length: 1000000, max_output_tokens: 64000, supports_images: true },
  ],
  codearts: [
    { id: 'deepseek-v4.1-flash-1017', name: 'deepseek-v4.1-flash-1017', credits: 'x0.18', context_length: 1048576, max_output_tokens: 65536, supports_images: true },
    { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', credits: 'x0.18', context_length: 1048576, max_output_tokens: 65536, supports_images: true },
    { id: 'glm-5.3', name: 'glm-5.3', credits: 'x0.79', context_length: 1048576, max_output_tokens: 65536, reasoning_efforts: ['low', 'high'] },
    { id: 'kimi-k3.1-pro', name: 'kimi-k3.1-pro', credits: 'x1.63', context_length: 1048576, max_output_tokens: 65536, supports_images: true },
  ],
};

function account(realm, packages, extra = {}) {
  return { uid: `${realm}-uid`, realm, enabled: true, accessToken: 'secret-token', credits: { remain: 100, packages, updated_at: NOW / 1000 }, ...extra };
}

/** 假 hub：目录、/health、面板登录和对话；chat 决定每次对话怎么应答。 */
async function setup(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wb-merge-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const accounts = join(home, 'autostart-workbuddy', 'hub', 'data', 'accounts');
  mkdirSync(accounts, { recursive: true });
  // 有哈希才算改过密码：否则插件会用出厂密码 admin 自动登录。
  writeFileSync(join(accounts, 'settings.json'), JSON.stringify({ panel_password_hash: 'x', panel_password_default: false }));

  const hub = { catalog: CATALOG, codearts: true, codeartsDown: false, password: 'panel-pass', logins: [], overviews: 0, tokens: new Set(), hwEndDate: '', hwRemain: 50, chats: [], reply: undefined, replyBody: undefined, ready: { cn: 1, intl: 1 }, accounts: { cn: 1, intl: 1 }, realm: 'cn', refreshed: [], refreshReply: undefined };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ realm: hub.realm, accounts_by_realm: hub.accounts, accounts_ready_by_realm: hub.ready, ...(hub.codearts ? { codearts: { configured: true, healthy: 1 } } : {}) }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    if (req.url === '/panel/login') {
      hub.logins.push(body.password);
      if (body.password !== hub.password) { res.writeHead(401); return res.end('{}'); }
      const token = `token-${hub.logins.length}`;
      hub.tokens.add(token);
      return res.end(JSON.stringify({ ok: true, token }));
    }
    if (req.url === '/codearts/overview') {
      if (!hub.tokens.has(req.headers['x-panel-token'])) { res.writeHead(401); return res.end('{}'); }
      hub.overviews += 1;
      return res.end(JSON.stringify({ accounts: [{ disabled: false, credits: { remain: hub.hwRemain, expiring: 20, end_date: hub.hwEndDate } }] }));
    }
    if (req.url === '/catalog/refresh' || req.url === '/codearts/models/refresh') {
      if (!hub.tokens.has(req.headers['x-panel-token'])) { res.writeHead(401); return res.end('{}'); }
      const exit = body.realm ?? 'codearts';
      hub.refreshed.push(exit);
      // 与 hub 同形：/catalog/refresh 成败都回 200，CodeArts 只回模型数。
      return res.end(JSON.stringify(hub.refreshReply?.(exit) ?? (exit === 'codearts' ? { ok: true, models: hub.catalog.codearts.length } : { ok: true, realm: exit, source: 'remote', count: hub.catalog[exit].length })));
    }
    const realm = req.headers['x-realm'] || 'cn';
    if (req.url.endsWith('/models')) {
      await hub.beforeCatalog?.(realm);
      if (hub.catalogDown) { res.writeHead(503); return res.end('{}'); }
      if (realm === 'codearts' && hub.codeartsDown) { res.writeHead(502); return res.end('{}'); }
      return res.end(JSON.stringify({ realm, data: hub.catalog[realm], ...(hub.source?.[realm] ? { catalog: hub.source[realm] } : {}) }));
    }
    hub.chats.push({ ...body, realm });
    const answer = hub.reply?.(realm, body) ?? 200;
    res.writeHead(answer);
    res.end(JSON.stringify(answer === 200 ? { realm } : { error: { message: hub.replyBody ?? `from ${realm}` } }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));

  const only = options.only ?? ['cn:deepseek-v4.1-flash', 'global:deepseek-v4.1-flash', 'codearts:deepseek-v4.1-flash-1017', 'cn:glm-5.3', 'codearts:glm-5.3', 'cn:kimi-k3.1-pro', 'global:kimi-k3.1-pro', 'codearts:kimi-k3.1-pro', 'cn:hy4std', 'global:hy4std', 'cn:hy4free', 'global:hy4free'];
  const env = { DSH_HOME: home };
  const resolved = resolvePluginConfig({ gateway: 'hub', models: { enabled: true, hubDual: true, only, baseURL: `http://127.0.0.1:${server.address().port}`, ...options.models } }, env);
  resolved.models.hubProxyBaseURL = `http://127.0.0.1:1${HUB_ROUTER_PATH}/`;
  const rows = [
    ...profileRows(),
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'workbuddy', model: 'codearts:deepseek-v4.1-flash-1017' } },
    { id: 'subagent', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [
      { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' },
      { provider: 'workbuddy', model: 'global:deepseek-v4.1-flash' },
      { provider: 'trae', model: 'cn:deepseek-v4.1-flash' },
      { provider: 'workbuddy', model: 'codearts:deepseek-v4.1-flash-1017' },
    ] } },
  ];
  const editor = createFakeConfigEditor(rows);
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_HUB_KEY: 'shared', ...options.stored } });
  const clock = { now: NOW };
  const now = () => clock.now;
  const exits = createExitCredits({ resolved, credentials: () => credentials, env, now });
  const router = createHubRouter({ resolved, editor: () => editor, credentials: () => credentials, env, now, exits });
  const proxy = createServer((req, res) => router.handle(req, res));
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { router.stop(); proxy.closeAllConnections(); proxy.close(done); }));
  const send = (body) => fetch(`http://127.0.0.1:${proxy.address().port}${HUB_ROUTER_PATH}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer shared' }, body: JSON.stringify(body),
  });
  const writeAccount = (name, value) => writeFileSync(join(accounts, `${name}.json`), JSON.stringify(value));
  const sync = (extra) => syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env, ...extra });
  const listed = () => editor.entry('llm-pi-ai').options.config.providers.workbuddy.models;
  return { hub, resolved, editor, credentials, env, exits, send, sync, listed, writeAccount, accounts, clock };
}

const ask = (text = 'hello', model = 'auto:kimi-k3.1-pro') => ({ model, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: text }] });

/** DSH 模型列表里看到的 id 和名称。 */
const shown = (x) => x.listed().map(({ id, name }) => [id, name]);

test('合并键按 id 不按展示名：大小写、月日版本号和计费档位不算区别，同名不同 id 不合并', () => {
  assert.equal(mergeKey('cn:DeepSeek-V4.1-Flash'), mergeKey('global:deepseek-v4.1-flash'));
  assert.equal(mergeKey('auto:glm-5.3'), mergeKey('codearts:glm-5.3'));
  assert.equal(mergeKey('cn:hy4std'), 'hy4');
  assert.equal(mergeKey('global:hy4free'), 'hy4');
  assert.equal(mergeKey('auto:hy4'), 'hy4');
  assert.equal(mergeKey('cn:model-free-1017'), 'model');
  assert.notEqual(mergeKey('cn:hy3'), mergeKey('cn:hy3-x'), 'Hy3 同名，但 id 看不出是同款');
  assert.equal(mergeKey('cn:free'), 'free', '不能变成空键');
  assert.equal(mergeKey('cn:deepseek-v4.1-flash'), mergeKey('codearts:deepseek-v4.1-flash-1017'));
  assert.equal(mergeKey('cn:deepseek-r1-0528'), 'deepseek-r1');
  for (const id of ['model-2000', 'model-1301', 'model-0132', 'glm-5.3']) assert.equal(mergeKey(id), id, '不是合法月日的数字不算版本号');
});

test('多个出口的同一模型并成一条，名称带 Auto', async (t) => {
  const x = await setup(t);
  assert.equal((await x.sync()).state, 'updated');
  const byId = new Map(x.listed().map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId.keys()].sort(), ['auto:deepseek-v4.1-flash', 'auto:glm-5.3', 'auto:hy4', 'auto:kimi-k3.1-pro']);
  assert.equal(byId.get('auto:deepseek-v4.1-flash').name, 'DeepSeek-V4.1-Flash Auto 0.11-0.18', 'HW 的 -1017 并进来，名称取 CN');
  assert.equal(byId.get('auto:kimi-k3.1-pro').name, 'Kimi-K3.1-Pro Auto 0.97-1.63', '倍率不同显示范围');
  assert.equal(byId.get('auto:hy4').name, 'Hy4 Auto Free-0.29', '免费和付费并成一条，免费排在范围最前');
});

test('只勾了免费版时显示 Free；只勾付费版时显示一个倍率', async (t) => {
  const free = await setup(t, { only: ['cn:hy4free', 'global:hy4free'] });
  await free.sync();
  assert.deepEqual(free.listed().map(({ id, name }) => [id, name]), [['auto:hy4', 'Hy4 Auto Free']]);
  const paid = await setup(t, { only: ['cn:hy4std', 'global:hy4std'] });
  await paid.sync();
  assert.deepEqual(paid.listed().map(({ id, name }) => [id, name]), [['auto:hy4', 'Hy4 Auto 0.29']]);
});

test('同一出口勾了免费和付费也算多个可选项；只勾一版时显示它本身的名称，id 不变', async (t) => {
  const x = await setup(t, { only: ['cn:hy4free', 'cn:hy4std', 'global:kimi-k3.1-pro'] });
  await x.sync();
  assert.deepEqual(shown(x).sort(), [['auto:hy4', 'Hy4 Auto Free-0.29'], ['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro GL 0.97']]);
  x.resolved.models = { ...x.resolved.models, only: ['cn:hy4free', 'global:kimi-k3.1-pro'] };
  await x.sync();
  assert.deepEqual(shown(x).sort(), [['auto:hy4', 'Hy4 CN Free'], ['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro GL 0.97']]);
});

test('只勾一个的模型也是 auto: 开头，显示它本身的名称；同一出口的新旧版本只留最新的', async (t) => {
  const x = await setup(t, { only: ['codearts:deepseek-v4.1-flash-1017', 'codearts:deepseek-v4.1-flash', 'cn:kimi-k3.1-pro', 'global:hy4std'] });
  await x.sync();
  assert.deepEqual(shown(x), [
    ['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro CN 0.97'],
    ['auto:hy4', 'Hy4 GL 0.29'],
    ['auto:deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash-1017 HW 0.18'],
  ]);
});

test('名称不带版本号：排在最前的出口只有带版本号的模型时也去掉', async (t) => {
  const x = await setup(t, { only: ['global:kimi-k3.1-pro', 'codearts:kimi-k3.1-pro', 'cn:glm-5.3'] });
  x.hub.catalog = { ...CATALOG, intl: [{ id: 'kimi-k3.1-pro-0813', name: 'Kimi-K3.1-Pro-0813', credits: 'x0.97' }] };
  x.resolved.models = { ...x.resolved.models, only: ['global:kimi-k3.1-pro-0813', 'codearts:kimi-k3.1-pro', 'cn:glm-5.3'] };
  await x.sync();
  assert.equal(x.listed().find((entry) => entry.id === 'auto:kimi-k3.1-pro').name, 'Kimi-K3.1-Pro Auto 0.97-1.63');
});

test('同一出口新旧版本都勾选时转发到新版，发给 hub 的是带版本号的真实 id', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' }, only: ['cn:deepseek-v4.1-flash', 'codearts:deepseek-v4.1-flash', 'codearts:deepseek-v4.1-flash-1017', 'global:hy4std'] });
  x.hub.hwEndDate = stamp(NOW + DAY).slice(0, 10);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.sync();
  assert.deepEqual(x.listed().map((entry) => entry.id), ['auto:deepseek-v4.1-flash', 'auto:hy4']);
  await x.send(ask('a', 'auto:deepseek-v4.1-flash'));
  assert.deepEqual(x.hub.chats.map(({ realm, model }) => [realm, model]), [['codearts', 'deepseek-v4.1-flash-1017']]);
});

test('合并条目的能力：上下文和输出取最小，档位取交集，视觉取并集', async (t) => {
  const x = await setup(t);
  await x.sync();
  const byId = new Map(x.listed().map((entry) => [entry.id, entry]));
  const kimi = byId.get('auto:kimi-k3.1-pro');
  assert.equal(kimi.contextWindow, 1000000);
  assert.equal(kimi.maxTokens, 32000);
  const glm = byId.get('auto:glm-5.3');
  assert.deepEqual(glm.input, ['text', 'image'], 'HW 不支持视觉不能拖累整条');
  assert.deepEqual(glm.reasoningEfforts, { low: 'low', high: 'high' }, 'CodeArts 对档位外的请求直接 400');
  assert.equal(byId.get('auto:hy4').contextWindow, 960000);
  assert.equal(byId.get('auto:deepseek-v4.1-flash').maxTokens, 65536, 'HW 的输出上限比 CN / GL 低');
});

test('没勾选的出口不参与；增减勾选时 id 不变，只有显示名称变，引用不用改', async (t) => {
  const x = await setup(t, { only: ['cn:kimi-k3.1-pro', 'global:kimi-k3.1-pro'] });
  await x.sync();
  assert.deepEqual(shown(x), [['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro Auto 0.97']], '没勾选的 HW 倍率不计入');
  x.editor.entry('agent-default-model').options.config.model = 'auto:kimi-k3.1-pro';
  // 留一个 GL 勾选：某个出口一条都没勾时按「全部」算。
  x.resolved.models = { ...x.resolved.models, only: ['cn:kimi-k3.1-pro', 'global:hy4std'] };
  await x.sync();
  assert.deepEqual(shown(x), [['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro CN 0.97'], ['auto:hy4', 'Hy4 GL 0.29']]);
  assert.equal(x.editor.entry('agent-default-model').options.config.model, 'auto:kimi-k3.1-pro');
  x.resolved.models = { ...x.resolved.models, only: ['cn:kimi-k3.1-pro', 'global:kimi-k3.1-pro', 'global:hy4std'] };
  await x.sync();
  assert.deepEqual(shown(x)[0], ['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro Auto 0.97']);
});

test('从旧版升级：定时同步把单出口的 cn: 条目换成 auto:，不算移除，引用跟着改', async (t) => {
  const x = await setup(t, { only: ['cn:kimi-k3.1-pro', 'global:hy4std'] });
  x.editor.entry('llm-pi-ai').options.config.providers.workbuddy.models = [{ id: 'cn:kimi-k3.1-pro', name: 'Kimi-K3.1-Pro CN 0.97' }, { id: 'global:hy4std', name: 'Hy4 GL 0.29' }];
  x.editor.entry('agent-default-model').options.config.model = 'cn:kimi-k3.1-pro';
  assert.equal((await x.sync({ removalGuard: {} })).state, 'updated');
  assert.deepEqual(shown(x), [['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro CN 0.97'], ['auto:hy4', 'Hy4 GL 0.29']]);
  assert.equal(x.editor.entry('agent-default-model').options.config.model, 'auto:kimi-k3.1-pro');
});

test('同步时把旧的出口 id 引用改到 auto: 并去重，不动别的 provider', async (t) => {
  const x = await setup(t);
  const result = await x.sync();
  assert.deepEqual(result.refs, { state: 'updated', count: 2 });
  assert.deepEqual(x.editor.entry('subagent').options.config.allowedModels, [
    { provider: 'workbuddy', model: 'auto:deepseek-v4.1-flash' },
    { provider: 'trae', model: 'cn:deepseek-v4.1-flash' },
  ]);
  assert.equal(x.editor.entry('agent-default-model').options.config.model, 'auto:deepseek-v4.1-flash', '-1017 并进合并条目后，默认模型跟着改');
  assert.deepEqual((await x.sync()).refs, { state: 'kept' }, '已对齐时不重复写');
});

test('引用：旧的 auto:hy4free 改到 auto:hy4', async (t) => {
  const x = await setup(t);
  const defaults = x.editor.entry('agent-default-model');
  defaults.options.config.model = 'auto:hy4free';
  await x.sync();
  assert.equal(x.editor.entry('agent-default-model').options.config.model, 'auto:hy4');
});

test('区域模式往返切换：裸 id 与 auto: 引用双向迁移，子代理去重且不动其它 provider', async (t) => {
  const x = await setup(t, { models: { hubDual: false } });
  const defaults = x.editor.entry('agent-default-model');
  const subagent = x.editor.entry('subagent');
  defaults.options.config.model = 'deepseek-v4.1-flash';
  subagent.options.config.allowedModels = [
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' },
    { provider: 'trae', model: 'deepseek-v4.1-flash' },
  ];
  for (const enabled of [true, false]) {
    const result = await setHubMode({ ...x, enabled });
    const id = `${enabled ? 'auto:' : ''}deepseek-v4.1-flash`;
    assert.equal(result.ok, true);
    assert.equal(result.sync.state, 'updated');
    assert.equal(defaults.options.config.model, id);
    assert.ok(x.listed().some((entry) => entry.id === id));
    assert.deepEqual(subagent.options.config.allowedModels, [
      { provider: 'workbuddy', model: id },
      { provider: 'trae', model: 'deepseek-v4.1-flash' },
    ]);
  }
});

test('关闭双区域：合并计费档位的引用优先回到免费版，原始付费引用仍保留原模型', async (t) => {
  const x = await setup(t);
  const defaults = x.editor.entry('agent-default-model');
  defaults.options.config.model = 'auto:hy4';
  x.editor.entry('subagent').options.config.allowedModels = [{ provider: 'workbuddy', model: 'cn:hy4std' }];
  assert.equal((await setHubMode({ ...x, enabled: false })).ok, true);
  assert.equal(defaults.options.config.model, 'hy4free');
  assert.equal(x.editor.entry('subagent').options.config.allowedModels[0].model, 'hy4std');
});

test('单区域清单已写入但引用失败时，下次同步补迁移；预览不写引用', async (t) => {
  const x = await setup(t, { models: { hubDual: false } });
  const defaults = x.editor.entry('agent-default-model');
  defaults.options.config.model = 'auto:deepseek-v4.1-flash';
  const edit = x.editor.edit.bind(x.editor);
  x.editor.edit = async (entry, change) => {
    if (entry === defaults) throw new Error('模拟引用写入失败');
    return edit(entry, change);
  };
  const first = await x.sync();
  assert.equal(first.state, 'updated');
  assert.equal(first.refs.state, 'failed');
  x.editor.edit = edit;
  const before = x.editor.edits.length;
  assert.equal((await x.sync({ dryRun: true })).state, 'unchanged');
  assert.equal(x.editor.edits.length, before);
  assert.equal(defaults.options.config.model, 'auto:deepseek-v4.1-flash');
  const retry = await x.sync();
  assert.equal(retry.state, 'unchanged');
  assert.equal(retry.refs.state, 'updated');
  assert.equal(defaults.options.config.model, 'deepseek-v4.1-flash');
});

test('CodeArts 这轮取不到时，含 HW 的条目原样留在原位，引用不动；取消勾选才移除', async (t) => {
  const x = await setup(t, { only: ['cn:glm-5.3', 'codearts:glm-5.3', 'global:hy4std', 'codearts:kimi-k3.1-pro'] });
  await x.sync();
  assert.deepEqual(shown(x), [['auto:glm-5.3', 'GLM-5.3 Auto 0.69-0.79'], ['auto:hy4', 'Hy4 GL 0.29'], ['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro HW 1.63']]);
  const before = structuredClone(x.listed());
  x.editor.entry('agent-default-model').options.config.model = 'auto:glm-5.3';
  x.hub.codeartsDown = true;
  assert.equal((await x.sync({ removalGuard: {} })).state, 'unchanged', '名称和能力不跟着这一轮变，也不改写 profile');
  assert.deepEqual(x.listed(), before);
  assert.equal(x.editor.entry('agent-default-model').options.config.model, 'auto:glm-5.3');
  x.resolved.models = { ...x.resolved.models, only: ['cn:glm-5.3', 'global:hy4std', 'codearts:glm-5.3'] };
  await x.sync();
  assert.ok(!x.listed().some((entry) => entry.id === 'auto:kimi-k3.1-pro'));
});

test('移除确认：CodeArts 的种子目录没有时间戳，不能把 CN / GL 的下架一直卡住', async (t) => {
  const x = await setup(t, { only: [] });
  x.hub.source = { cn: { source: 'remote', fetched_at: 100 }, intl: { source: 'remote', fetched_at: 100 }, codearts: { source: 'codearts' } };
  await x.sync();
  assert.ok(x.listed().some((entry) => entry.id === 'auto:glm-5.3'));
  const gone = (models) => models.filter((model) => model.id !== 'glm-5.3');
  x.hub.catalog = { ...CATALOG, cn: gone(CATALOG.cn), codearts: gone(CATALOG.codearts) };
  const guard = {};
  assert.equal((await x.sync({ removalGuard: guard })).state, 'deferred', '只看一次不算');
  x.hub.source.cn.fetched_at = 400;
  x.hub.source.intl.fetched_at = 400;
  assert.equal((await x.sync({ removalGuard: guard })).state, 'updated');
  assert.ok(!x.listed().some((entry) => entry.id === 'auto:glm-5.3'));
});

test('目录暂缺已勾选的模型时推迟写入，合并条目不会悄悄少一个出口', async (t) => {
  const x = await setup(t);
  await x.sync();
  const before = structuredClone(x.listed());
  x.hub.catalog = { ...CATALOG, intl: CATALOG.intl.filter((model) => model.id !== 'kimi-k3.1-pro') };
  assert.equal((await x.sync()).state, 'deferred');
  assert.deepEqual(x.listed(), before);
  x.hub.catalog = { ...CATALOG, codearts: CATALOG.codearts.filter((model) => model.id !== 'deepseek-v4.1-flash-1017') };
  assert.equal((await x.sync()).state, 'deferred', '带版本号的勾选也受保护');
  assert.deepEqual(x.listed(), before);
});

test('路由组始终开启：profile 里残留的 hubMerge: false 不再生效', async (t) => {
  const x = await setup(t, { models: { hubMerge: false } });
  await x.sync();
  assert.ok(x.listed().every((entry) => entry.id.startsWith('auto:')));
});

test('积分到期：跳过用完、已过期、不过期和停用账号的包，取最早的', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-credit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  save('a.json', account('cn', [
    { remain: 0, expire_time: stamp(NOW + DAY) },
    { remain: 5, expire_time: stamp(NOW - DAY) },
    { remain: 5, expire_time: stamp(NOW + 9 * 365 * DAY) },
    { remain: 5, no_expiry: true, expire_time: stamp(NOW + 2 * DAY) },
    { remain: 5, package_code: 'enterprise', expire_time: stamp(NOW + 2 * DAY) },
    { remain: 68.17, expire_time: stamp(NOW + 3 * DAY) },
    { remain: 7, expire_time: stamp(NOW + 4 * DAY) },
  ]));
  save('b.json', account('global', [{ remain: 3, expire_time: stamp(NOW + 2 * DAY) }]));
  save('c.json', account('intl', [{ remain: 3, expire_time: stamp(NOW + DAY) }], { enabled: false }));
  save('settings.json', { panel_password_hash: 'x' });
  writeFileSync(join(dir, 'broken.json'), '{');
  const exits = readWorkBuddyExpiry(dir, NOW);
  assert.equal(exits.cn.expireAt, Math.floor((NOW + 3 * DAY) / 1000) * 1000);
  assert.equal(exits.cn.expiring, 68.17);
  assert.equal(exits.intl.expireAt, Math.floor((NOW + 2 * DAY) / 1000) * 1000, 'global 与 intl 是同一出口，停用的账号不算');
  assert.doesNotMatch(JSON.stringify(exits), /secret-token/);
  assert.deepEqual(readWorkBuddyExpiry(join(dir, 'missing'), NOW).cn.expireAt, null);
});

test('时间解析：hub 的本地时间串、只有日期按当天结束、时间戳和非法值', () => {
  assert.equal(parseStamp('2026-11-07 09:00:10'), new Date(2026, 10, 7, 9, 0, 10).getTime());
  assert.equal(parseStamp('2026-11-07T09:00:10'), new Date(2026, 10, 7, 9, 0, 10).getTime());
  assert.equal(parseStamp('2026-12-01'), new Date(2026, 11, 1, 23, 59, 59).getTime());
  assert.equal(parseStamp(1_790_000_000), 1_790_000_000_000);
  assert.equal(parseStamp(1_790_000_000_000), 1_790_000_000_000);
  assert.equal(parseStamp(''), null);
  assert.equal(parseStamp('soon'), null);
});

test('HW 到期：只算有积分、没停用的账号', () => {
  const exit = readCodeArtsExpiry({ accounts: [
    { disabled: true, credits: { remain: 9, end_date: '2026-11-06' } },
    { credits: { remain: 0, end_date: '2026-11-06' } },
    { credits: { remain: 9, expiring: 4, end_date: '2026-11-10' } },
    { credits: { remain: 9, end_date: '2026-12-10' } },
  ] }, NOW);
  assert.equal(exit.state, 'ready');
  assert.equal(exit.expireAt, new Date(2026, 10, 10, 23, 59, 59).getTime());
  assert.equal(exit.expiring, 4);
  assert.equal(readCodeArtsExpiry({ accounts: [{ credits: { remain: 9, end_date: '' } }] }, NOW).state, 'none');
});

test('排序：最早到期优先，未知排后，相同比倍率，都未知走固定顺序', () => {
  const members = [{ realm: 'cn', price: 0.97 }, { realm: 'intl', price: 0.97 }, { realm: 'codearts', price: 1.63 }];
  const order = (credits, options) => rankExits(members, credits, options).map((member) => member.realm);
  assert.deepEqual(order({ cn: { expireAt: 3 }, intl: { expireAt: 2 }, codearts: { expireAt: 1 } }), ['codearts', 'intl', 'cn'], '只看到期，不因倍率高就跳过');
  assert.deepEqual(order({ cn: { expireAt: null }, intl: { expireAt: 2 } }), ['intl', 'cn', 'codearts']);
  assert.deepEqual(order({ cn: { expireAt: 5 }, codearts: { expireAt: 5 } }), ['cn', 'codearts', 'intl']);
  assert.deepEqual(order({}), ['cn', 'intl', 'codearts']);
  assert.deepEqual(order({ cn: { expireAt: 1 } }, { ready: new Set(['intl']) }), ['intl'], '没有可用账号的出口不选');
  assert.deepEqual(order({ cn: { expireAt: 1 } }, { ready: new Set() }), ['cn', 'intl', 'codearts'], '都不可用时照常发，让 hub 报真实错误');
});

test('排序：免费的不花积分，优先且不看到期；带图只走支持视觉的出口', () => {
  const free = [{ realm: 'cn', price: 0.29 }, { realm: 'intl', price: 0 }, { realm: 'codearts', price: 0 }];
  assert.deepEqual(rankExits(free, { cn: { expireAt: 1 }, codearts: { expireAt: 2 }, intl: { expireAt: 9 } }).map((m) => m.realm), ['intl', 'codearts', 'cn']);
  const vision = [{ realm: 'cn', vision: false }, { realm: 'codearts', vision: true }];
  assert.deepEqual(rankExits(vision, { cn: { expireAt: 1 } }, { image: true }).map((m) => m.realm), ['codearts']);
  assert.deepEqual(rankExits([{ realm: 'cn', vision: false }], {}, { image: true }).map((m) => m.realm), ['cn']);
});

test('排序：同一出口的免费和付费是两个成员，免费的都排在付费前', () => {
  const members = [
    { realm: 'cn', model: 'hy4std', price: 0.29, vision: true }, { realm: 'cn', model: 'hy4free', price: 0 },
    { realm: 'intl', model: 'hy4std', price: 0.29, vision: true }, { realm: 'intl', model: 'hy4free', price: 0 },
  ];
  const order = (options) => rankExits(members, { cn: { expireAt: 2 }, intl: { expireAt: 1 } }, options).map(({ realm, model }) => `${realm}:${model}`);
  assert.deepEqual(order(), ['cn:hy4free', 'intl:hy4free', 'intl:hy4std', 'cn:hy4std']);
  assert.deepEqual(order({ image: true }), ['intl:hy4std', 'cn:hy4std'], '免费版不支持视觉时，带图请求只走付费版');
});

test('识别带图请求和同一对话', () => {
  assert.equal(requestHasImage({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(requestHasImage({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }] }), true);
  const first = ask('task');
  const later = { ...first, messages: [{ role: 'system', content: '现在是 12:01' }, ...first.messages.slice(1), { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  assert.equal(conversationKey(first), conversationKey(later), '系统提示和后续消息变化不算新对话');
  assert.notEqual(conversationKey(first), conversationKey(ask('other')));
  assert.notEqual(conversationKey(first), conversationKey(ask('task', 'auto:glm-5.3')));
  assert.equal(conversationKey({ model: 'x', messages: [] }), undefined);
});

test('转发：按最早到期选出口，发给 hub 的是该出口的裸 id', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + 2 * DAY) }]));
  const response = await x.send(ask());
  assert.equal(response.status, 200);
  assert.deepEqual(x.hub.chats.map(({ realm, model }) => [realm, model]), [['intl', 'kimi-k3.1-pro']]);
});

test('转发：填了面板密码后 HW 参与比较，会话复用，不每次登录', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  x.hub.hwEndDate = stamp(NOW + DAY).slice(0, 10);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.send(ask('a'));
  await x.send(ask('b'));
  assert.deepEqual(x.hub.chats.map(({ realm }) => realm), ['codearts', 'codearts']);
  assert.deepEqual(x.hub.logins, ['panel-pass']);
  assert.equal(x.hub.overviews, 1, '30 分钟内不重复读华为云');
});

test('转发：hub 重启让面板会话失效后重新登录一次', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  x.hub.hwEndDate = '2026-12-01';
  await x.exits.snapshot();
  await new Promise((done) => setImmediate(done));
  x.hub.tokens.clear();
  x.clock.now += 31 * 60_000;
  await x.exits.snapshot();
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(x.hub.logins.length, 2);
  assert.equal(x.hub.overviews, 2);
});

test('转发：没填面板密码时 HW 排在有到期时间的出口之后，不尝试登录', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.send(ask());
  assert.equal(x.hub.chats[0].realm, 'cn');
  assert.deepEqual(x.hub.logins, []);
  assert.equal((await x.exits.snapshot()).codearts.state, 'no-password');
});

test('重拉目录：双区域依次让 hub 重拉三个出口，只登录一次', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  assert.deepEqual(await x.exits.refreshCatalogs(), { state: 'done', exits: [
    { realm: 'cn', state: 'updated', count: 5 },
    { realm: 'intl', state: 'updated', count: 4 },
    { realm: 'codearts', state: 'updated', count: 4 },
  ] });
  assert.deepEqual(x.hub.refreshed, ['cn', 'intl', 'codearts']);
  assert.deepEqual(x.hub.logins, ['panel-pass']);
});

test('重拉目录：冷却和失败只记在那个出口上，后面的出口照常', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  x.hub.refreshReply = (exit) => ({ cn: { ok: false, cooldown: true, retry_after: 12.4 }, intl: { ok: false, msg: '上游未返回可用目录' } })[exit];
  assert.deepEqual((await x.exits.refreshCatalogs()).exits, [
    { realm: 'cn', state: 'cooldown', retryAfter: 12.4 },
    { realm: 'intl', state: 'failed' },
    { realm: 'codearts', state: 'updated', count: 4 },
  ]);
});

test('重拉目录：没账号的出口不打上游；单出口模式只拉看板当前这个', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  x.hub.accounts = { cn: 1, intl: 0 };
  x.hub.codearts = false;
  await x.exits.refreshCatalogs();
  assert.deepEqual(x.hub.refreshed.splice(0), ['cn']);
  x.hub.accounts = { cn: 1, intl: 1 };
  x.hub.realm = 'intl';
  x.resolved.models = { ...x.resolved.models, hubDual: false };
  x.clock.now += 6000;
  await x.exits.refreshCatalogs();
  assert.deepEqual(x.hub.refreshed, ['intl']);
});

test('重拉目录：没有面板密码时不发请求；密码错误只试一次；hub 不通时不抛错', async (t) => {
  const none = await setup(t);
  assert.deepEqual(await none.exits.refreshCatalogs(), { state: 'no-password' });
  assert.deepEqual([none.hub.logins, none.hub.refreshed], [[], []]);
  const wrong = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'wrong' } });
  assert.deepEqual(await wrong.exits.refreshCatalogs(), { state: 'auth-failed' });
  assert.deepEqual(await wrong.exits.refreshCatalogs(), { state: 'auth-failed' });
  assert.deepEqual(wrong.hub.logins, ['wrong'], 'hub 一分钟 5 次失败会连浏览器一起锁住');
  wrong.resolved.models = { ...wrong.resolved.models, baseURL: 'http://127.0.0.1:1' };
  wrong.clock.now += 6000;
  assert.deepEqual(await wrong.exits.refreshCatalogs(), { state: 'unavailable' });
});

test('密码不对只试一次：hub 一分钟 5 次失败会连浏览器一起锁住', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'wrong' } });
  assert.equal((await x.exits.snapshot()).codearts.state, 'auth-failed');
  for (let round = 0; round < 3; round += 1) {
    x.clock.now += 6 * 60_000;
    await x.exits.snapshot();
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.deepEqual(x.hub.logins, ['wrong']);
  await x.credentials.set(HUB_PANEL_PASSWORD_REF, 'panel-pass');
  x.exits.reset();
  x.hub.hwEndDate = '2026-12-01';
  assert.equal((await x.exits.snapshot()).codearts.state, 'ready');
});

test('转发：带图请求跳过不支持视觉的出口', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  x.hub.hwEndDate = stamp(NOW + DAY).slice(0, 10);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.send(ask('text only', 'auto:glm-5.3'));
  await x.send({ model: 'auto:glm-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] });
  assert.deepEqual(x.hub.chats.map(({ realm }) => realm), ['codearts', 'cn']);
});

test('转发：三天以外继续固定出口；新对话重新选；空闲一小时后重选', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + 6 * DAY) }]));
  await x.send(ask('task'));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + 4 * DAY) }]));
  x.clock.now += 2 * 60_000;
  await x.send({ ...ask('task'), messages: [...ask('task').messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] });
  await x.send(ask('new task'));
  assert.deepEqual(x.hub.chats.map(({ realm }) => realm), ['cn', 'cn', 'intl']);
  x.clock.now += 61 * 60_000;
  await x.send(ask('task'));
  assert.equal(x.hub.chats.at(-1).realm, 'intl');
});

test('转发：跨入三天边界时临期渠道抢占固定出口，两边都临期后仍保持固定', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + 6 * DAY) }]));
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro']);
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + 3 * DAY + 120_000) }]));
  x.clock.now += 119_999;
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro'], '超过三天 1ms 仍保留原出口');
  x.clock.now += 1;
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['intl:kimi-k3.1-pro'], '恰好三天即抢占，不必等模型报错或快照刷新');
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + DAY) }]));
  x.clock.now += 60_000;
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['intl:kimi-k3.1-pro'], '两边都临期，保留已经成功的 GL');
  await x.send(ask('new task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro'], '新对话在同档内沿用最早到期排序');
});

test('转发：免费优先于临期；免费均失败时临期付费渠道抢占原付费出口', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + 6 * DAY) }]));
  x.hub.reply = (_realm, body) => body.model === 'hy4free' ? 429 : 200;
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free', 'cn:hy4std']);
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + DAY) }]));
  x.clock.now += 60_000;
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free', 'intl:hy4std']);
  x.hub.reply = undefined;
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['cn:hy4free'], '免费恢复后优先于刚固定的临期付费渠道');
});

test('转发：未知、用尽和快照中已过期的积分不抢占固定出口', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro']);
  x.writeAccount('gl', account('intl', [{ remain: 0, expire_time: stamp(NOW + DAY) }]));
  x.clock.now += 60_000;
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro']);
  x.clock.now += 60_000;
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(x.clock.now + 1000) }]));
  await x.exits.snapshot();
  x.clock.now += 1000;
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro'], '缓存里的到期时间恰好到达，不再算临期');
});

test('转发：临期 HW 可抢占非临期固定出口，但仍受视觉能力限制', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' } });
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.hub.hwEndDate = stamp(NOW + 6 * DAY).slice(0, 10);
  await x.send(ask('task', 'auto:glm-5.3'));
  assert.deepEqual(sentTo(x), ['cn:glm-5.3']);
  x.hub.hwEndDate = stamp(NOW + DAY).slice(0, 10);
  x.exits.reset();
  await x.send(ask('task', 'auto:glm-5.3'));
  assert.deepEqual(sentTo(x), ['codearts:glm-5.3']);
  const body = ask('task', 'auto:glm-5.3');
  body.messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] });
  await x.send(body);
  assert.deepEqual(sentTo(x), ['cn:glm-5.3'], 'HW 不支持该模型的视觉，临期也不能选它');
});

test('转发：临期渠道没有账号时不抢占；临期请求被风控拒绝仍不跨渠道重试', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro']);
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + DAY) }]));
  x.hub.accounts = { cn: 1, intl: 0 };
  x.clock.now += 60_000;
  await x.send(ask('task'));
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro']);
  x.hub.accounts = { cn: 1, intl: 1 };
  x.clock.now += 5000;
  x.hub.reply = () => 403;
  assert.equal((await x.send(ask('task'))).status, 403);
  assert.deepEqual(sentTo(x), ['intl:kimi-k3.1-pro']);
});

test('转发：固定的出口没有账号时换一个，之后固定在新出口', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  await x.send(ask('task'));
  x.hub.accounts = { cn: 0, intl: 1 };
  x.clock.now += 10_000;
  await x.send(ask('task'));
  x.hub.accounts = { cn: 1, intl: 1 };
  x.clock.now += 10_000;
  await x.send(ask('task'));
  assert.deepEqual(x.hub.chats.map(({ realm }) => realm), ['cn', 'intl', 'intl']);
});

/** 发给 hub 的每次请求：`出口:真实 id`。 */
function sentTo(x) {
  return x.hub.chats.splice(0).map(({ realm, model }) => `${realm}:${model}`);
}

test('转发：先试免费版，都不可用才用付费版，付费版按积分到期选', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + DAY) }]));
  assert.equal((await x.send(ask('a', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free'], '免费的不看到期');
  x.hub.reply = (_realm, body) => (body.model === 'hy4free' ? 429 : 200);
  assert.equal((await x.send(ask('b', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free', 'intl:hy4std']);
});

test('转发：对话回退到付费版后下一轮仍先试免费版，付费版之间不换出口', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.writeAccount('gl', account('intl', [{ remain: 5, expire_time: stamp(NOW + DAY) }]));
  x.hub.reply = (_realm, body) => (body.model === 'hy4free' ? 429 : 200);
  await x.send(ask('task', 'auto:hy4'));
  assert.equal(sentTo(x).at(-1), 'intl:hy4std');
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 3600_000) }]));
  x.clock.now += 2 * 60_000;
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free', 'intl:hy4std'], '到期变了也留在原来的付费出口');
  x.hub.reply = undefined;
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['cn:hy4free'], '免费版恢复后马上回去');
});

test('转发：冷缓存且目录不可用时仍先免费后付费，同一对话下一轮重试免费', async (t) => {
  // 付费排在勾选清单前面，不能被当成调用优先级。
  const x = await setup(t, { only: ['cn:hy4std', 'global:hy4std', 'cn:hy4free', 'global:hy4free'] });
  x.hub.catalogDown = true;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free']);
  x.hub.reply = (_realm, body) => body.model.endsWith('free') ? 429 : 200;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free', 'cn:hy4std']);
  x.hub.reply = undefined;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free']);
});

test('转发：目录不可用的兜底仍遵守排除和免费规则，不将未知价格当作免费', async (t) => {
  const x = await setup(t, { only: ['cn:hy4std', 'cn:hy4free', 'global:hy4std', 'global:hy4free'], models: { rules: { freeOnly: true }, exclude: ['cn:hy4free'] } });
  x.hub.catalogDown = true;
  x.hub.reply = () => 429;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 429);
  assert.deepEqual(sentTo(x), ['intl:hy4free'], '不回退到被排除的免费版，也不使用付费或未知价格成员');
  x.resolved.models = { ...x.resolved.models, only: ['cn:kimi-k3.1-pro'] };
  assert.equal((await x.send(ask('unknown-price'))).status, 404);
  assert.equal(x.hub.chats.length, 0);
});

test('转发：兜底认出带日期版本的免费档，并沿用同档只选最新版的规则', async (t) => {
  const x = await setup(t, { only: ['cn:hy4std-1106', 'cn:hy4free-1017', 'cn:hy4free-1106', 'global:kimi-k3.1-pro'] });
  x.hub.catalogDown = true;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free-1106']);
});

test('转发：同一对话在免费版之间也固定出口', async (t) => {
  const x = await setup(t);
  x.hub.reply = (realm) => (realm === 'cn' ? 503 : 200);
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free']);
  x.hub.reply = undefined;
  await x.send(ask('task', 'auto:hy4'));
  assert.deepEqual(sentTo(x), ['intl:hy4free']);
});

test('转发：请求没被受理时换下一个出口并固定下来', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + 5 * DAY) }]));
  x.hub.reply = (realm) => (realm === 'cn' ? 503 : 200);
  assert.equal((await x.send(ask('task'))).status, 200);
  assert.deepEqual(x.hub.chats.map(({ realm }) => realm), ['cn', 'intl']);
  x.hub.reply = undefined;
  await x.send(ask('task'));
  assert.equal(x.hub.chats.at(-1).realm, 'intl');
});

test('转发：风控 403 和参数错误不换出口，全部失败时返回最后一个的错误', async (t) => {
  const x = await setup(t);
  x.hub.reply = () => 403;
  assert.equal((await x.send(ask('blocked'))).status, 403);
  assert.equal(x.hub.chats.length, 1, '跨出口重打会牵连另一边');
  x.hub.chats.length = 0;
  x.hub.reply = () => 400;
  assert.equal((await x.send(ask('bad'))).status, 400);
  assert.equal(x.hub.chats.length, 1);
  x.hub.chats.length = 0;
  x.hub.reply = () => 429;
  const failed = await x.send(ask('limited'));
  assert.equal(failed.status, 429);
  assert.equal(x.hub.chats.length, 3);
  assert.deepEqual(await failed.json(), { error: { message: 'from codearts' } });
});

/** hub 的 restriction_hold_message 开头：判定只靠这段正文，hub 改措辞时这里要跟着核对。 */
const RESTRICTION_HOLD = '上游风控已限制本区域账号（403 / code 11140，账号存在异常行为）。网关已暂停派发 1800 秒';

test('转发：风控暂停期间的 429 不换出口，把 hub 的说明交给用户', async (t) => {
  const x = await setup(t);
  x.hub.reply = (realm) => (realm === 'cn' ? 429 : 200);
  x.hub.replyBody = RESTRICTION_HOLD;
  const held = await x.send(ask('task', 'auto:hy4'));
  assert.equal(held.status, 429);
  assert.deepEqual(sentTo(x), ['cn:hy4free'], '换出口会牵连同一台设备上的账号');
  assert.deepEqual(await held.json(), { error: { message: RESTRICTION_HOLD } });
});

test('转发：账号全部不可用的出口也要问 hub，否则会绕过风控暂停', async (t) => {
  const x = await setup(t);
  x.hub.ready = { cn: 0, intl: 1 };
  x.hub.reply = (realm) => (realm === 'cn' ? 429 : 200);
  x.hub.replyBody = RESTRICTION_HOLD;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 429);
  assert.deepEqual(sentTo(x), ['cn:hy4free']);
});

test('转发：账号全部不可用但没有暂停时，问过 hub 后照常换出口', async (t) => {
  const x = await setup(t);
  x.hub.ready = { cn: 0, intl: 1 };
  x.hub.reply = (realm) => (realm === 'cn' ? 503 : 200);
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:hy4free', 'intl:hy4free']);
});

test('转发：另一个出口风控暂停时，已固定在这边的对话继续用', async (t) => {
  const x = await setup(t);
  x.hub.reply = (realm) => (realm === 'cn' ? 503 : 200);
  await x.send(ask('task', 'auto:hy4'));
  x.hub.chats.length = 0;
  x.hub.reply = (realm) => (realm === 'cn' ? 429 : 200);
  x.hub.replyBody = RESTRICTION_HOLD;
  assert.equal((await x.send(ask('task', 'auto:hy4'))).status, 200);
  assert.deepEqual(sentTo(x), ['intl:hy4free']);
});

test('转发：取消勾选某个出口后立即生效，不等出口表过期', async (t) => {
  const x = await setup(t);
  x.writeAccount('cn', account('cn', [{ remain: 5, expire_time: stamp(NOW + DAY) }]));
  await x.send(ask('a'));
  x.resolved.models = { ...x.resolved.models, only: x.resolved.models.only.filter((id) => id !== 'cn:kimi-k3.1-pro') };
  await x.send(ask('b'));
  assert.deepEqual(x.hub.chats.map(({ realm }) => realm), ['cn', 'intl']);
});

test('转发：目录刷新失败时不复用已取消勾选的出口，即使对话之前固定在该出口', async (t) => {
  const x = await setup(t);
  await x.send(ask('same-task'));
  assert.equal(x.hub.chats.at(-1).realm, 'cn');
  x.resolved.models = { ...x.resolved.models, only: ['cn:glm-5.3', 'global:kimi-k3.1-pro'] };
  x.hub.catalogDown = true;
  assert.equal((await x.send(ask('same-task'))).status, 200);
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro', 'intl:kimi-k3.1-pro']);
  x.resolved.models = { ...x.resolved.models, only: ['cn:glm-5.3', 'global:hy4std'] };
  assert.equal((await x.send(ask('same-task'))).status, 404);
  assert.equal(x.hub.chats.length, 0);
});

test('转发：旧目录查询未完成时改勾选，并发请求都等待新配置的路由表', { timeout: 5000 }, async (t) => {
  const x = await setup(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  x.hub.beforeCatalog = async () => { entered.resolve(); await release.promise; };
  const first = x.send(ask('first'));
  await entered.promise;
  x.resolved.models = { ...x.resolved.models, only: ['cn:glm-5.3', 'global:kimi-k3.1-pro'] };
  const second = x.send(ask('second'));
  x.hub.beforeCatalog = undefined;
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.deepEqual(sentTo(x), ['intl:kimi-k3.1-pro', 'intl:kimi-k3.1-pro']);
});

test('转发：只有一个可选项时走选中的出口，不读到期数据', async (t) => {
  const x = await setup(t, { stored: { [HUB_PANEL_PASSWORD_REF]: 'panel-pass' }, only: ['cn:kimi-k3.1-pro', 'global:hy4std'] });
  await x.sync();
  assert.equal((await x.send(ask())).status, 200);
  assert.deepEqual(sentTo(x), ['cn:kimi-k3.1-pro']);
  assert.deepEqual(x.hub.logins, [], '单出口模型不该等 HW 的首次读取');
});

test('转发：只勾了 HW 的模型在目录取不到时按勾选转发；取消勾选后报 404', async (t) => {
  const x = await setup(t, { only: ['codearts:kimi-k3.1-pro', 'cn:glm-5.3', 'global:hy4std'] });
  await x.sync();
  x.hub.codeartsDown = true;
  assert.equal((await x.send(ask('a'))).status, 200);
  assert.deepEqual(sentTo(x), ['codearts:kimi-k3.1-pro']);
  x.resolved.models = { ...x.resolved.models, only: ['cn:glm-5.3', 'global:hy4std'] };
  assert.equal((await x.send(ask('b'))).status, 404);
  assert.equal(x.hub.chats.length, 0);
});

test('转发：未知的合并模型报明确错误，显式出口的 id 照旧', async (t) => {
  const x = await setup(t);
  assert.equal((await x.send(ask('x', 'auto:not-a-model'))).status, 404);
  assert.equal(x.hub.chats.length, 0);
  assert.equal((await x.send(ask('x', 'auto:deepseek-v4.1-flash-1017'))).status, 200, '版本号写在 id 里也认得出');
  x.hub.chats.length = 0;
  await x.send(ask('x', 'codearts:kimi-k3.1-pro'));
  assert.deepEqual(x.hub.chats.map(({ realm, model }) => [realm, model]), [['codearts', 'kimi-k3.1-pro']]);
});

test('面板密码：校验通过才存进凭据库，不进配置和返回值；错误的不保存', async (t) => {
  const x = await setup(t);
  const options = { resolved: x.resolved, editor: x.editor, credentials: x.credentials, env: x.env, exits: x.exits, enabled: true };
  const wrong = await setHubMode({ ...options, panelPassword: 'nope' });
  assert.deepEqual(wrong, { ok: false, reason: '面板密码不正确' });
  assert.equal(x.credentials.values[HUB_PANEL_PASSWORD_REF], undefined);
  const saved = await setHubMode({ ...options, panelPassword: 'panel-pass' });
  assert.equal(saved.ok, true);
  assert.equal(x.credentials.values[HUB_PANEL_PASSWORD_REF], 'panel-pass');
  assert.equal(saved.settings.keys.panel, 'saved');
  assert.doesNotMatch(JSON.stringify({ saved, profile: x.editor.edits }), /panel-pass/);
});

test('面板密码来自环境变量时只校验，不写凭据库', async (t) => {
  const x = await setup(t);
  const env = { ...x.env, [HUB_PANEL_PASSWORD_REF]: 'panel-pass' };
  const options = { resolved: x.resolved, editor: x.editor, credentials: x.credentials, env, enabled: true };
  assert.equal((await setHubMode({ ...options, panelPassword: 'panel-pass' })).ok, true);
  assert.equal(x.credentials.values[HUB_PANEL_PASSWORD_REF], undefined);
  assert.equal((await setHubMode({ ...options, panelPassword: 'other' })).ok, false);
});

