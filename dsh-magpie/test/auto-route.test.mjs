import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_PREFIX, DEFAULT_EFFORTS, ROUTER_BASE_PATH, planAutoRoute, routeKey } from '../lib/auto-route.js';
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
  assert.equal(routeKey('qoder-cn/qwen4-max-preview'), 'qwen4-max-preview', 'Preview 保留为独立型号');
  assert.equal(routeKey('qwenwork/qwen4-max-预览版'), 'qwen4-max-preview', '中文预览版与 Preview 等价');
  assert.equal(routeKey('qoder-cn/qwen4-max-preview', { legacyGrouping: true }), 'qwen4-max', '旧合并规则只用于引用迁移');
  assert.equal(routeKey('trae-cn/glm-4.7-auto'), 'glm-4.7');
  assert.equal(routeKey('trae-cn/kimi-k3-auto-max'), 'kimi-k3-max');
  assert.equal(routeKey('custom/auto'), 'auto', '独立的 auto 是路由名，不是后缀');
  assert.equal(routeKey('custom/auto-model-2'), 'auto-model-2', '名称中间的 auto 不移除');
});

test('Qwen4 Max 与 Preview 各自跨渠道合并，反排清单也不会混合出口', () => {
  const rows = [
    { id: 'qoder-cn/qmodel_latest', name: 'Qwen4-Max' },
    { id: 'qoder-cn/qmodel_latest_preview', name: 'Qwen4-Max-Preview' },
    { id: 'qoder/qmodel_latest', name: 'Qwen4-Max' },
    { id: 'qoder/qmodel_latest_preview', name: 'Qwen4-Max-Preview' },
    { id: 'trae-cn/qwen4-max-max', name: 'Qwen4-Max (Max)' },
    { id: 'qwenwork/frontier-1', name: 'Qwen4-Max（预览版）' },
  ];
  const original = structuredClone(rows);
  for (const models of [rows, [...rows].reverse()]) {
    const planned = planAutoRoute(config(models));
    assert.deepEqual(planned.entries.map((row) => row.id).sort(), ['auto:qwen4-max', 'auto:qwen4-max-preview']);
    for (const preview of [false, true]) {
      const id = `auto:qwen4-max${preview ? '-preview' : ''}`;
      const expected = models.filter((row) => /preview|预览版/i.test(row.name)).map((row) => row.id);
      const regular = models.filter((row) => !/preview|预览版/i.test(row.name)).map((row) => row.id);
      assert.deepEqual(planned.routes.get(id).map((row) => row.id), preview ? expected : regular);
    }
    assert.equal(planAutoRoute(config(models), { legacyGrouping: true }).routes.size, 1, '保留历史混合分组用于升级迁移');
  }
  assert.deepEqual(rows, original, '不改写上游名称、完整 ID 或勾选');
});

test('同裸 ID、同名及别名关联不能跨越 Preview 边界，只有 ID 标记时也保留 Preview 名称', () => {
  const planned = planAutoRoute(config([
    { id: 'a/shared', name: 'Qwen4-Max', contextWindow: 1000000 },
    { id: 'b/shared', name: 'Qwen4-Max (Preview)', contextWindow: 800000 },
    { id: 'c/qwen4-max-preview', name: 'Qwen4-Max', contextWindow: 900000 },
    { id: 'd/alias', name: 'Qwen4-Max 预览版', contextWindow: 700000 },
    { id: 'e/qwen4-max-preview', name: 'Qwen4-Max-Preview', enabled: false },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name, contextWindow }) => ({ id, name, contextWindow })), [
    { id: 'auto:qwen4-max', name: 'Qwen4-Max', contextWindow: 1000000 },
    { id: 'auto:qwen4-max-preview', name: 'Qwen4-Max-Preview', contextWindow: 700000 },
  ]);
  assert.deepEqual(planned.routes.get('auto:qwen4-max').map((row) => row.id), ['a/shared']);
  assert.deepEqual(planned.routes.get('auto:qwen4-max-preview').map((row) => row.id), ['b/shared', 'c/qwen4-max-preview', 'd/alias']);
});

test('别名 ID 看不出同款时按带版本号的显示名合并，ID 与展示名取实际模型名', () => {
  const planned = planAutoRoute(config([
    { id: 'qwenwork/frontier-1', name: 'Qwen4-Max 预览版', contextWindow: 1000000, input: ['text', 'image'] },
    { id: 'qoder-cn/qmodel_latest', name: 'Qwen4-Max-Preview', contextWindow: 1000000, input: ['text', 'image'], reasoningEfforts: ['low', 'high', 'xhigh'] },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [['auto:qwen4-max-preview', 'Qwen4-Max-Preview']]);
  assert.deepEqual(planned.routes.get('auto:qwen4-max-preview').map((row) => row.id), ['qwenwork/frontier-1', 'qoder-cn/qmodel_latest']);
  assert.deepEqual(planned.entries[0].reasoningEfforts, ['low', 'high', 'xhigh'], '思考档位取并集');
});

test('(Max) 档位变体与不带后缀的同款合并，ID 与展示名都不带档位标记', () => {
  const planned = planAutoRoute(config([
    { id: 'qoder-cn/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'trae-cn/deepseek-v4.1-flash-max', name: 'DeepSeek-V4.1-Flash (Max)' },
    { id: 'trae-cn/qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'trae-cn/qwen3.8-max-max', name: 'Qwen3.8-Max (Max)' },
    { id: 'trae-cn/glm-5.3', name: 'GLM-5.3' },
    { id: 'trae-cn/glm-5.3-flash-max', name: 'GLM-5.3-Flash (Max)' },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'],
    ['auto:qwen3.8-max', 'Qwen3.8-Max'],
    ['auto:glm-5.3', 'GLM-5.3'],
    ['auto:glm-5.3-flash', 'GLM-5.3-Flash'],
  ], '型号自带 Max 与档位 (Max) 不混淆，Flash 变体不与基础款合并');
  assert.deepEqual(planned.routes.get('auto:deepseek-v4.1-flash').map((row) => row.id), ['qoder-cn/deepseek-v4.1-flash', 'trae-cn/deepseek-v4.1-flash-max']);
});

test('别名 ID 与正式 ID 指向同款时并成一组，ID 取组内出现最多的模型名', () => {
  const planned = planAutoRoute(config([
    { id: 'qoder-cn/dfmodel', name: 'DeepSeek-Flash' },
    { id: 'trae-cn/deepseek-v4.1-flash-max', name: 'DeepSeek-V4.1-Flash (Max)' },
    { id: 'codearts/deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017' },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [['auto:deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash']]);
  assert.equal(planned.routes.size, 1, '别名不会被拆成两个同款条目');
  assert.deepEqual(planned.routes.get('auto:deepseek-v4.1-flash').map((row) => row.id), ['qoder-cn/dfmodel', 'trae-cn/deepseek-v4.1-flash-max', 'codearts/deepseek-v4.1-flash-1017']);
});

test('Seed-Evolving 的普通、Auto 和 Max 出口合并，保留候选顺序、能力与未勾选状态', () => {
  const rows = [
    { id: 'trae-cn/Doubao-Seed-Evolving', name: 'Seed-Evolving', contextWindow: 256000, input: ['text', 'image'] },
    { id: 'trae-cn/Doubao-Seed-Evolving-auto', name: 'Seed-Evolving', contextWindow: 256000, input: ['text', 'image'] },
    { id: 'trae-cn/Doubao-Seed-Evolving-auto-max', name: 'Seed-Evolving (Max)', contextWindow: 1000000, input: ['text', 'image'] },
    { id: 'trae-cn/Doubao-Seed-Evolving-max', name: 'Seed-Evolving (Max)', contextWindow: 1000000, input: ['text', 'image'] },
  ];
  const original = structuredClone(rows);
  const planned = planAutoRoute(config(rows));
  assert.deepEqual(planned.entries.map(({ id, name, contextWindow }) => ({ id, name, contextWindow })), [
    { id: 'auto:seed-evolving', name: 'Seed-Evolving', contextWindow: 256000 },
  ]);
  assert.deepEqual(planned.routes.get('auto:seed-evolving').map((row) => row.id), rows.map((row) => row.id));
  assert.deepEqual(planned.entries[0].input, ['text', 'image']);
  assert.deepEqual(rows, original);
  const selected = config(rows.map((row, i) => ({ ...row, enabled: i >= 2 })));
  assert.deepEqual(planAutoRoute(selected).entries.map(({ id, name }) => [id, name]), [['auto:seed-evolving', 'Seed-Evolving']]);
  assert.equal(planAutoRoute(selected).routes.get('auto:seed-evolving').length, 2, '合并不替用户勾选另外两个出口');
  assert.deepEqual(planAutoRoute(selected, { legacyGrouping: true }).entries.map((row) => row.id), [
    'auto:seed-evolving-e1f6e232267d', 'auto:seed-evolving-4bb04c94ca88',
  ]);
});

test('Auto 后缀与原模型合并，名称和 ID 不再随 Auto 排序变化，普通模型名中的 Max 保留', () => {
  const rows = [
    { id: 'trae-cn/glm-4.7', name: 'GLM-4.7' },
    { id: 'trae-cn/glm-4.7-auto', name: 'glm-4.7-auto' },
    { id: 'trae-cn/qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'trae-cn/qwen3.8-max-auto', name: 'Qwen3.8-Max-auto' },
  ];
  for (const models of [rows, [...rows].reverse()]) {
    const planned = planAutoRoute(config(models));
    assert.deepEqual(planned.entries.map((m) => m.id).sort(), ['auto:glm-4.7', 'auto:qwen3.8-max']);
    assert.equal(planned.routes.get('auto:glm-4.7').length, 2);
    assert.equal(planned.routes.get('auto:qwen3.8-max').length, 2);
  }
});

test('Seed-2.1-Pro 与中文豆包 2.1 Pro 合并，Kimi 高速版与普通版保持独立', () => {
  const rows = [
    { id: 'trae-cn/seed-code-pro-0430', name: 'Doubao-Seed-2.1-Pro', input: ['text', 'image'] },
    { id: 'trae-cn/Doubao-Seed-2.1-Pro', name: 'Seed-2.1-Pro-0915', input: ['text', 'image'] },
    { id: 'doubao-work/doubao-2.1-pro', name: '豆包 2.1 Pro' },
    { id: 'doubao-work/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', input: ['text', 'image'] },
    { id: 'doubao-work/kimi-k3.1-pro-fast', name: 'Kimi K3.1 Pro 高速' },
  ];
  const original = structuredClone(rows);
  const planned = planAutoRoute(config(rows));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:seed-2.1-pro', 'Seed-2.1-Pro'], ['auto:kimi-k3.1-pro', 'Kimi-K3.1-Pro'],
    ['auto:kimi-k3.1-pro-高速', 'Kimi-K3.1-Pro-高速'],
  ]);
  assert.deepEqual(planned.routes.get('auto:seed-2.1-pro').map((m) => m.id), rows.slice(0, 3).map((m) => m.id));
  assert.deepEqual(rows, original, '原始名称、ID 与能力不改写');
});

test('Auto 与上游改名形成跨组关联时完整合并，清单反排仍同组且候选按原顺序', () => {
  const rows = [
    { id: 'trae-cn/Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.1-Turbo' },
    { id: 'trae-cn/Doubao-Seed-2.0-Code-auto', name: 'Seed-2.0-Code' },
    { id: 'trae-cn/Doubao-Seed-2.1-Turbo', name: 'Seed-2.1-Turbo' },
    { id: 'trae-cn/Doubao-Seed-2.1-Turbo-auto', name: 'Seed-2.1-Turbo' },
  ];
  for (const models of [rows, [...rows].reverse()]) {
    const planned = planAutoRoute(config(models));
    assert.deepEqual(planned.entries.map((m) => m.id), ['auto:seed-2.1-turbo']);
    assert.deepEqual(planned.routes.get('auto:seed-2.1-turbo').map((m) => m.id), models.map((m) => m.id));
    assert.equal(planAutoRoute(config(models), { legacyGrouping: true }).routes.size, 2, '旧规则仍用于找回被拆分的历史引用');
  }
});

test('无版本号名称只对已确认型号合并，Seed-Code 与内部代理别名保留独立组', () => {
  const planned = planAutoRoute(config([
    { id: 'trae-cn/Doubao_1_6', name: 'Seed-Code' },
    { id: 'trae-cn/Doubao-Seed-Code', name: 'Seed-Code' },
    { id: 'trae-cn/file_search_agent', name: 'search_agent_qwen_fast' },
    { id: 'trae-cn/search_agent_qwen_fast', name: 'search_agent_qwen_fast' },
  ]));
  assert.equal(planned.routes.size, 4, '未经确认的同名目录和代理不能跟随 Seed-Evolving 一起放开');
});

test('不带版本号的通用别名同名也不按名称合并，ID 用稳定后缀、展示名用数字后缀区分', () => {
  const rows = [
    { id: 'trae-cn/file_search_agent', name: 'search_agent_qwen_fast' },
    { id: 'trae-cn/search_agent_qwen_fast', name: 'search_agent_qwen_fast' },
  ];
  const planned = planAutoRoute(config(rows));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:search-agent-qwen-fast-51e50d5e3ce7', 'search_Agent_Qwen_Fast'],
    ['auto:search-agent-qwen-fast-f36fe7f823b5', 'search_Agent_Qwen_Fast 2'],
  ]);
  assert.deepEqual(planAutoRoute(config(rows), { legacyIds: true }).entries.map((row) => row.id), [
    'auto:search-agent-qwen-fast', 'auto:search-agent-qwen-fast-2',
  ], '升级时仍能识别旧数字后缀');
});

test('同名 ID 与原始候选绑定，重排或移除另一候选不会复用旧 ID', () => {
  const a = { id: 'trae-cn/file_search_agent', name: 'search_agent_qwen_fast' };
  const b = { id: 'trae-cn/search_agent_qwen_fast', name: 'search_agent_qwen_fast' };
  const initial = planAutoRoute(config([a, b]));
  const idOf = (planned, id) => [...planned.routes].find(([_autoId, members]) => members.some((row) => row.id === id))?.[0];
  const initialA = idOf(initial, a.id), initialB = idOf(initial, b.id);
  const reordered = planAutoRoute(config([b, a]));
  assert.equal(idOf(reordered, a.id), initialA);
  assert.equal(idOf(reordered, b.id), initialB);
  const remaining = idOf(planAutoRoute(config([b])), b.id);
  assert.notEqual(remaining, initialA, '剩余候选不能复用已移除候选的旧引用');
  assert.notEqual(remaining, initialB, '不再同名时恢复可读 ID，旧引用由迁移逻辑接续');
});

test('名称为占位符时退回裸 ID，不出现 auto:- 这类 ID', () => {
  const planned = planAutoRoute(config([{ id: 'trae-cn/sagitta', name: '-' }]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [['auto:sagitta', 'sagitta']]);
});

test('同款多供应商合并为一个条目，限额取安全集合，视觉与思考档位取并集', () => {
  const planned = planAutoRoute(config([
    { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: ['low', 'high', 'max'] },
    { id: 'workbuddy-ai/deepseek-v4.1-flash-1017', name: 'Deepseek-V4.1-Flash', contextWindow: 800000, maxTokens: 64000, reasoningEfforts: ['low', 'high'] },
    { id: 'qoder-cn/other', name: 'Other', enabled: false },
  ]));
  assert.deepEqual(planned.entries, [{
    id: 'auto:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 800000, maxTokens: 64000,
    input: ['text', 'image'], reasoningEfforts: ['low', 'high', 'max'],
  }]);
  assert.deepEqual(planned.routes.get('auto:deepseek-v4.1-flash').map((row) => row.id), ['workbuddy/deepseek-v4.1-flash', 'workbuddy-ai/deepseek-v4.1-flash-1017']);
});

test('没有候选声明思考档位时按低 / 高 / 最大兜底，DSH 仍显示思考深度', () => {
  const planned = planAutoRoute(config([
    { id: 'opencode-zen-free/longcat-2.5-free', name: 'LongCat 2.5 Free' },
    { id: 'trae-cn/MiMo-V2.6-Pro-max', name: 'MiMo-V2.6-Pro (Max)' },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:longcat-2.5-free', 'LongCat-2.5-Free'],
    ['auto:mimo-v2.6-pro', 'MiMo-V2.6-Pro'],
  ]);
  assert.deepEqual(planned.entries.map((entry) => entry.reasoningEfforts), [DEFAULT_EFFORTS, ['low', 'high', 'max']]);
  assert.deepEqual(DEFAULT_EFFORTS, ['low', 'high', 'max']);
});

test('视觉取并集，思考档位取并集；未知上下文不拉低已知限额', () => {
  const planned = planAutoRoute(config([
    { id: 'a/glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, reasoningEfforts: ['low', 'high'] },
    { id: 'b/glm-5.3', name: 'GLM-5.3', input: ['text', 'image'], maxTokens: 32000, reasoningEfforts: ['high'] },
  ]));
  assert.deepEqual(planned.entries[0], { id: 'auto:glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: ['low', 'high'] });
});

test('单个候选也用模型名做 ID，展示名不带 Auto 或供应商后缀，不同裸 ID 和大系列不合并', () => {
  const planned = planAutoRoute(config([
    { id: 'workbuddy/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'workbuddy-ai/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'qoder-cn/glm-5.3', name: 'GLM-5.3' },
  ]));
  assert.deepEqual(planned.entries.map(({ id, name }) => [id, name]), [
    ['auto:deepseek-v4-pro', 'DeepSeek-V4-Pro'],
    ['auto:deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'],
    ['auto:glm-5.3', 'GLM-5.3'],
  ]);
  assert.equal(planned.routes.size, 3);
});
