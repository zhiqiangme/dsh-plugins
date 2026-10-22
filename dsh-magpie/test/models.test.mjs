import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayURL, KEY_REF, PROVIDER_ID, resolveConfig } from '../lib/config.js';
import { catalogModels, modelEntries, withProvider, syncModels } from '../lib/models.js';
import { fakeHost } from '../fixtures/host.mjs';

const manual = (extra = {}) => resolveConfig({ syncEnabled: true, models: [{ id: 'group/custom', name: '手工名称', input: ['text', 'image'], reasoningEfforts: ['low', 'high'] }], ...extra });

test('默认清单为空且不自动接管；地址与协议严格校验', () => {
  assert.deepEqual(resolveConfig().models, []);
  assert.equal(resolveConfig().syncEnabled, false);
  assert.equal(gatewayURL('http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425');
  assert.equal(gatewayURL('https://relay.example/magpie/v1'), 'https://relay.example/magpie');
  for (const url of ['file:///private', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret']) assert.throws(() => gatewayURL(url));
  assert.throws(() => resolveConfig({ api: 'invalid' }));
  assert.throws(() => manual({ models: [{ id: 'x' }, { id: ' x ' }] }), /重复/);
  assert.throws(() => manual({ models: [{ id: 'x', contextWindow: 10, maxTokens: 10 }] }), /最大输出/);
  assert.throws(() => manual({ models: [{ id: 'x', reasoningEfforts: ['low,high'] }] }), /思考档位/);
});

test('手工模型独立规划：保留完整 ID、排序、图像能力和实际思考档位', () => {
  const config = manual({ models: [{ id: 'provider/b', reasoningEfforts: ['high', 'max'] }, { id: 'group/a', enabled: false }, { id: 'provider/c', input: ['text', 'image'] }] });
  const entries = modelEntries(config);
  assert.deepEqual(entries.map((m) => m.id), ['provider/b', 'provider/c']);
  assert.deepEqual(entries[0].reasoningEfforts, { high: 'high', max: 'max' });
  assert.deepEqual(entries[1].input, ['text', 'image']);
  assert.equal('enabled' in entries[0], false);
  assert.equal('maxTokens' in entries[1], false, '未知限额保持未知');
});

test('Magpie 全量目录保留上游限额、能力和顺序，全部勾选并按规范化 ID 去重', () => {
  const rows = catalogModels({ data: [{ id: 'provider/a', display_name: '真实名称', reasoning: true, context_window: 200000, max_output_tokens: 150000, modalities: { input: ['text', 'image'] }, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { id: ' provider/a ' }, { id: 'group/g', reasoning: true, reasoning_levels: ['high', 'max'] }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, '真实名称');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].maxTokens, 150000);
  assert.deepEqual(rows[0].input, ['text', 'image']);
  assert.deepEqual(rows[0].reasoningEfforts, ['low', 'high']);
  assert.deepEqual(rows[1].reasoningEfforts, ['high', 'max']);
  assert.deepEqual(rows.map((m) => m.id), ['provider/a', 'group/g']);
  assert.ok(rows.every((m) => m.enabled));
  assert.throws(() => catalogModels({ invalid: [] }), /格式无效/);
  assert.throws(() => catalogModels({ data: [{ id: 'valid' }, null] }), /无效条目/);
  assert.throws(() => catalogModels({ data: [{ id: '' }] }), /模型 ID/);
  // 上游输出上限不小于上下文时只省略该项，其余字段照常导入。
  assert.deepEqual(catalogModels({ data: [{ id: 'x', context_window: 10, max_output_tokens: 10 }] })[0].contextWindow, 10);
  assert.equal('maxTokens' in catalogModels({ data: [{ id: 'x', context_window: 10, max_output_tokens: 10 }] })[0], false);
  assert.deepEqual(catalogModels({ data: [] }), []);
});

test('合并只改独立 provider，保留其它分组与自定义选项，移除不适用的默认档位', () => {
  const current = { providers: { magpie: { models: [{ id: 'native' }] }, [PROVIDER_ID]: { apiKeyEnv: KEY_REF, headers: { custom: 'keep' }, reasoning: 'max' } }, extra: 1 };
  const before = structuredClone(current);
  const result = withProvider(current, manual());
  assert.deepEqual(current, before);
  assert.deepEqual(result.config.providers.magpie, current.providers.magpie);
  assert.deepEqual(result.config.providers[PROVIDER_ID].headers, { custom: 'keep' });
  assert.equal(result.config.providers[PROVIDER_ID].reasoning, undefined);
  assert.equal(result.config.providers[PROVIDER_ID].apiKeyEnv, KEY_REF);
  assert.equal(result.config.providers[PROVIDER_ID].baseURL, 'http://127.0.0.1:3425/v1/');
  assert.equal(withProvider(current, manual({ api: 'anthropic-messages' })).config.providers[PROVIDER_ID].baseURL, 'http://127.0.0.1:3425');
  assert.equal(withProvider(current, manual({ api: 'openai-responses' })).config.providers[PROVIDER_ID].api, 'openai-responses');
  assert.throws(() => withProvider({ providers: { [PROVIDER_ID]: { apiKeyEnv: 'USER_KEY' } } }, manual()), /未覆盖/);
});

test('关闭同步或取消全部勾选会移除专属分组，不会反过来同步全部模型', () => {
  const current = withProvider({ providers: { other: { models: [{ id: 'keep' }] } } }, manual()).config;
  for (const config of [manual({ syncEnabled: false }), manual({ models: [] }), manual({ models: [{ id: 'x', enabled: false }] })]) {
    const next = withProvider(current, config).config;
    assert.equal(next.providers[PROVIDER_ID], undefined);
    assert.deepEqual(next.providers.other, current.providers.other);
  }
  assert.equal(withProvider({}, resolveConfig()).changed, false, '初次加载空清单不写配置');
});

test('离线同步手工清单：保存本机标识到凭据库，配置中仅保留引用，重复同步不写', async () => {
  const host = fakeHost();
  const config = manual();
  const result = await syncModels(config, { editor: host.editor, credentials: host.services.credentials, env: {} });
  assert.equal(result.state, 'updated');
  assert.equal(host.keys.get(KEY_REF), 'magpie-dsh');
  assert.equal(JSON.stringify(host.llm.options.config).includes('magpie-dsh'), false);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID].models[0].name, '手工名称');
  assert.equal((await syncModels(config, { editor: host.editor, credentials: host.services.credentials, env: {} })).state, 'unchanged');
  assert.equal(host.edits.length, 1);
  assert.equal(host.llm.options.config.providers[PROVIDER_ID].displayName, 'Magpie');
  // 本机占位标识留在凭据库，但切到远程时不能当作 Key 发出去。
  await assert.rejects(syncModels(manual({ baseURL: 'https://gateway.example' }), { editor: host.editor, credentials: host.services.credentials, env: {} }), /远程/);
});

test('思考档位只接受 llm-pi-ai 支持的级别；目录导入丢弃未知档位', () => {
  assert.throws(() => manual({ models: [{ id: 'x', reasoningEfforts: ['none', 'low'] }] }), /思考档位只能使用/);
  assert.throws(() => manual({ models: [{ id: 'x', reasoningEfforts: ['High'] }] }), /思考档位只能使用/);
  assert.throws(() => manual({ models: [{ id: 'x', reasoningEfforts: ['off'] }] }), /不能只有 off/);
  assert.deepEqual(manual({ models: [{ id: 'x', reasoningEfforts: ['off', 'xhigh'] }] }).models[0].reasoningEfforts, ['off', 'xhigh']);
  const rows = catalogModels({ data: [
    { id: 'codex/a', reasoning: true, supported_reasoning_levels: [{ effort: 'none' }, { effort: 'Low' }, { effort: 'xhigh' }] },
    { id: 'codex/b', reasoning: true, supported_reasoning_levels: ['none', 'off', 'auto'] },
  ] });
  assert.deepEqual(rows[0].reasoningEfforts, ['low', 'xhigh']);
  assert.deepEqual(rows[1].reasoningEfforts, [], '只剩 off 时视为不声明思考');
});

test('锁内合并保留并行添加的其它 provider', async () => {
  const host = fakeHost();
  const edit = host.editor.edit.bind(host.editor);
  host.editor.edit = async (entry, change) => { entry.options.config.providers.newUser = { models: [{ id: 'keep-new' }] }; return edit(entry, change); };
  await syncModels(manual(), { editor: host.editor, credentials: host.services.credentials, env: {} });
  assert.equal(host.llm.options.config.providers.newUser.models[0].id, 'keep-new');
});

test('远程网关缺 Key 或凭据不可写时不生成必然失败的 provider', async () => {
  const host = fakeHost();
  await assert.rejects(syncModels(manual({ baseURL: 'https://gateway.example' }), { editor: host.editor, credentials: host.services.credentials, env: {} }), /远程/);
  host.services.credentials.describe = async () => ({ writable: false });
  await assert.rejects(syncModels(manual(), { editor: host.editor, credentials: host.services.credentials, env: {} }), /不可写/);
  assert.equal(host.edits.length, 0);
  const result = await syncModels(manual(), { editor: host.editor, env: { [KEY_REF]: 'env-secret' } });
  assert.equal(result.state, 'updated');
  assert.equal(host.keys.size, 0);
});
