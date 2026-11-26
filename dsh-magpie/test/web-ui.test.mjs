import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MagpieWeb, WEB_KEY_REF, WEB_ORIGIN } from '../lib/web-ui.js';
import { resolveConfig } from '../lib/config.js';
import { ModelManager } from '../lib/runtime.js';
import { fakeHost } from '../fixtures/host.mjs';
import { backendFixture, finish } from '../fixtures/backend.mjs';
import { autoStartMagpie } from '../lib/lifecycle.js';

const key = 'fixture-magpie-web-key-1234567890';
const ready = (port = '3430') => new Response(null, { status: 303, headers: { 'set-cookie': `magpie_web_${port}=${key}; Path=/; HttpOnly; SameSite=Lax`, location: '/' } });
const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
function seed(backend) { mkdirSync(dirname(backend.paths.exe), { recursive: true }); writeFileSync(backend.paths.exe, 'magpie 0.1.1'); }

test('模型目录 API 沿用网页认证和当前保存设置，只发送渠道 ID，不打开浏览器或泄露密钥', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') return res.writeHead(303, { 'set-cookie': `magpie_web_${server.address().port}=${key}; Path=/; HttpOnly` }).end();
    assert.equal(req.headers.cookie, `magpie_web_${server.address().port}=${key}`);
    assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: url.pathname, method: req.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/providers' ? { providers: [{ id: 'workbuddy' }] } : { count: 22 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const f = backendFixture(t);
  mkdirSync(dirname(f.backend.paths.settings), { recursive: true });
  writeFileSync(join(dirname(f.backend.paths.settings), 'web-page.json'), JSON.stringify({ mode: 'local', port: server.address().port, key }));
  const web = new MagpieWeb({ settings: f.backend.paths.settings, env: {}, openBrowser: () => assert.fail('后台刷新不打开浏览器') });
  const api = await web.modelAPI();
  assert.deepEqual((await api('providers')).providers, [{ id: 'workbuddy' }]);
  assert.deepEqual(await api('provider/models', { id: 'workbuddy' }), { count: 22 });
  assert.deepEqual(calls, [{ path: '/api/providers', method: 'GET', body: undefined }, { path: '/api/provider/models', method: 'POST', body: { id: 'workbuddy' } }]);
  await assert.rejects(api('../settings', {}), /不支持/);
});

test('模型目录 API 可以回退插件已有密钥；认证和上游错误不回显秘密，也不生成新密钥', async () => {
  let generated = false, apiCalls = 0;
  const web = new MagpieWeb({ env: {}, credentials: { resolve: async () => ({ value: key }), set: () => { generated = true; } }, fetchImpl: async (url) => {
    if (url.includes('?k=')) return ready();
    apiCalls++; return new Response(`secret: ${key}`, { status: 500 });
  } });
  web.appPage = () => ({ origin: WEB_ORIGIN, key: 'old-invalid-key-12345678' });
  const fetchImpl = web.fetchImpl;
  web.fetchImpl = (url, options) => url.includes('old-invalid-key') ? new Response('unauthorized', { status: 401 }) : fetchImpl(url, options);
  const api = await web.modelAPI();
  await assert.rejects(api('provider/models', { id: 'workbuddy' }), (error) => error.message.includes('500') && !error.message.includes(key));
  assert.equal(apiCalls, 1);
  assert.equal(generated, false);
  web.fetchImpl = refused;
  await assert.rejects(web.modelAPI(), (error) => !error.message.includes(key) && /网页管理未就绪/.test(error.message));
});

test('从插件追加 Tavily Key，首次创建来源、已存在时提示，其他错误不会触发创建', async () => {
  const tavily = 'tvly-test-secret';
  const calls = [];
  let reply = () => Response.json({ error: 'no tavily search API is set up' }, { status: 400 });
  const web = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, openBrowser: () => assert.fail('后台添加不打开浏览器'), fetchImpl: async (url, init) => {
    if (url.includes('?k=')) return ready();
    assert.equal(init.headers.cookie, `magpie_web_3430=${key}`);
    assert.equal(init.redirect, 'error');
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) });
    return path.endsWith('search-keys') ? reply() : Response.json({ searchAPIs: [{ vendor: 'tavily' }] });
  } });
  assert.equal(await web.addTavilyKey(tavily), true);
  assert.deepEqual(calls.splice(0), [
    { path: '/api/settings/search-keys', body: { vendor: 'tavily', add: tavily } },
    { path: '/api/settings/search-api', body: { vendor: 'tavily', key: tavily, append: true } },
  ]);
  reply = () => Response.json({ added: 0, had: 1 });
  assert.equal(await web.addTavilyKey(tavily), false);
  reply = () => Response.json({ error: tavily }, { status: 400 });
  await assert.rejects(web.addTavilyKey(tavily), (error) => !error.message.includes(tavily));
  assert.ok(calls.every(({ path }) => path.endsWith('search-keys')));
});

test('从 Magpie 读取脱敏的 Tavily 密钥，按 ref 关联额度并允许配额读取失败', async () => {
  const first = '0000000000000001', second = '0000000000000002', third = '0000000000000003';
  const privateKey = 'tvly-test-secret-never-exposed';
  let available = true;
  const web = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, fetchImpl: async (url, init) => {
    if (url.includes('?k=')) return ready();
    const path = new URL(url).pathname;
    if (path === '/api/settings') return Response.json({ searchAPIs: [
      { vendor: 'brave', keyList: [] },
      { vendor: 'tavily', keyList: [
        { ref: first, masked: 'tvly-…1234', key: privateKey },
        { ref: second, masked: privateKey, off: true },
        { ref: third, masked: 'tvly-…9012' },
      ] },
    ] });
    assert.equal(path, '/api/settings/search-quota');
    assert.deepEqual(JSON.parse(init.body), { vendor: 'tavily', fresh: true });
    return available ? Response.json({ keys: [
      { ref: third, known: true, unlimited: true },
      { ref: second, known: false, err: privateKey },
      { ref: first, known: true, used: 96, limit: 1000, of: 'plan', paygoLeft: 80 },
    ] }) : Response.json({ error: privateKey }, { status: 502 });
  } });
  const listed = await web.tavilyKeys(true);
  assert.deepEqual(listed, [
    { ref: first, masked: 'tvly-…1234', off: false, quota: { remaining: 904, limit: 1000, shared: true, paygoLeft: 80 } },
    { ref: second, masked: '…', off: true, quota: null },
    { ref: third, masked: 'tvly-…9012', off: false, quota: { unlimited: true } },
  ]);
  available = false;
  assert.deepEqual(await web.tavilyKeys(true), listed.map((row) => ({ ...row, quota: null })));
});

test('移除只按 ref 操作，最新列表只有目标密钥时才移除 Tavily 来源', async () => {
  const first = '0000000000000001', second = '0000000000000002';
  let refs = [first, second], rejectLastEnabled = false;
  const settings = () => ({ searchAPIs: refs.length ? [{ vendor: 'tavily', keyList: refs.map((ref) => ({ ref })) }] : [] });
  const calls = [];
  const web = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, fetchImpl: async (url, init) => {
    if (url.includes('?k=')) return ready();
    const path = new URL(url).pathname;
    const body = init.body && JSON.parse(init.body);
    calls.push({ path, body });
    if (path === '/api/settings') return Response.json(settings());
    if (path.endsWith('/search-api')) {
      assert.deepEqual(body, { vendor: 'tavily', remove: true });
      refs = [];
      return Response.json(settings());
    }
    assert.equal(path, '/api/settings/search-keys');
    assert.deepEqual(body, { vendor: 'tavily', ref: body.ref, remove: true });
    if (refs.length === 1 || rejectLastEnabled) {
      return Response.json({ error: 'Tavily needs a key on: switch the API off, or remove it, instead' }, { status: 400 });
    }
    refs = refs.filter((ref) => ref !== body.ref);
    return Response.json({ settings: settings() });
  } });
  rejectLastEnabled = true;
  await assert.rejects(web.removeTavilyKey(first), /启用另一把密钥/);
  assert.deepEqual(refs, [first, second]);
  assert.ok(!calls.some(({ path }) => path.endsWith('/search-api')));
  rejectLastEnabled = false;
  await web.removeTavilyKey(first);
  assert.deepEqual(refs, [second]);
  assert.deepEqual(calls.at(-1), { path: '/api/settings/search-keys', body: { vendor: 'tavily', ref: first, remove: true } });
  await web.removeTavilyKey(second);
  assert.deepEqual(refs, []);
  assert.equal(calls.at(-1).path, '/api/settings/search-api');
});

test('启动方式默认网页，严格校验；托盘启动不创建网页密钥', async (t) => {
  assert.equal(resolveConfig().startMode, 'web');
  assert.equal(resolveConfig({ startMode: 'tray' }).startMode, 'tray');
  for (const startMode of ['', 'serve', 'web --lan', true, null]) assert.throws(() => resolveConfig({ startMode }), /启动方式/);
  const f = backendFixture(t);
  seed(f.backend);
  const manager = { config: resolveConfig({ startMode: 'tray' }), backend: f.backend };
  await autoStartMagpie(manager, { platform: 'win32', fetchImpl: refused, findRunning: async () => false });
  assert.deepEqual(f.launchArgs, [['tray']]);
  assert.equal(f.keys.size, 0);
});

test('网页密钥持久化且并发只生成一次，子进程拿到密钥，状态接口和配置不回显', async (t) => {
  const f = backendFixture(t);
  const [first, second] = await Promise.all([f.backend.web.key(), f.backend.web.key()]);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(f.keys.get(WEB_KEY_REF), first);
  const next = new MagpieWeb({ credentials: { resolve: async () => ({ value: first }) } });
  assert.equal(await next.key(), first);
  seed(f.backend);
  await f.backend.launchConfigured(f.backend.paths.exe);
  assert.deepEqual(f.launchArgs, [['serve', '--web']]);
  assert.equal(f.launchOptions[0].env.MAGPIE_WEB_KEY, first);
  const host = fakeHost();
  const manager = new ModelManager(host.ctx, {}, { backend: f.backend });
  assert.equal(JSON.stringify(await manager.describe()).includes(first), false);
  assert.equal(JSON.stringify(resolveConfig()).includes(WEB_KEY_REF), false);
});

test('凭据库不可写或密钥非法时不启动，修复后可重试；环境变量密钥优先', async (t) => {
  const f = backendFixture(t, { credentials: { resolve: async () => undefined } });
  await assert.rejects(f.backend.launchConfigured(f.backend.paths.exe), /不可写/);
  assert.equal(f.launches.length, 0);
  f.backend.web.credentials = { resolve: async () => ({ value: key }) };
  await f.backend.launchConfigured(f.backend.paths.exe);
  assert.equal(f.launches.length, 1);
  const external = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, credentials: { resolve: () => assert.fail('不应读凭据库') } });
  assert.equal(await external.key(), key);
  for (const bad of ['short', 'a'.repeat(16) + ' secret']) await assert.rejects(new MagpieWeb({ env: { MAGPIE_WEB_KEY: bad } }).key(), /密钥无效/);
});

test('打开网页先启动服务并等认证就绪，并发打开只启动一次，不执行原生窗口命令', async (t) => {
  let serving = false, calls = 0;
  const opened = [];
  const web = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, fetchImpl: async () => serving ? ready() : refused(), openBrowser: async (url) => opened.push(url), pollMs: 1 });
  const f = backendFixture(t, { web, launch: async (_path, args, options) => {
    assert.deepEqual(args, ['serve', '--web']);
    assert.equal(options.env.MAGPIE_WEB_KEY, key);
    calls++; serving = true; return 4321;
  } });
  seed(f.backend);
  await Promise.all([f.backend.open(), f.backend.open()]);
  assert.equal(calls, 1);
  assert.deepEqual(opened, [`${WEB_ORIGIN}/?k=${key}`]);
  await f.backend.open();
  assert.equal(calls, 1, '网页已就绪时仅打开浏览器');
  assert.equal(opened.length, 2);
});

test('下载升级时仍可内嵌或在浏览器打开现有管理页，网页离线时不另起进程', async (t) => {
  const downloadStarted = Promise.withResolvers(), resume = Promise.withResolvers();
  const opened = [];
  let online = true;
  const web = new MagpieWeb({
    env: { MAGPIE_WEB_KEY: key }, fetchImpl: async () => online ? ready() : refused(),
    openBrowser: async (url) => opened.push(url),
  });
  const f = backendFixture(t, { web });
  seed(f.backend);
  f.backend.fetchImpl = async (url, options) => {
    if (url === f.asset.browser_download_url) {
      downloadStarted.resolve();
      await resume.promise;
    }
    return f.fetchImpl(url, options);
  };
  const host = fakeHost({ startMode: 'web' });
  const manager = new ModelManager(host.ctx, host.own.options.config, { env: {}, backend: f.backend });
  f.backend.install();
  try {
    await downloadStarted.promise;
    assert.equal(f.backend.operation.phase, 'downloading');
    assert.equal((await manager.handle({ action: 'web-ensure' })).proxyPath, '/plugins/dsh-magpie/ui/');
    assert.equal((await manager.handle({ action: 'backend-open' })).opened, 'web');
    assert.deepEqual(opened, [`${WEB_ORIGIN}/?k=${key}`]);

    online = false;
    await assert.rejects(manager.handle({ action: 'web-ensure' }), /正在更新程序/);
    await assert.rejects(manager.handle({ action: 'backend-open' }), /正在更新程序/);
    assert.deepEqual(f.launches, []);
    assert.deepEqual(f.stops, []);
  } finally {
    resume.resolve();
    await finish(f.backend);
  }
});

test('既有桌面网页使用其文件中的地址和密钥，真实 HTTP 登录挑战不泄露到状态结果', async (t) => {
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').searchParams.get('k') !== key) return res.writeHead(401).end();
    res.writeHead(303, { 'set-cookie': `magpie_web_${server.address().port}=${key}; Path=/; HttpOnly`, location: '/' }).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const f = backendFixture(t);
  mkdirSync(dirname(f.backend.paths.settings), { recursive: true });
  const port = server.address().port;
  writeFileSync(join(dirname(f.backend.paths.settings), 'web-page.json'), JSON.stringify({ mode: 'local', port, key }));
  const opened = [];
  const web = new MagpieWeb({ settings: f.backend.paths.settings, openBrowser: async (url) => opened.push(url) });
  assert.deepEqual(await web.open({ launch: () => assert.fail('已有网页不能再启动'), isRunning: () => assert.fail('无需查进程') }), { opened: 'web' });
  assert.deepEqual(opened, [`http://127.0.0.1:${port}/?k=${key}`]);
});

test('端口被占用、密钥不匹配或状态未知时不重复启动，也不打开其它软件页面', async () => {
  for (const fetchImpl of [async () => new Response('unauthorized', { status: 401 }), async () => new Response('another server'), async () => { throw new Error('unknown'); }]) {
    const web = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, fetchImpl, openBrowser: () => assert.fail('不能打开未知页面') });
    await assert.rejects(web.open({ launch: () => assert.fail('不能抢端口'), isRunning: () => assert.fail('无需查进程') }), /密钥|网页状态/);
  }
});

test('切换方式不结束已有实例；旧实例无网页时明确提示重启，失败不回显密钥', async () => {
  const web = new MagpieWeb({ env: { MAGPIE_WEB_KEY: key }, fetchImpl: refused, openBrowser: () => assert.fail(), timeoutMs: 5, pollMs: 1 });
  await assert.rejects(web.open({ launch: () => assert.fail('不能重复拉起旧实例'), isRunning: async () => true }), (error) => /退出 Magpie 后重新启动/.test(error.message) && !error.message.includes(key));
});

test('托盘首次安装打开原生窗口，升级及失败恢复仍按托盘方式启动', async (t) => {
  const f = backendFixture(t);
  f.backend.install(undefined, { startMode: 'tray' });
  assert.equal((await finish(f.backend)).phase, 'installed');
  assert.deepEqual(f.launchArgs, [[]]);
  assert.equal(f.keys.size, 0);
  f.backend.latest = null;
  writeFileSync(f.backend.paths.exe, 'magpie 0.1.1');
  f.backend.versions.clear();
  f.backend.install(undefined, { startMode: 'tray' });
  assert.equal((await finish(f.backend)).phase, 'updated');
  assert.deepEqual(f.launchArgs, [[], ['tray']]);
  writeFileSync(f.backend.paths.exe, 'magpie 0.1.1');
  f.backend.versions.clear();
  let running = true;
  f.backend.isRunning = async () => running;
  f.backend.stop = async () => { running = false; };
  f.backend.swap = async () => { throw new Error('fixture swap failure'); };
  f.backend.install(undefined, { startMode: 'tray' });
  assert.equal((await finish(f.backend)).phase, 'failed');
  assert.deepEqual(f.launchArgs, [[], ['tray'], ['tray']], '替换失败后恢复原程序也使用托盘方式');
});

test('web-ensure 仅确保本机 Magpie 网页就绪并返回同源反代入口，不打开外部浏览器；托盘无网页或远程网关明确提示', async (t) => {
  const f = backendFixture(t);
  seed(f.backend);
  const host = fakeHost({ startMode: 'web' });
  let online = false;
  f.backend.web = new MagpieWeb({
    env: {},
    settings: f.backend.paths.settings,
    credentials: () => host.services.credentials,
    openBrowser: () => assert.fail('内嵌准备不应打开外部浏览器'),
    fetchImpl: async () => (online ? ready() : refused()),
    timeoutMs: 200,
    pollMs: 1,
  });
  const baseLaunch = f.backend.launch;
  f.backend.launch = async (...args) => { online = true; return baseLaunch(...args); };

  const manager = new ModelManager(host.ctx, host.own.options.config, { env: {}, backend: f.backend });
  const ensured = await manager.handle({ action: 'web-ensure' });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.ready, true);
  assert.equal(ensured.proxyPath, '/plugins/dsh-magpie/ui/');
  assert.deepEqual(f.launchArgs, [['serve', '--web']]);

  // 托盘模式下没有桌面 web-page.json 时明确提示如何开启。
  host.own.options.config.startMode = 'tray';
  await assert.rejects(manager.handle({ action: 'web-ensure' }), /托盘启动方式.*浏览器访问/);

  // 远程网关不允许走本机内嵌页面。
  host.own.options.config.startMode = 'web';
  host.own.options.config.baseURL = 'https://magpie.example.com';
  await assert.rejects(manager.handle({ action: 'web-ensure' }), /仅支持本机 Magpie/);
});
