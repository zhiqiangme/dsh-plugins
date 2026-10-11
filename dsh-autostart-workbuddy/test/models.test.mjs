/**
 * 模型列表同步测试：命名/筛选/渲染/定位是纯函数；拉取与回写用真 HTTP 假服务跑通。
 *
 * 回写是"改用户 profile"的动作，所以这里覆盖得比其它模块更细：
 * 只动 models 段、认不出结构就不写、空列表不清空、备份有上限。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginConfig } from '../lib/config.js';
import {
  creditsLabel,
  fetchModels,
  locateModelsBlock,
  modelDisplayName,
  modelsEndpoint,
  planModelEntries,
  providerBaseURL,
  readPluginModelsConfig,
  renderModelsBlock,
  resolveProfilePatchPath,
  syncModels,
  updatePatchText,
  yamlScalar,
} from '../lib/models.js';
import { isFile } from '../lib/services.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/dummy-server.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与真实 profile 同构的最小 patch：providers 缩进 4、provider 6、models 8、条目 10。 */
const PATCH_FIXTURE = `# 测试用 profile patch（结构与真实文件一致）
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter:
        displayName: OpenRouter
        models:
          - id: anthropic/claude-opus-5.5
            name: Claude Opus 5.5
      workbuddy:
        displayName: WorkBuddy
        apiKeyEnv: WORKBUDDY_PROXY_KEY
        baseURL: http://127.0.0.1:7863/v1/
        api: openai-completions
        models:
          - id: cn:stale
            name: 过期条目
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`;

const SAMPLE_NO_MODELS_PATCH = `# 测试用 profile patch（workbuddy provider 下没有 models 段）
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        baseURL: http://127.0.0.1:7863/v1/
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`;

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

function tempPatch(text = PATCH_FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'autostart-models-'));
  const path = join(dir, 'cordis.patch.yml');
  writeFileSync(path, text, 'utf8');
  return { dir, path };
}

/** 用插件真实的配置解析拼出 spec + models，避免测试里手搓配置结构。 */
function configFor(port, patchPath, models = {}) {
  return resolvePluginConfig(
    {
      port,
      models: { enabled: true, profilePatch: patchPath, apiKey: 'test-key', timeoutMs: 5_000, ...models },
    },
    { PATH: '' },
  );
}

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

test('展示名：CN / GL 前缀 + 倍率后缀，且不重复追加同款后缀', () => {
  assert.equal(modelDisplayName({ id: 'cn:deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11' }), 'CN Deepseek-V4.1-Flash 0.11');
  assert.equal(modelDisplayName({ id: 'global:hy4-preview-f', name: 'Hy4 preview', credits: 'x0.00' }), 'GL Hy4 preview Free');
  assert.equal(modelDisplayName({ id: 'cn:hy4-preview-f', name: 'Hy4 preview Free' }), 'CN Hy4 preview Free');
  // 没有域前缀的 id：不加前缀，但仍补倍率。
  assert.equal(modelDisplayName({ id: 'other:thing', name: 'Thing', credits: 'x0.05' }), 'Thing 0.05');
});

test('条目规划：白名单按给定顺序、上游顺序兜底、排除生效', () => {
  const all = planModelEntries(SAMPLE, {});
  assert.deepEqual(all.map((e) => e.id), ['cn:alpha', 'global:beta']);
  assert.deepEqual(all[0], {
    id: 'cn:alpha',
    name: 'CN Alpha 0.11',
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

test('思考档位：默认低/高/最大三档，auto 时按上游声明，不支持思考则不给档位', () => {
  assert.deepEqual(Object.keys(planModelEntries(SAMPLE, {})[0].reasoningEfforts), ['low', 'high', 'max']);
  assert.deepEqual(Object.keys(planModelEntries(SAMPLE, { efforts: 'auto' })[0].reasoningEfforts), ['low', 'high', 'max']);
  assert.deepEqual(Object.keys(planModelEntries(SAMPLE, { efforts: 'auto' })[1].reasoningEfforts), ['high']);

  const noReasoning = planModelEntries([{ id: 'cn:x', name: 'X', supports_reasoning: false }], {});
  assert.equal(noReasoning[0].reasoningEfforts, undefined);
});

test('YAML 标量：只有不安全时才加引号', () => {
  assert.equal(yamlScalar('cn:deepseek-v4.1-flash'), 'cn:deepseek-v4.1-flash');
  assert.equal(yamlScalar('CN Deepseek-V4.1-Flash 0.11'), 'CN Deepseek-V4.1-Flash 0.11');
  assert.equal(yamlScalar('a: b'), "'a: b'");
  assert.equal(yamlScalar('x #y'), "'x #y'");
  assert.equal(yamlScalar(''), "''");
});

test('渲染：缩进与手写文件一致', () => {
  const lines = renderModelsBlock(planModelEntries(SAMPLE, {}), 10);
  assert.deepEqual(lines.slice(0, 8), [
    '          - id: cn:alpha',
    '            name: CN Alpha 0.11',
    '            contextWindow: 1000000',
    '            maxTokens: 393216',
    '            input:',
    '              - text',
    '              - image',
    '            reasoningEfforts:',
  ]);
});

test('定位 models 段：只认 workbuddy，且不误伤 openrouter', () => {
  const lines = PATCH_FIXTURE.split('\n');
  const located = locateModelsBlock(lines, 'workbuddy');
  assert.equal(located.ok, true);
  assert.equal(lines[located.modelsIndex].trim(), 'models:');
  assert.equal(located.itemIndent, 10);
  // 定位到的必须是 workbuddy 自己那一段（cn:stale 是它的过期条目）。
  assert.equal(lines[located.modelsIndex + 1].trim(), '- id: cn:stale');

  assert.equal(locateModelsBlock(PATCH_FIXTURE.split('\n'), 'nope').ok, false);
  assert.equal(locateModelsBlock(['- id: a'], 'workbuddy').ok, false);
});

test('回写：只替换 models 段，其余逐字节保留，且可识别"无变化"', () => {
  const entries = planModelEntries(SAMPLE, {});
  const first = updatePatchText(PATCH_FIXTURE, entries, 'workbuddy');
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.ok(first.text.includes('          - id: cn:alpha'));
  assert.ok(first.text.includes('            name: GL Beta Free'));
  assert.ok(!first.text.includes('cn:stale'));
  // 其它 provider、其它条目、注释、结尾换行都不能动。
  assert.ok(first.text.includes('          - id: anthropic/claude-opus-5.5'));
  assert.ok(first.text.includes('- id: locale'));
  assert.ok(first.text.startsWith('# 测试用 profile patch'));
  assert.ok(first.text.endsWith('    preference: zh\n'));

  const second = updatePatchText(first.text, entries, 'workbuddy');
  assert.equal(second.changed, false);

  const crlf = updatePatchText(PATCH_FIXTURE.replace(/\n/g, '\r\n'), entries, 'workbuddy');
  assert.equal(crlf.ok, true);
  assert.ok(crlf.text.includes('\r\n'), 'CRLF 文件必须保持 CRLF');
});

test('回写：provider 下没有 models 段时拒绝写入', () => {
  const result = updatePatchText(SAMPLE_NO_MODELS_PATCH, planModelEntries(SAMPLE, {}), 'workbuddy');
  assert.equal(result.ok, false);
  assert.match(result.reason, /models/);
});

/** workbuddy provider 整段丢失的 profile；另一个条目也有 providers:，用来确认不会补错地方。 */
const SAMPLE_NO_PROVIDER_PATCH = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter:
        displayName: OpenRouter
        models:
          - id: anthropic/claude-opus-5.5
            name: Claude Opus 5.5
        baseURL: https://openrouter.ai/api/v1/

- id: dsh-connect-trae
  name: dsh-connect-trae
  config:
    providers:
      cn:
        enabled: true
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`;

const PROVIDER_SKELETON = {
  displayName: 'WorkBuddy',
  apiKeyEnv: 'WORKBUDDY_PROXY_KEY',
  baseURL: 'http://127.0.0.1:7863/v1/',
};

test('回写：provider 整段丢失时在 llm-pi-ai 的 providers 末尾补建', () => {
  const entries = planModelEntries(SAMPLE, {});
  const result = updatePatchText(SAMPLE_NO_PROVIDER_PATCH, entries, 'workbuddy', PROVIDER_SKELETON);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.created, true);

  const lines = result.text.split('\n');
  const at = lines.indexOf('      workbuddy:');
  assert.ok(at > 0, result.text);
  // 必须落在 llm-pi-ai 条目里（openrouter 之后、dsh-connect-trae 之前），且空行留在补建段之后。
  assert.ok(at > lines.indexOf('        baseURL: https://openrouter.ai/api/v1/'));
  assert.ok(at < lines.indexOf('- id: dsh-connect-trae'));
  assert.deepEqual(lines.slice(at + 1, at + 7), [
    '        displayName: WorkBuddy',
    '        apiKeyEnv: WORKBUDDY_PROXY_KEY',
    '        baseURL: http://127.0.0.1:7863/v1/',
    '        api: openai-completions',
    '        reasoning: max',
    '        models:',
  ]);
  assert.equal(lines[at + 7], '          - id: cn:alpha');
  assert.equal(result.text.match(/workbuddy:/g).length, 1, '只补建一次');

  // 补建后再同步就走普通替换路径，结果稳定。
  const again = updatePatchText(result.text, entries, 'workbuddy', PROVIDER_SKELETON);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('回写：没传补建骨架时，provider 丢失仍拒绝写入', () => {
  const result = updatePatchText(SAMPLE_NO_PROVIDER_PATCH, planModelEntries(SAMPLE, {}), 'workbuddy');
  assert.equal(result.ok, false);
  assert.match(result.reason, /workbuddy/);
});

test('回写：profile 里没有 llm-pi-ai 条目时不补建', () => {
  const text = SAMPLE_NO_PROVIDER_PATCH.replace('"@deepseek-ai/dsh-llm-pi-ai"', 'something-else');
  const result = updatePatchText(text, planModelEntries(SAMPLE, {}), 'workbuddy', PROVIDER_SKELETON);
  assert.equal(result.ok, false);
  assert.match(result.reason, /llm-pi-ai/);
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

test('syncModels：写入 profile，留备份，第二次运行判定为无变化', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const { path } = tempPatch();
  const resolved = configFor(port, path);

  const result = await syncModels({ spec: resolved.spec, models: resolved.models, env: { PATH: '' } });
  assert.equal(result.state, 'updated');
  assert.equal(result.entries.length, 2);
  assert.ok(isFile(result.backup), '改配置前必须留备份');

  const after = readFileSync(path, 'utf8');
  assert.ok(after.includes('            name: CN Alpha 0.11'));
  assert.ok(after.includes('            name: GL Beta Free'));
  assert.ok(after.includes('          - id: anthropic/claude-opus-5.5'), '别的 provider 不能被动');

  const again = await syncModels({ spec: resolved.spec, models: resolved.models, env: { PATH: '' } });
  assert.equal(again.state, 'unchanged');
});

test('syncModels：白名单决定写入哪些模型与顺序', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const { path } = tempPatch();
  const resolved = configFor(port, path, { only: ['global:beta'] });

  const result = await syncModels({ spec: resolved.spec, models: resolved.models, env: { PATH: '' } });
  assert.equal(result.state, 'updated');
  const after = readFileSync(path, 'utf8');
  assert.deepEqual(
    after.split('\n').filter((l) => /^\s+- id: (cn|global):/.test(l)).map((l) => l.trim()),
    ['- id: global:beta'],
  );
});

test('syncModels：空列表 / 请求失败 / 无法定位时都不动文件', async (t) => {
  const emptyFixture = startFixture({ TEST_MODE: 'http-empty' });
  t.after(emptyFixture.stop);
  const { path } = tempPatch();
  const emptyResolved = configFor(await emptyFixture.ready, path);
  const skippedEmpty = await syncModels({ spec: emptyResolved.spec, models: emptyResolved.models, env: { PATH: '' } });
  assert.equal(skippedEmpty.state, 'skipped');
  assert.match(skippedEmpty.reason, /空模型列表/);
  assert.equal(readFileSync(path, 'utf8'), PATCH_FIXTURE, '空列表绝不能清空已有配置');

  const errorFixture = startFixture({ TEST_MODE: 'http-error' });
  t.after(errorFixture.stop);
  const errorResolved = configFor(await errorFixture.ready, path);
  const failed = await syncModels({ spec: errorResolved.spec, models: errorResolved.models, env: { PATH: '' } });
  assert.equal(failed.state, 'failed');
  assert.equal(readFileSync(path, 'utf8'), PATCH_FIXTURE);

  // 后端正常但目标文件结构认不出：必须拒绝写入（宁可不同步也不能改错位置）。
  const modelsFixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(modelsFixture.stop);
  const noModels = tempPatch(SAMPLE_NO_MODELS_PATCH);
  const noModelsResolved = configFor(await modelsFixture.ready, noModels.path);
  const located = await syncModels({
    spec: noModelsResolved.spec,
    models: noModelsResolved.models,
    env: { PATH: '' },
  });
  assert.equal(located.state, 'failed');
  assert.match(located.reason, /models/);
  assert.equal(readFileSync(noModels.path, 'utf8'), SAMPLE_NO_MODELS_PATCH);
});

test('syncModels：dry-run 只算不写；未开启时直接跳过', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const { path } = tempPatch();
  const resolved = configFor(port, path);

  const plan = await syncModels({ spec: resolved.spec, models: resolved.models, env: { PATH: '' }, dryRun: true });
  assert.equal(plan.state, 'dry-run');
  assert.equal(readFileSync(path, 'utf8'), PATCH_FIXTURE);

  const off = configFor(port, path, { enabled: false });
  assert.deepEqual(await syncModels({ spec: off.spec, models: off.models, env: { PATH: '' } }), { state: 'disabled' });
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

test('syncModels：备份只保留最近 keepBackups 份', async (t) => {
  const fixture = startFixture({ TEST_MODE: 'http-models', TEST_TOKEN: 'test-key' });
  t.after(fixture.stop);
  const port = await fixture.ready;
  const { dir, path } = tempPatch();
  const resolved = configFor(port, path, { keepBackups: 2 });

  for (let i = 0; i < 3; i += 1) {
    // 每轮先把 models 段改脏，逼出一次真实写入（备份名精确到秒，故隔开一秒）。
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^\s+- id: (cn|global):.*$/m, '          - id: cn:stale'));
    const result = await syncModels({ spec: resolved.spec, models: resolved.models, env: { PATH: '' } });
    assert.equal(result.state, 'updated');
    if (i < 2) await sleep(1_050);
  }

  const backups = readdirSync(dir).filter((name) => name.includes('bak-before-model-sync'));
  assert.equal(backups.length, 2, `备份应只保留 2 份，实际 ${backups.join(', ')}`);
});
