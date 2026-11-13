import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_PREFIX, ROUTER_BASE_PATH, planAutoRoute, routeKey } from '../lib/auto-route.js';
import { resolveConfig } from '../lib/config.js';

const config = (models) => resolveConfig({ syncEnabled: true, autoRoute: true, models });

test('合并键按裸模型 ID，忽略供应商、大小写、月日快照与计费档位', () => {
  assert.equal(AUTO_PREFIX, 'auto:');
  assert.equal(ROUTER_BASE_PATH, '/plugins/dsh-magpie/router');
  for (const id of ['workbuddy/DeepSeek-V4.1-Flash', 'workbuddy-ai/deepseek-v4.1-flash-1017', 'auto:deepseek-v4.1-flash']) {
    assert.equal(routeKey(id), 'deepseek-v4.1-flash');
  }
  assert.equal(routeKey('cn:hy4free'), 'cn:hy4', '没有斜杠的路由组保留前缀，只去掉明确档位');
  assert.equal(routeKey('workbuddy/hy4free'), 'hy4');
  assert.equal(routeKey('workbuddy/hy4std-1017'), 'hy4');
  assert.equal(routeKey('workbuddy/free'), 'free', '单独 free 不能变成空键');
  for (const id of ['workbuddy/model-2000', 'workbuddy/model-1301', 'workbuddy/model-0132']) assert.equal(routeKey(id), id.split('/')[1]);
  assert.equal(routeKey('qoder-cn/qwen4-max-preview'), 'qwen4-max', 'Preview 标记不算型号差异');
  assert.equal(routeKey('qwenwork/qwen4-max-预览版'), 'qwen4-max', '中文预览版与 Preview 等价');
});

test('别名 ID 看不出同款时按带版本号的显示名合并，Preview 与预览版同组', () => {
  const planned = planAutoRoute(config([
    { id: 'qwenwork/frontier-1', name: 'Qwen4-Max 预览版', contextWindow: 1000000, input: ['text', 'image'] },
    { id: 'qoder-cn/qmodel_latest', name: 'Qwen4-Max-Preview', contextWindow: 1000000, input: ['text', 'image'], reasoningEfforts: ['low', 'high', 'xhigh'] },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [['auto:frontier-1', 'Qwen4-Max 预览版 Auto']]);
  assert.deepEqual(planned.routes.get('auto:frontier-1').map((row) => row.id), ['qwenwork/frontier-1', 'qoder-cn/qmodel_latest']);
  assert.deepEqual(planned.entries[0].reasoningEfforts, [], '思考档位仍取交集');
});

test('(Max) 档位变体与不带后缀的同款合并，合并名去掉档位标记', () => {
  const planned = planAutoRoute(config([
    { id: 'qoder-cn/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'trae-cn/deepseek-v4.1-flash-max', name: 'DeepSeek-V4.1-Flash (Max)' },
    { id: 'trae-cn/qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'trae-cn/qwen3.8-max-max', name: 'Qwen3.8-Max (Max)' },
    { id: 'trae-cn/glm-5.3', name: 'GLM-5.3' },
    { id: 'trae-cn/glm-5.3-flash-max', name: 'GLM-5.3-Flash (Max)' },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:deepseek-v4.1-flash', 'DeepSeek V4.1 Flash Auto'],
    ['auto:qwen3.8-max', 'Qwen3.8-Max Auto'],
    ['auto:glm-5.3', 'GLM-5.3 Trae'],
    ['auto:glm-5.3-flash-max', 'GLM-5.3-Flash (Max) Trae'],
  ], '型号自带 Max 与档位 (Max) 不混淆，Flash 变体不与基础款合并');
  assert.deepEqual(planned.routes.get('auto:deepseek-v4.1-flash').map((row) => row.id), ['qoder-cn/deepseek-v4.1-flash', 'trae-cn/deepseek-v4.1-flash-max']);
});

test('不带版本号的通用别名同名也不按名称合并，避免误并不同模型', () => {
  const planned = planAutoRoute(config([
    { id: 'trae-cn/file_search_agent', name: 'search_agent_qwen_fast' },
    { id: 'trae-cn/search_agent_qwen_fast', name: 'search_agent_qwen_fast' },
  ]));
  assert.deepEqual(planned.entries.map((entry) => entry.id), ['auto:file_search_agent', 'auto:search_agent_qwen_fast']);
});

test('同款多供应商合并为一个 Auto，能力取安全集合且候选保持清单顺序', () => {
  const planned = planAutoRoute(config([
    { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: ['low', 'high', 'max'] },
    { id: 'workbuddy-ai/deepseek-v4.1-flash-1017', name: 'Deepseek-V4.1-Flash', contextWindow: 800000, maxTokens: 64000, reasoningEfforts: ['low', 'high'] },
    { id: 'qoder-cn/other', name: 'Other', enabled: false },
  ]));
  assert.deepEqual(planned.entries, [{
    id: 'auto:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash Auto', contextWindow: 800000, maxTokens: 64000,
    input: ['text', 'image'], reasoningEfforts: ['low', 'high'],
  }]);
  assert.deepEqual(planned.routes.get('auto:deepseek-v4.1-flash').map((row) => row.id), ['workbuddy/deepseek-v4.1-flash', 'workbuddy-ai/deepseek-v4.1-flash-1017']);
});

test('视觉取并集，思考档位取交集；未知上下文不拉低已知限额', () => {
  const planned = planAutoRoute(config([
    { id: 'a/glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, reasoningEfforts: ['low', 'high'] },
    { id: 'b/glm-5.3', name: 'GLM-5.3', input: ['text', 'image'], maxTokens: 32000, reasoningEfforts: ['high'] },
  ]));
  assert.deepEqual(planned.entries[0], { id: 'auto:glm-5.3', name: 'GLM-5.3 Auto', contextWindow: 1000000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: ['high'] });
});

test('单个候选也使用稳定 auto ID 并保留显示名，不同裸 ID 和大系列不合并', () => {
  const planned = planAutoRoute(config([
    { id: 'workbuddy/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'workbuddy-ai/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'qoder-cn/glm-5.3', name: 'GLM-5.3' },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:deepseek-v4-pro', 'DeepSeek-V4-Pro WorkBuddy'],
    ['auto:deepseek-v4.1-flash', 'DeepSeek V4.1 Flash WorkBuddy GL'],
    ['auto:glm-5.3', 'GLM-5.3 Qoder'],
  ]);
  assert.equal(planned.routes.size, 3);
});
