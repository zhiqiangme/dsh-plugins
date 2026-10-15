import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePluginConfig } from '../lib/config.js';
import { fetchModels, modelDisplayName, planModelEntries, priceLabel, syncModels } from '../lib/models.js';
import { createFakeConfigEditor, profileRows } from '../fixtures/fake-config-editor.mjs';
import { catalog, memoryCredentials, serve } from '../fixtures/http-fixture.mjs';
import { describeModels } from '../lib/web.js';

test('真实网关元数据：视觉、上下文、输出限制与思考；过滤 System One 和重复 id', () => {
  const entries = planModelEntries([...catalog, catalog[0]]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: 'vision-free', name: 'Vision', contextWindow: 200000,
    maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high' } });
  assert.deepEqual(entries[1], { id: 'text-model', name: 'Text-Model', contextWindow: 100000,
    maxTokens: 8192, input: ['text'] });
  assert.equal(priceLabel(catalog[0]), 'Free');
  assert.equal(priceLabel(catalog[1]), '$0.2 / $0.8');
  assert.equal(priceLabel({ id: 'unknown' }), '—');
});

test('展示名各连字符分段首字母大写，保留其余拼写和上游 id', () => {
  assert.equal(modelDisplayName({ id: 'deepseek-v4.1-flash-free' }), 'Deepseek-V4.1-Flash-Free');
  assert.equal(modelDisplayName({ id: 'step-5-preview-free' }), 'Step-5-Preview-Free');
  assert.equal(modelDisplayName({ id: 'opaque-id', name: 'GLM-5.3-flash' }), 'GLM-5.3-Flash');
  assert.equal(modelDisplayName({ id: 'opaque-id', name: '  mimo v2.6 Flash  ' }), 'Mimo v2.6 Flash');
  assert.equal(modelDisplayName({ id: 'opaque-id', name: 'OpenCode' }), 'OpenCode');
  assert.equal(planModelEntries([{ id: 'cat-jam-free' }])[0].id, 'cat-jam-free');
});

test('支持 Max 的模型同步后默认 Max，重复同步不改配置；能力改变后不会发送不支持的档位', async (t) => {
  let models = [{ id: 'deepseek-free', supports_reasoning: true, reasoning_efforts: ['low', 'high', 'max'] }];
  const url = await serve(t, (_req, res) => res.end(JSON.stringify({ data: models })));
  const resolved = resolvePluginConfig({ models: { enabled: true, apiKey: 'key', baseURL: url } }, {});
  const editor = createFakeConfigEditor(profileRows());
  const credentials = memoryCredentials();
  const options = { ...resolved, editor, credentials, env: {} };
  assert.equal((await syncModels(options)).state, 'updated');
  const provider = () => editor.entry('llm-pi-ai').options.config.providers.opencode2api;
  assert.equal(provider().reasoning, 'max');
  assert.equal(provider().models[0].reasoningEfforts.max, 'max');
  assert.equal(provider().models[0].name, 'Deepseek-Free');
  assert.equal((await syncModels(options)).state, 'unchanged');
  models = catalog;
  assert.equal((await syncModels(options)).state, 'updated');
  assert.equal(provider().reasoning, undefined);
  assert.equal((await syncModels(options)).state, 'unchanged');
});
test('白名单顺序、空白名单、排除和未知 id', () => {
  assert.deepEqual(planModelEntries(catalog, { only: ['text-model','missing','vision-free'] }).map(m=>m.id), ['text-model','vision-free']);
  assert.deepEqual(planModelEntries(catalog, { only: [], exclude:['vision-free'] }).map(m=>m.id), ['text-model']);
  assert.equal(planModelEntries(catalog, { only:['missing'] }).length, 0);
});
test('本地 Key 写入凭据库，profile 只存引用并保留其他 provider', async (t) => {
  const url = await serve(t, (req,res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-secret');
    res.end(JSON.stringify({ data: catalog }));
  });
  const resolved=resolvePluginConfig({models:{enabled:true,apiKey:'local-test-secret',baseURL:url}},{});
  const editor=createFakeConfigEditor(profileRows({withProvider:false}));
  const credentials=memoryCredentials();
  assert.equal((await syncModels({...resolved,editor,credentials,env:{}})).state,'updated');
  assert.equal(credentials.values.get('OPENCODE2API_PROXY_KEY'),'local-test-secret');
  const config=editor.entry('llm-pi-ai').options.config;
  assert.ok(config.providers.openrouter);
  assert.equal(config.providers.opencode2api.baseURL,`${url}/v1/`);
  assert.equal(config.providers.opencode2api.apiKeyEnv,'OPENCODE2API_PROXY_KEY');
  assert.ok(!JSON.stringify(config).includes('local-test-secret'));
});
test('Key 只在凭据库时按 { value } 读取；值未变时不重写凭据', async (t) => {
  const url = await serve(t, (req, res) => {
    if (req.headers.authorization !== 'Bearer vault-secret') { res.statusCode = 401; res.end('{}'); return; }
    res.end(JSON.stringify({ data: catalog }));
  });
  // panelConfig 指向不存在的文件：外部后端没有可读的 config.json，只能从凭据库取 Key。
  const resolved = resolvePluginConfig({ models: { enabled: true, baseURL: url, panelConfig: `${url}-missing.json` } }, {});
  const editor = createFakeConfigEditor(profileRows());
  const credentials = memoryCredentials();
  credentials.values.set('OPENCODE2API_PROXY_KEY', 'vault-secret');
  assert.equal((await syncModels({ ...resolved, editor, credentials, env: {} })).state, 'updated');
  assert.equal((await syncModels({ ...resolved, editor, credentials, env: {} })).state, 'unchanged');
  assert.deepEqual(credentials.writes, []);
  const snapshot = await describeModels({ ...resolved, editor, credentials, env: {} });
  assert.equal(snapshot.ok, true);
});
for(const scenario of ['empty','unauthorized','invalid-json','no-credentials','read-only','vault-failed']) {
  test(`失败保持模型配置：${scenario}`,async(t)=>{
    const url=await serve(t,(_req,res)=>{
      if(scenario==='unauthorized')res.statusCode=401;
      res.end(scenario==='invalid-json'?'bad':JSON.stringify({data:scenario==='empty'?[]:catalog}));
    });
    const resolved=resolvePluginConfig({models:{enabled:true,apiKey:'key',baseURL:url}},{});
    const editor=createFakeConfigEditor(profileRows());
    const before=structuredClone(editor.entry('llm-pi-ai').options.config);
    const credentials=scenario==='no-credentials'?undefined:memoryCredentials();
    if(scenario==='read-only')credentials.describe=async()=>({writable:false});
    if(scenario==='vault-failed')credentials.set=async()=>{throw new Error('vault unavailable');};
    const result=await syncModels({...resolved,editor,credentials,env:{}});
    assert.ok(['failed','skipped'].includes(result.state));
    assert.deepEqual(editor.entry('llm-pi-ai').options.config,before);
  });
}
test('目录请求保留 HTTP 错误，不伪装成空列表',async(t)=>{
  const url=await serve(t,(_req,res)=>{res.statusCode=403;res.end('{}');});
  assert.match((await fetchModels({baseURL:url})).reason,/403/);
});
