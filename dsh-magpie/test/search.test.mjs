import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../lib/index.js';
import { ModelManager } from '../lib/runtime.js';
import { SEARCH_PROVIDER_ID } from '../lib/search.js';
import { fakeHost } from '../fixtures/host.mjs';

const result = (text, isError = false) => Response.json({
  jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError },
});

test('Magpie 联网搜索使用已保存的网关、Key 和工具协议，将搜索 API 的文本转为 DSH 网页来源', async () => {
  const host = fakeHost({ baseURL: 'https://gateway.example.test/proxy/v1', syncEnabled: false, autoRoute: false });
  const sent = [];
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend: {}, fetchImpl: async (url, init) => {
    sent.push({ url, init });
    return result('1. 标题 — 副标题 — https://example.test/a?q=%E6%B5%8B%E8%AF%95\r\n摘要第一行\r\n摘要第二行\r\n\r\n2. 重复 — https://example.test/a?q=%E6%B5%8B%E8%AF%95\r\n\r\n3. 另一结果 — https://example.test/b');
  } });
  host.keys.set(host.KEY_REF, 'test-only-gateway-key');
  const search = manager.searchProvider.search.bind(manager.searchProvider);
  assert.equal(manager.searchProvider.available(), true, '模型同步和模型自动路由关闭时也能搜索');
  assert.deepEqual(await search({ query: '  联网搜索  ', maxResults: 1 }), {
    sources: [{ url: 'https://example.test/a?q=%E6%B5%8B%E8%AF%95', title: '标题 — 副标题', snippet: '摘要第一行\r\n摘要第二行' }],
    truncated: true,
  });
  const [{ url, init }] = sent;
  assert.equal(url, 'https://gateway.example.test/proxy/mcp/magpie/web-search');
  assert.equal(init.headers.authorization, 'Bearer test-only-gateway-key');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(init.body), {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: '联网搜索', count: 1 } },
  });
  await search({ query: '以 Magpie 自己的数量为准' });
  assert.deepEqual(JSON.parse(sent.at(-1).init.body).params.arguments, { query: '以 Magpie 自己的数量为准' });
  await assert.rejects(search({ query: '   ' }), /输入搜索关键词/);
  assert.equal(sent.length, 2);
});

test('区分 Magpie 文本回答、空结果、权限和工具错误，透传 DSH 取消信号', async () => {
  const host = fakeHost();
  let respond = () => result('代搜文本和引用');
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend: {}, fetchImpl: (_url, init) => respond(init) });
  const search = (signal) => manager.searchProvider.search({ query: 'fixture' }, signal);
  assert.deepEqual(await search(), { content: '代搜文本和引用', sources: [], truncated: false });
  respond = () => result("magpie couldn't search the web: Tavily found nothing", true);
  assert.deepEqual(await search(), { sources: [], truncated: false });
  respond = () => result('private upstream diagnostics', true);
  await assert.rejects(search(), (error) => /Magpie 搜索失败/.test(error.message) && !error.message.includes('private'));
  respond = () => new Response('permission details', { status: 403 });
  await assert.rejects(search(), /网关 Key 和 MCP 权限/);
  const controller = new AbortController();
  respond = ({ signal }) => {
    controller.abort();
    return Promise.reject(signal.reason);
  };
  await assert.rejects(search(controller.signal), { name: 'AbortError' });
});

test('在 DSH 原生注册 Magpie 搜索，卸载时注销', async () => {
  const config = { syncEnabled: false, autoRoute: false, autoStart: false, autoUpdate: false, dailyModels: false };
  const host = fakeHost(config);
  const providers = new Map();
  host.services.web = {
    listProviders: () => ({ search: [...providers.values()], fetch: [] }),
    registerSearchProvider(provider) {
      providers.set(provider.id, provider);
      return () => providers.delete(provider.id);
    },
  };
  apply(host.ctx, config);
  assert.deepEqual([...providers.keys()], [SEARCH_PROVIDER_ID]);
  assert.equal(providers.get(SEARCH_PROVIDER_ID).title, 'Magpie');
  assert.equal(typeof providers.get(SEARCH_PROVIDER_ID).search, 'function');
  await host.ctx.dispose();
  assert.equal(providers.size, 0);
});

test('选用 Magpie 或恢复部署默认只修改 DSH 搜索提供方，过期的页面选择被拒绝', async () => {
  const host = fakeHost();
  const inherited = { searchProvider: 'deepseek-search-api', fetchProvider: 'http' };
  const entry = { options: { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'dsh-tavily-search', fetchProvider: 'other-fetch' } } };
  const entries = host.editor.entries;
  host.editor.entries = () => [...entries(), entry];
  host.editor.edit = async (target, change) => {
    assert.equal(target, entry);
    entry.options.config = change(entry.options.config, inherited);
  };
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend: {} });
  const select = (enabled, previous) => manager.handle({ action: 'search-select', enabled, previous });
  await assert.rejects(select(true, 'dsh-tavily-search'), /尚未就绪/);
  manager.searchRegistered = true;
  assert.equal((await select(true, 'dsh-tavily-search')).webSearch.provider, SEARCH_PROVIDER_ID);
  assert.equal(entry.options.config.fetchProvider, 'other-fetch');
  await assert.rejects(select(true, 'dsh-tavily-search'), (error) => error.status === 409);
  assert.equal((await select(false, SEARCH_PROVIDER_ID)).webSearch.provider, 'deepseek-search-api');
  assert.equal(entry.options.config.fetchProvider, 'other-fetch');
});

test('添加 Tavily Key 只转交本机 Magpie，不写 DSH 配置或凭据，远程网关不向本机写入', async () => {
  const host = fakeHost();
  const keys = [];
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend: { web: { addTavilyKey: async (key) => { keys.push(key); return true; } } } });
  const add = (key) => manager.handle({ action: 'search-key-add', key });
  assert.deepEqual(await add(' tvly-fixture '), { ok: true, added: true });
  await assert.rejects(add('a,b'), /一个有效的/);
  host.own.options.config.baseURL = 'https://magpie.example.test';
  await assert.rejects(add('tvly-remote'), /对应的 Magpie 实例/);
  assert.deepEqual(keys, ['tvly-fixture']);
  assert.equal(host.keys.size, 0);
  assert.deepEqual(host.edits, []);
});
