/**
 * 模型列表同步测试：命名/筛选/渲染/定位是纯函数；拉取与回写用真 HTTP 假服务跑通。
 *
 * 写入走宿主 configEditor（这里用 fixtures/fake-config-editor.mjs 替身），重点覆盖：
 * 只动目标 provider、provider 丢失时补建、空列表/请求失败不写、编辑失败如实报错；
 * 以及同步后在凭据库里补齐 provider 引用的网关密钥（用户已设的不覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../lib/config.js';
import {
  PLACEHOLDER_PROXY_KEY,
  creditsLabel,
  ensureProxyCredential,
  fetchModels,
  findConfigEntry,
  modelDisplayName,
  modelsEndpoint,
  planModelEntries,
  providerBaseURL,
  providerKeyRef,
  readPluginModelsConfig,
  renderModelsBlock,
  resolveProfilePatchPath,
  scopedSelection,
  selectModels,
  selectionKey,
  syncModels,
  withProviderModels,
  yamlScalar,
} from '../lib/models.js';
import {
  createFakeConfigEditor,
  createFakeCredentials,
  llmPiAiConfig,
  profileRows,
} from '../fixtures/fake-config-editor.mjs';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));

const SAMPLE = [
  {
    id: 'cn:alpha',
    name: 'Alpha',
    credits: 'x0.11',
    context_length: 1000000,
    max_output_tokens: 393216,
    supports_images: true,
    supports_reasoning: true,
    reasoning_supported_efforts: ['low', 'high', 'max'],
  },
  {
    id: 'global:beta',
    name: 'Beta',
    credits: 'x0.00',
    context_length: 200000,
    max_output_tokens: 64000,
    supports_images: false,
    supports_reasoning: true,
    reasoning_supported_efforts: ['high'],
  },
];

/** 起一个假后端；返回 { ready: Promise<port>, stop }。端口由子进程打印，避免抢占竞态。 */
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

/** 用插件真实的配置解析拼出 spec + models，避免测试里手搓配置结构。 */
function configFor(port, models = {}) {
  return resolvePluginConfig(
    { port, models: { enabled: true, apiKey: 'test-key', timeoutMs: 5_000, ...models } },
    { PATH: '' },
  );
}

/** 取出 fake editor 里 llm-pi-ai 当前的 provider 配置。 */
const providersOf = (editor) => editor.entry('llm-pi-ai').options.config.providers;

test('倍率标签：x0.11 → 0.11，0 / 缺失 → Free', () => {
  assert.equal(creditsLabel('x0.11'), '0.11');
  assert.equal(creditsLabel('x1.62'), '1.62');
  assert.equal(creditsLabel('x0.00'), 'Free');
  assert.equal(creditsLabel('x0'), 'Free');
  assert.equal(creditsLabel(''), 'Free');
  assert.equal(creditsLabel(undefined), 'Free');
  assert.equal(creditsLabel('0.07'), '0.07');
  assert.equal(creditsLabel('Free'), 'Free');
});

test('展示名：模型名 + CN / GL + 倍率，且不重复追加同款倍率', () => {
  assert.equal(modelDisplayName({ id: 'cn:deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11' }), 'Deepseek-V4.1-Flash CN 0.11');
  assert.equal(modelDisplayName({ id: 'global:hy4-preview-f', name: 'Hy4 preview', credits: 'x0.00' }), 'Hy4 preview GL Free');
  assert.equal(modelDisplayName({ id: 'cn:hy4-preview-f', name: 'Hy4 preview Free' }), 'Hy4 preview CN Free');
  // 没有域前缀的 id：不加区域标签，但仍补倍率。
  assert.equal(modelDisplayName({ id: 'other:thing', name: 'Thing', credits: 'x0.05' }), 'Thing 0.05');
});

test('条目规划：白名单按给定顺序、上游顺序兜底、排除生效', () => {
  const all = planModelEntries(SAMPLE, {});
  assert.deepEqual(all.map((e) => e.id), ['cn:alpha', 'global:beta']);
  assert.deepEqual(all[0], {
    id: 'cn:alpha',
    name: 'Alpha CN 0.11',
    contextWindow: 1000000,
    maxTokens: 393216,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  });
  assert.deepEqual(all[1].input, ['text'], '不支持图片的模型只声明 text');

  // 白名单决定顺序，也让后端新增的模型不会自己冒出来。
  const picked = planModelEntries(SAMPLE, { only: ['global:beta', 'cn:alpha', 'cn:missing'] });
  assert.deepEqual(picked.map((e) => e.id), ['global:beta', 'cn:alpha']);

  const excluded = planModelEntries(SAMPLE, { exclude: ['cn:alpha'] });
  assert.deepEqual(excluded.map((e) => e.id), ['global:beta']);
});

test('hub 白名单按出口分开记：cn:/global: 键只对当前出口生效，当前出口没勾过任何模型时按全部算', () => {
  const cn = [{ id: 'deepseek-v4.1-flash', realm: 'cn' }, { id: 'minimax-m3', realm: 'cn' }, { id: 'glm-5.3', realm: 'cn' }];
  const intl = [{ id: 'deepseek-v4.1-flash', realm: 'intl' }, { id: 'gpt-5.5', realm: 'intl' }];
  assert.equal(selectionKey(cn[1]), 'cn:minimax-m3');
  assert.equal(selectionKey(intl[1]), 'global:gpt-5.5', 'hub 的 intl 对应 wb2api 的 global: 前缀');
  assert.equal(selectionKey({ id: 'cn:alpha' }), 'cn:alpha', 'wb2api 的 id 本身就是键');

  const only = ['global:gpt-5.5', 'cn:minimax-m3', 'cn:deepseek-v4.1-flash'];
  const ids = (models, list) => selectModels(models, list).map((model) => model.id);
  assert.deepEqual(ids(cn, only), ['minimax-m3', 'deepseek-v4.1-flash'], '按白名单顺序，只取 cn: 那一组');
  assert.deepEqual(ids(intl, only), ['gpt-5.5']);
  assert.deepEqual(ids(intl, ['cn:minimax-m3']), ['deepseek-v4.1-flash', 'gpt-5.5'], '国际出口从没勾过 → 全部');
  assert.deepEqual(ids(cn, ['deepseek-v4.1-flash', 'cn:deepseek-v4.1-flash']), ['deepseek-v4.1-flash'], '老的裸 id 两个出口都生效，同一模型只取一次');
  assert.deepEqual(ids(cn, ['global:gpt-5.5', 'cn:not-listed']), [], '当前出口勾过、只是都暂时不在 → 不当成"全部"');

  // 写进 DSH 的仍是 hub 认的裸 id，展示名带当前出口；排除也认带前缀的键。
  const entries = planModelEntries(cn, { only, exclude: ['cn:deepseek-v4.1-flash'] });
  assert.deepEqual(entries.map((entry) => entry.id), ['minimax-m3']);
  assert.match(entries[0].name, / CN Free$/);
});

test('wb2api 某个出口暂时缺席时，不把那个出口的勾选当成"没勾过"', () => {
  // CN 拉取失败、只剩 global：白名单只勾了 CN，结果应为空（同步跳过、保持现状），而不是换成 GL 的全部模型。
  assert.deepEqual(selectModels([{ id: 'global:beta' }], ['cn:alpha']), []);
  assert.deepEqual(selectModels([{ id: 'global:beta' }], []).map((model) => model.id), ['global:beta']);
});

test('scopedSelection：hub 下把老的裸 id 展开成两个出口各一条，wb2api 原样', () => {
  assert.deepEqual(scopedSelection(['flash', 'cn:mini', 'cn:flash'], 'hub'), ['cn:flash', 'global:flash', 'cn:mini']);
  assert.deepEqual(scopedSelection(['flash', 'cn:mini'], 'wb2api'), ['flash', 'cn:mini']);
  assert.deepEqual(scopedSelection([], 'hub'), []);
});

test('思考档位：默认低/高/最大三档，auto 时按上游声明，不支持思考则不给档位', () => {
  assert.deepEqual(Object.keys(planModelEntries(SAMPLE, {})[0].reasoningEfforts), ['low', 'high', 'max']);
  assert.deepEqual(Object.keys(planModelEntries(SAMPLE, { efforts: 'auto' })[0].reasoningEfforts), ['low', 'high', 'max']);
  assert.deepEqual(Object.keys(planModelEntries(SAMPLE, { efforts: 'auto' })[1].reasoningEfforts), ['high']);

  const noReasoning = planModelEntries([{ id: 'cn:x', name: 'X', supports_reasoning: false }], {});
  assert.equal(noReasoning[0].reasoningEfforts, undefined);
});

test('YAML 标量：只有不安全时才加引号', () => {
  assert.equal(yamlScalar('cn:deepseek-v4.1-flash'), 'cn:deepseek-v4.1-flash');
  assert.equal(yamlScalar('Deepseek-V4.1-Flash CN 0.11'), 'Deepseek-V4.1-Flash CN 0.11');
  assert.equal(yamlScalar('a: b'), "'a: b'");
  assert.equal(yamlScalar('x #y'), "'x #y'");
  assert.equal(yamlScalar(''), "''");
});

test('渲染：缩进与手写文件一致', () => {
  const lines = renderModelsBlock(planModelEntries(SAMPLE, {}), 10);
  assert.deepEqual(lines.slice(0, 8), [
    '          - id: cn:alpha',
    '            name: Alpha CN 0.11',
    '            contextWindow: 1000000',
    '            maxTokens: 393216',
    '            input:',
    '              - text',
    '              - image',
    '            reasoningEfforts:',
  ]);
});

test('provider baseURL：统一成带 /v1/ 的形式', () => {
  assert.equal(providerBaseURL('http://127.0.0.1:7863'), 'http://127.0.0.1:7863/v1/');
  assert.equal(providerBaseURL('http://127.0.0.1:7863/v1'), 'http://127.0.0.1:7863/v1/');
  assert.equal(providerBaseURL(''), undefined);
});

test('接口地址归一：裸主机、/v1、带尾斜杠都能拼出 /v1/models', () => {
  assert.equal(modelsEndpoint('http://127.0.0.1:7863'), 'http://127.0.0.1:7863/v1/models');
  assert.equal(modelsEndpoint('http://127.0.0.1:7863/v1/'), 'http://127.0.0.1:7863/v1/models');
  assert.equal(modelsEndpoint('http://127.0.0.1:7863/v1'), 'http://127.0.0.1:7863/v1/models');
  assert.equal(modelsEndpoint(''), undefined);
});

test('目标配置路径：显式配置 > DSH_PROFILE_DIR > DSH_HOME + DSH_PROFILE', () => {
  assert.equal(resolveProfilePatchPath({}, 'C:\\x\\cordis.patch.yml'), 'C:\\x\\cordis.patch.yml');
  assert.equal(
    resolveProfilePatchPath({ DSH_PROFILE_DIR: 'C:\\p\\desktop' }, ''),
    join('C:\\p\\desktop', 'cordis.patch.yml'),
  );
  assert.equal(
    resolveProfilePatchPath({ DSH_HOME: 'C:\\h', DSH_PROFILE: 'desktop' }, ''),
    join('C:\\h', 'profiles', 'desktop', 'cordis.patch.yml'),
  );
  assert.equal(resolveProfilePatchPath({}, ''), undefined);
});

test('fetchModels：真 HTTP 拉取、Bearer 鉴权、错误与空列表', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'secret' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const baseURL = `http://127.0.0.1:${port}`;

  const ok = await fetchModels({ baseURL, apiKey: 'secret', timeoutMs: 5_000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models.map((m) => m.id), ['cn:alpha', 'global:beta']);

  const unauthorized = await fetchModels({ baseURL, apiKey: 'wrong', timeoutMs: 5_000 });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.reason, /401/);

  const empty = startFixture({ TEST_MODE: 'http-empty' });
  t.after(empty.stop);
  const emptyResult = await fetchModels({ baseURL: `http://127.0.0.1:${await empty.ready}`, timeoutMs: 5_000 });
  assert.equal(emptyResult.ok, true);
  assert.equal(emptyResult.models.length, 0);

  const broken = startFixture({ TEST_MODE: 'http-error' });
  t.after(broken.stop);
  const errorResult = await fetchModels({ baseURL: `http://127.0.0.1:${await broken.ready}`, timeoutMs: 5_000 });
  assert.equal(errorResult.ok, false);
  assert.match(errorResult.reason, /500/);
});

test('读取 profile 里本插件的 models 配置（手动同步与自动同步同一份来源）', () => {
  const text = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
- id: dsh-autostart-workbuddy
  name: dsh-autostart-workbuddy
  config:
    models:
      enabled: true
      efforts: auto
      timeoutMs: 15000
      only:
        - cn:a
        - global:b
      exclude:
        - cn:c
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    models:
      enabled: true
`;
  assert.deepEqual(readPluginModelsConfig(text, 'dsh-autostart-workbuddy'), {
    enabled: true,
    efforts: 'auto',
    timeoutMs: 15000,
    only: ['cn:a', 'global:b'],
    exclude: ['cn:c'],
  });

  // 前面那个 entry 的 models 不能被误读成自己的。
  assert.equal(readPluginModelsConfig(text, 'llm-pi-ai'), undefined);
  assert.equal(readPluginModelsConfig(text, 'nope'), undefined);

  // 本 entry 没有 models 时，绝不能顺走下一个 entry 的 models。
  assert.equal(
    readPluginModelsConfig(
      `- id: dsh-autostart-workbuddy
  name: x
  config:
    port: 7999
- id: other
  config:
    models:
      enabled: true
`,
      'dsh-autostart-workbuddy',
    ),
    undefined,
  );
});


test('读取 only: [] 得到空数组，而不是字符串 "[]"', () => {
  const text = `- id: dsh-autostart-workbuddy
  name: dsh-autostart-workbuddy
  config:
    models:
      enabled: true
      only: []
`;
  assert.deepEqual(readPluginModelsConfig(text).only, []);
});

const SKELETON = {
  displayName: 'WorkBuddy',
  apiKeyEnv: 'WORKBUDDY_PROXY_KEY',
  baseURL: 'http://127.0.0.1:7863/v1/',
  api: 'openai-completions',
  reasoning: 'max',
};

test('withProviderModels：只换目标 provider 的 models，其余字段与 provider 原样保留', () => {
  const entries = planModelEntries(SAMPLE, {});
  const before = llmPiAiConfig();
  const result = withProviderModels(before, 'workbuddy', entries, SKELETON);

  assert.equal(result.changed, true);
  assert.equal(result.created, false);
  assert.deepEqual(result.config.providers.workbuddy.models, entries);
  assert.equal(result.config.providers.workbuddy.apiKeyEnv, 'WORKBUDDY_PROXY_KEY');
  assert.deepEqual(result.config.providers.openrouter, before.providers.openrouter);
  assert.equal(before.providers.workbuddy.models[0].id, 'cn:stale', '不能就地改调用方传进来的对象');

  const again = withProviderModels(result.config, 'workbuddy', entries, SKELETON);
  assert.equal(again.changed, false);
});

test('withProviderModels：provider 整段丢失时按骨架补建', () => {
  const entries = planModelEntries(SAMPLE, {});
  const result = withProviderModels(llmPiAiConfig({ withWorkbuddy: false }), 'workbuddy', entries, SKELETON);
  assert.equal(result.changed, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.config.providers.workbuddy, { ...SKELETON, models: entries });
  assert.ok(result.config.providers.openrouter, '别的 provider 不能丢');

  // 连 providers 都没有也能补。
  assert.deepEqual(withProviderModels(undefined, 'workbuddy', entries, SKELETON).config, {
    providers: { workbuddy: { ...SKELETON, models: entries } },
  });
});

test('findConfigEntry：按 id 或包名找可编辑条目', () => {
  const editor = createFakeConfigEditor(profileRows());
  assert.equal(findConfigEntry(editor, { id: 'dsh-autostart-workbuddy' })?.options.id, 'dsh-autostart-workbuddy');
  assert.equal(findConfigEntry(editor, { name: '@deepseek-ai/dsh-llm-pi-ai' })?.options.id, 'llm-pi-ai');
  assert.equal(findConfigEntry(editor, { id: 'nope' }), undefined);
  assert.equal(findConfigEntry(undefined, { id: 'llm-pi-ai' }), undefined);
});

test('syncModels：经 configEditor 写进 llm-pi-ai，第二次运行判定为无变化', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const resolved = configFor(await fixture.ready);
  const editor = createFakeConfigEditor(profileRows());

  const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, env: { PATH: '' } });
  assert.equal(result.state, 'updated');
  assert.equal(result.entries.length, 2);
  assert.equal(result.documentPath, editor.documentPath);
  assert.deepEqual(editor.edits.map((edit) => edit.id), ['llm-pi-ai'], '只编辑 llm-pi-ai 那一行');
  assert.deepEqual(
    providersOf(editor).workbuddy.models.map((model) => model.name),
    ['Alpha CN 0.11', 'Beta GL Free'],
  );
  assert.ok(providersOf(editor).openrouter, '别的 provider 不能被动');

  const again = await syncModels({ spec: resolved.spec, models: resolved.models, editor, env: { PATH: '' } });
  assert.equal(again.state, 'unchanged');
  assert.equal(editor.edits.length, 1, '无变化时不该再写');
});

test('syncModels：白名单决定写入哪些模型与顺序；provider 丢失时补建', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const resolved = configFor(await fixture.ready, { only: ['global:beta'] });
  const editor = createFakeConfigEditor(profileRows({ withWorkbuddy: false }));

  const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, env: { PATH: '' } });
  assert.equal(result.state, 'updated');
  assert.equal(result.created, true);
  const workbuddy = providersOf(editor).workbuddy;
  assert.deepEqual(workbuddy.models.map((model) => model.id), ['global:beta']);
  assert.equal(workbuddy.baseURL, `http://127.0.0.1:${resolved.spec.port}/v1/`);
  assert.equal(workbuddy.apiKeyEnv, 'WORKBUDDY_PROXY_KEY');
});

test('syncModels：空列表 / 请求失败 / 没有 editor / 没有 llm-pi-ai / 编辑失败都不写', async (t) => {
  const emptyFixture = startFixture({ TEST_MODE: 'http-empty' });
  t.after(emptyFixture.stop);
  const emptyResolved = configFor(await emptyFixture.ready);
  const editor = createFakeConfigEditor(profileRows());
  const skippedEmpty = await syncModels({ spec: emptyResolved.spec, models: emptyResolved.models, editor });
  assert.equal(skippedEmpty.state, 'skipped');
  assert.match(skippedEmpty.reason, /空模型列表/);

  const errorFixture = startFixture({ TEST_MODE: 'http-error' });
  t.after(errorFixture.stop);
  const errorResolved = configFor(await errorFixture.ready);
  const failed = await syncModels({ spec: errorResolved.spec, models: errorResolved.models, editor });
  assert.equal(failed.state, 'failed');
  assert.equal(editor.edits.length, 0, '空列表与请求失败都不能动配置');

  const modelsFixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(modelsFixture.stop);
  const resolved = configFor(await modelsFixture.ready);

  const noEditor = await syncModels({ spec: resolved.spec, models: resolved.models, editor: undefined });
  assert.equal(noEditor.state, 'skipped');
  assert.match(noEditor.reason, /configEditor/);

  const noTarget = await syncModels({
    spec: resolved.spec,
    models: resolved.models,
    editor: createFakeConfigEditor(profileRows().slice(1)),
  });
  assert.equal(noTarget.state, 'skipped');
  assert.match(noTarget.reason, /llm-pi-ai/);

  editor.failWith = new Error('Configuration for "llm-pi-ai" is overridden by a home patch');
  const rejected = await syncModels({ spec: resolved.spec, models: resolved.models, editor });
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.reason, /overridden/);
});

test('syncModels：dry-run 只算不写；未开启时直接跳过', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const editor = createFakeConfigEditor(profileRows());
  const resolved = configFor(port);

  const plan = await syncModels({ spec: resolved.spec, models: resolved.models, editor, dryRun: true });
  assert.equal(plan.state, 'dry-run');
  assert.equal(editor.edits.length, 0);

  const off = configFor(port, { enabled: false });
  assert.deepEqual(await syncModels({ spec: off.spec, models: off.models, editor }), { state: 'disabled' });
});

test('providerKeyRef：取 provider 的 apiKeyEnv，缺失或不合法时为 undefined', () => {
  assert.equal(providerKeyRef(llmPiAiConfig(), 'workbuddy'), 'WORKBUDDY_PROXY_KEY');
  assert.equal(providerKeyRef(llmPiAiConfig({ withWorkbuddy: false }), 'workbuddy'), undefined);
  assert.equal(providerKeyRef({ providers: { workbuddy: { apiKeyEnv: 'bad-name' } } }, 'workbuddy'), undefined);
  assert.equal(providerKeyRef(undefined, 'workbuddy'), undefined);
});

test('ensureProxyCredential：缺失时写入网关密钥，api_key 为空写占位值', async () => {
  const credentials = createFakeCredentials();
  assert.deepEqual(
    await ensureProxyCredential({ credentials, ref: 'WORKBUDDY_PROXY_KEY', apiKey: 'sk-gw' }),
    { state: 'created', ref: 'WORKBUDDY_PROXY_KEY', placeholder: false },
  );
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'sk-gw');

  const noAuth = createFakeCredentials();
  const result = await ensureProxyCredential({ credentials: noAuth, ref: 'WORKBUDDY_PROXY_KEY', apiKey: '' });
  assert.equal(result.state, 'created');
  assert.equal(result.placeholder, true);
  assert.equal(noAuth.values.WORKBUDDY_PROXY_KEY, PLACEHOLDER_PROXY_KEY, '凭据库拒存空串，只能写占位值');
});

test('ensureProxyCredential：用户已设（凭据库或启动环境）的值一律不覆盖', async () => {
  const stored = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'user-key' } });
  const keptStored = await ensureProxyCredential({ credentials: stored, ref: 'WORKBUDDY_PROXY_KEY', apiKey: 'sk-gw' });
  assert.equal(keptStored.state, 'kept');
  assert.equal(stored.values.WORKBUDDY_PROXY_KEY, 'user-key');
  assert.equal(stored.sets.length, 0);

  const fromEnv = createFakeCredentials({ env: { WORKBUDDY_PROXY_KEY: 'env-key' } });
  const keptEnv = await ensureProxyCredential({ credentials: fromEnv, ref: 'WORKBUDDY_PROXY_KEY', apiKey: '' });
  assert.equal(keptEnv.state, 'kept');
  assert.equal(fromEnv.sets.length, 0);
});

test('ensureProxyCredential：占位值在网关设了密钥后换成真密钥，否则保持', async () => {
  const credentials = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: PLACEHOLDER_PROXY_KEY } });
  assert.equal((await ensureProxyCredential({ credentials, ref: 'WORKBUDDY_PROXY_KEY', apiKey: '' })).state, 'kept');
  assert.equal(credentials.sets.length, 0, '仍不鉴权时不必重写');

  const replaced = await ensureProxyCredential({ credentials, ref: 'WORKBUDDY_PROXY_KEY', apiKey: 'sk-gw' });
  assert.equal(replaced.state, 'replaced');
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'sk-gw');
});

test('ensureProxyCredential：没有服务 / 没有引用跳过，写入失败如实报告', async () => {
  assert.equal((await ensureProxyCredential({ credentials: undefined, ref: 'WORKBUDDY_PROXY_KEY' })).state, 'skipped');
  assert.equal((await ensureProxyCredential({ credentials: createFakeCredentials(), ref: undefined })).state, 'skipped');

  const broken = createFakeCredentials();
  broken.failWith = new Error('disk full');
  const failed = await ensureProxyCredential({ credentials: broken, ref: 'WORKBUDDY_PROXY_KEY', apiKey: 'sk-gw' });
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /disk full/);
});

test('syncModels：补建 provider 后把拉模型用的密钥写进凭据库，再次同步不重复写', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const resolved = configFor(await fixture.ready);
  const editor = createFakeConfigEditor(profileRows({ withWorkbuddy: false }));
  const credentials = createFakeCredentials();

  const result = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: { PATH: '' } });
  assert.equal(result.state, 'updated');
  assert.equal(result.created, true);
  assert.deepEqual(result.credential, { state: 'created', ref: 'WORKBUDDY_PROXY_KEY', placeholder: false });
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'test-key');

  const again = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: { PATH: '' } });
  assert.equal(again.state, 'unchanged');
  assert.equal(again.credential.state, 'kept');
  assert.equal(credentials.sets.length, 1);
});

test('syncModels：模型无变化时也补密钥（来自 config.json），用户已设的不覆盖', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'panel-key' });
  t.after(fixture.stop);
  const dir = mkdtempSync(join(tmpdir(), 'wb-cred-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const panelConfig = join(dir, 'config.json');
  writeFileSync(panelConfig, JSON.stringify({ api_key: 'panel-key' }));
  const resolved = configFor(await fixture.ready, { apiKey: '', panelConfig });

  // 先把模型同步到最新，模拟“已同步过、只缺密钥”的机器。
  const editor = createFakeConfigEditor(profileRows());
  await syncModels({ spec: resolved.spec, models: resolved.models, editor, env: { PATH: '' } });
  assert.equal(editor.edits.length, 1);

  const credentials = createFakeCredentials();
  const unchanged = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env: { PATH: '' } });
  assert.equal(unchanged.state, 'unchanged');
  assert.equal(unchanged.credential.state, 'created');
  assert.equal(credentials.values.WORKBUDDY_PROXY_KEY, 'panel-key');

  const userSet = createFakeCredentials({ stored: { WORKBUDDY_PROXY_KEY: 'user-key' } });
  const kept = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials: userSet, env: { PATH: '' } });
  assert.equal(kept.credential.state, 'kept');
  assert.equal(userSet.values.WORKBUDDY_PROXY_KEY, 'user-key');
});

test('syncModels：dry-run 与写配置失败都不碰凭据库', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const resolved = configFor(await fixture.ready);
  const credentials = createFakeCredentials();

  const plan = await syncModels({
    spec: resolved.spec, models: resolved.models, editor: createFakeConfigEditor(profileRows()), credentials, dryRun: true,
  });
  assert.equal(plan.state, 'dry-run');

  const editor = createFakeConfigEditor(profileRows());
  editor.failWith = new Error('validation failed');
  const failed = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials });
  assert.equal(failed.state, 'failed');
  assert.equal(credentials.sets.length, 0);
});
