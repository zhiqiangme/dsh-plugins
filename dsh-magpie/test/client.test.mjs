import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { PROVIDER_NAMES } from '../lib/names.js';
import { clientHarness, button, field, nodes } from '../fixtures/client.mjs';

const view = (config = {}) => ({ ok: true, config: resolveConfig(config), revision: 'revision-one', providerNames: PROVIDER_NAMES, nativeProviders: ['magpie'], editable: true, keyConfigured: false, keyWritable: true });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const handles = (tree) => nodes(tree, (n) => n.props.className === 'model-drag');
const modelRows = (tree) => nodes(tree, (n) => n.props.className?.split(' ').includes('model'));
function dragEvent(after = false) {
  return {
    clientY: after ? 45 : 15, prevented: false,
    preventDefault() { this.prevented = true; },
    dataTransfer: { setData() {}, setDragImage() {} },
    currentTarget: { getBoundingClientRect: () => ({ top: 10, height: 40 }) },
  };
}
function dragModel(client, from, to, after = false) {
  handles(client.render())[from].props.onDragStart(dragEvent());
  modelRows(client.render())[to].props.onDragOver(dragEvent(after));
  modelRows(client.render())[to].props.onDrop(dragEvent(after));
}

test('客户端模块、两个卡片入口和中英字典符合宿主契约', () => {
  const client = clientHarness(view());
  assert.equal(client.registration.id, '@zhiqiangme/dsh-magpie');
  assert.deepEqual(client.cards.map((x) => [x.meta.name, x.meta.key]), [['plugins.bundle.config', '@zhiqiangme/dsh-magpie'], ['plugins.row.config', '@zhiqiangme/dsh-magpie#dsh-magpie']]);
  assert.deepEqual(Object.keys(client.module.zh), Object.keys(client.module.en));
  assert.ok(Object.values(client.module.zh).every((value) => typeof value === 'string'));
  assert.equal(client.styles.length, 1);
  assert.ok(button(client.render(), '手动添加模型'));
  assert.ok(button(client.render(), '从 Magpie 同步'));
  assert.ok(button(client.render(), '按模型排序'));
  assert.ok(button(client.render(), '按供应商排序'));
});

test('添加、编辑、调整顺序、取消勾选、删除通过卡片实际事件更新待保存清单', () => {
  const client = clientHarness(view({ models: [{ id: 'first' }] }));
  button(client.render(), '手动添加模型').props.onClick();
  let tree = client.render();
  const ids = nodes(tree, (node) => node.type === 'input' && node.props.placeholder === 'provider/model-id');
  ids[1].props.onChange({ target: { value: 'manual/second' } });
  tree = client.render();
  dragModel(client, 1, 0);
  assert.equal(client.states[0].config.models[0].id, 'manual/second');
  button(client.render(), '取消全选').props.onClick();
  assert.ok(client.states[0].config.models.every((m) => m.enabled === false));
  button(client.render(), '删除').props.onClick();
  assert.equal(client.states[0].config.models.length, 1);
  assert.equal(client.states[0].config.models[0].id, 'first');
});

test('从 Magpie 同步立即提交并用已保存的全量结果替换草稿，重置筛选和展开', async () => {
  let posted;
  const client = clientHarness(view({ models: [{ id: 'workbuddy/old', name: '旧模型' }, { id: 'manual/a' }] }), async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...view({ syncEnabled: true, models: [{ id: 'new/b', name: '新增' }, { id: 'manual/a', name: '上游新名称' }] }), saved: true, sync: { ok: true, count: 2 } });
  });
  field(client.render(), '显示名称').props.onChange({ target: { value: '未保存名称' } });
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: '未保存名称' } });
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  await button(client.render(), '从 Magpie 同步').props.onClick();
  assert.equal(posted.action, 'sync-catalog');
  assert.equal(posted.revision, 'revision-one');
  assert.equal(posted.config.models[0].name, '未保存名称');
  const list = client.states[0].config.models;
  assert.deepEqual(list.map((m) => m.id), ['new/b', 'manual/a']);
  assert.equal(list[1].name, '上游新名称');
  assert.ok(list.every((m) => m.enabled));
  assert.equal(client.states[1], false);
  assert.equal(client.states[5], '');
  assert.deepEqual([...client.states[6]], []);
  assert.match(client.states[3].text, /覆盖保存.*2/);
});

test('全量同步读取失败时保留未保存草稿、筛选和展开，DSH 更新失败明确显示', async () => {
  const client = clientHarness(view({ models: [{ id: 'draft' }] }), async () => response({ ok: false, reason: 'Magpie 返回 HTTP 503' }, 500));
  field(client.render(), '显示名称').props.onChange({ target: { value: '未保存' } });
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: '未保存' } });
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  await button(client.render(), '从 Magpie 同步').props.onClick();
  assert.equal(client.states[0].config.models[0].name, '未保存');
  assert.equal(client.states[1], true);
  assert.equal(client.states[5], '未保存');
  assert.deepEqual([...client.states[6]], [0]);
  assert.match(client.states[3].text, /503/);
  const failedSync = clientHarness(view(), async () => response({ ...view({ models: [{ id: 'fresh' }] }), saved: true, sync: { ok: false, reason: '服务未就绪' } }));
  await button(failedSync.render(), '从 Magpie 同步').props.onClick();
  assert.equal(failedSync.states[1], false);
  assert.equal(failedSync.states[0].config.models[0].id, 'fresh');
  assert.match(failedSync.states[3].text, /清单已保存.*服务未就绪/);
  assert.equal(failedSync.states[3].error, true);
});

test('思考档位输入保留未完成的逗号，保存包含所选模型与原始 ID', async () => {
  let posted;
  const initial = view({ syncEnabled: true, models: [{ id: 'group/preserve' }] });
  const client = clientHarness(initial, async (_url, options) => { posted = JSON.parse(options.body); return response({ ...initial, config: resolveConfig(posted.config), saved: true, sync: { ok: true, count: 1 } }); });
  field(client.render(), '思考档位（逗号分隔）').props.onChange({ target: { value: 'low,' } });
  assert.equal(field(client.render(), '思考档位（逗号分隔）').props.value, 'low,');
  field(client.render(), '思考档位（逗号分隔）').props.onChange({ target: { value: 'low, high' } });
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(posted.config.models[0].id, 'group/preserve');
  assert.deepEqual(posted.config.models[0].reasoningEfforts, ['low', 'high']);
  assert.equal(posted.revision, 'revision-one');
  assert.equal(client.states[1], false);
  assert.equal('effortText' in client.states[0].config.models[0], false, '临时输入不存入配置');
});

test('保存冲突保留草稿，显示错误，不静默重新载入覆盖', async () => {
  const client = clientHarness(view({ models: [{ id: 'draft' }] }), async () => response({ ok: false, reason: '配置已改变' }, 409));
  field(client.render(), '显示名称').props.onChange({ target: { value: '尚未保存' } });
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(client.states[0].config.models[0].name, '尚未保存');
  assert.equal(client.states[1], true);
  assert.equal(client.states[3].text, '配置已改变');
  assert.ok(button(client.render(), '放弃更改并重新载入'));
});

test('provider 同步失败与清单保存成功分别显示，凭据输入不回显', async () => {
  const initial = view({ models: [{ id: 'saved' }] });
  const client = clientHarness(initial, async () => response({ ...initial, saved: true, sync: { ok: false, reason: '服务未就绪' } }));
  field(client.render(), '网关 Key').props.onChange({ target: { value: 'sensitive' } });
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(client.states[1], false);
  assert.equal(client.states[4], '');
  assert.match(client.states[3].text, /清单已保存.*服务未就绪/);
  assert.equal(client.states[3].error, true);
});

test('Key 为只读或配置服务未就绪时相应控件禁用', () => {
  const client = clientHarness({ ...view(), keyWritable: false, editable: false });
  assert.equal(field(client.render(), '网关 Key').props.disabled, true);
  assert.equal(button(client.render(), '保存并同步').props.disabled, true);
  assert.equal(button(client.render(), '从 Magpie 同步').props.disabled, true);
});

test('紧凑行的勾选框位于显示名称左侧，下拉按钮控制原位详情，开关不改变模型选择', () => {
  const client = clientHarness(view({ models: [{ id: 'a', name: 'Step-5-Preview' }, { id: 'b', name: 'Next' }] }));
  const row = nodes(client.render(), (n) => n.props.className === 'model-header')[0];
  assert.equal(row.children[0].props.className, 'model-drag');
  assert.equal(row.children[0].props.draggable, true);
  assert.match(row.children[0].props['aria-label'], /拖动.*Step-5-Preview/);
  assert.equal(row.children[1].type, 'label');
  assert.equal(row.children[1].children[0].props.type, 'checkbox');
  assert.equal(row.children[1].children[1].children[0], 'Step-5-Preview');
  assert.equal(row.children[2].props.className, 'model-toggle');
  assert.equal(row.children[2].props['aria-expanded'], false);
  assert.equal(nodes(client.render(), (n) => n.type === 'button' && (n.children.includes('↑') || n.children.includes('↓'))).length, 0);
  row.children[2].props.onClick();
  let bodies = nodes(client.render(), (n) => n.props.className === 'model-details');
  assert.equal(bodies[0].props.hidden, false);
  assert.equal(bodies[1].props.hidden, true);
  assert.equal(client.states[1], false, '展开不产生未保存改动');
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  bodies = nodes(client.render(), (n) => n.props.className === 'model-details');
  assert.equal(bodies[0].props.hidden, true);
  assert.equal(client.states[0].config.models[0].enabled, true);
});

test('新增模型直接展开，移动或删除后展开状态跟随同一个模型', () => {
  const client = clientHarness(view({ models: [{ id: 'a' }] }));
  button(client.render(), '手动添加模型').props.onClick();
  assert.deepEqual([...client.states[6]], [1]);
  dragModel(client, 1, 0);
  assert.deepEqual([...client.states[6]], [0]);
  button(client.render(), '删除').props.onClick();
  assert.deepEqual([...client.states[6]], []);
});

test('筛选后的批量勾选只影响可见模型', () => {
  const client = clientHarness(view({ models: [{ id: 'visible/a' }, { id: 'other/b' }] }));
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'visible' } });
  button(client.render(), '取消全选').props.onClick();
  assert.equal(client.states[0].config.models[0].enabled, false);
  assert.equal(client.states[0].config.models[1].enabled, true);
});

test('跨多行向下或向上插入，模型编辑、勾选及各自展开状态一起移动，保存提交新顺序', async () => {
  let posted;
  const initial = view({ models: [{ id: 'a', enabled: false }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  const client = clientHarness(initial, async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...initial, config: resolveConfig(posted.config), sync: { ok: true, count: 3 } });
  });
  field(client.render(), '显示名称').props.onChange({ target: { value: '未保存名称' } });
  field(client.render(), '思考档位（逗号分隔）').props.onChange({ target: { value: 'low,' } });
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[2].props.onClick();
  const draft = [...client.states[0].config.models];
  dragModel(client, 0, 3, true);
  assert.deepEqual(client.states[0].config.models, [draft[1], draft[2], draft[3], draft[0]]);
  assert.deepEqual([...client.states[6]], [3, 1]);
  assert.equal(client.states[0].config.models[3].enabled, false);
  assert.equal(client.states[0].config.models[3].effortText, 'low,');
  dragModel(client, 3, 1);
  assert.deepEqual(client.states[0].config.models, [draft[1], draft[0], draft[2], draft[3]]);
  assert.deepEqual([...client.states[6]], [1, 2]);
  await button(client.render(), '保存并同步').props.onClick();
  assert.deepEqual(posted.config.models.map((m) => m.id), ['b', 'a', 'c', 'd']);
  assert.equal(posted.config.models[1].name, '未保存名称');
  assert.equal(client.states[1], false);
});

test('搜索时拖动使用完整清单的位置，隐藏条目保持相对顺序且不会丢失', () => {
  const client = clientHarness(view({ models: ['visible/a', 'hidden/b', 'visible/c', 'hidden/d', 'visible/e'].map((id) => ({ id })) }));
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'visible' } });
  dragModel(client, 2, 0);
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['visible/e', 'visible/a', 'hidden/b', 'visible/c', 'hidden/d']);
});

test('外部拖放、取消拖动及原位放下均不改变顺序或产生未保存改动', () => {
  const client = clientHarness(view({ models: [{ id: 'a' }, { id: 'b' }] }));
  const original = client.states[0].config.models;
  const foreign = dragEvent();
  modelRows(client.render())[1].props.onDragOver(foreign);
  modelRows(client.render())[1].props.onDrop(foreign);
  assert.equal(foreign.prevented, false);
  handles(client.render())[0].props.onDragStart(dragEvent());
  modelRows(client.render())[1].props.onDragOver(dragEvent(true));
  assert.match(modelRows(client.render())[1].props.className, /drop-after/);
  handles(client.render())[0].props.onDragEnd();
  modelRows(client.render())[1].props.onDrop(dragEvent());
  dragModel(client, 0, 0, true);
  assert.equal(client.states[0].config.models, original);
  assert.equal(client.states[1], false);
  assert.equal(client.states[7], null);
});

test('处理期间或仅一个模型时禁用手柄，草稿变化后拒绝过期拖动', () => {
  const single = clientHarness(view({ models: [{ id: 'a' }] }));
  assert.equal(handles(single.render())[0].props.disabled, true);
  assert.equal(handles(single.render())[0].props.draggable, false);
  const client = clientHarness(view({ models: [{ id: 'a' }, { id: 'b' }] }));
  client.states[2] = true;
  assert.equal(handles(client.render())[0].props.disabled, true);
  const blocked = dragEvent();
  handles(client.render())[0].props.onDragStart(blocked);
  assert.equal(blocked.prevented, true);
  assert.equal(client.states[1], false);
  client.states[2] = false;
  handles(client.render())[0].props.onDragStart(dragEvent());
  button(client.render(), '手动添加模型').props.onClick();
  const stale = dragEvent();
  modelRows(client.render())[1].props.onDrop(stale);
  assert.equal(stale.prevented, false);
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['a', 'b', '']);
});

test('管理行预览供应商简称，可按简称搜索；修改名称或 ID 即时更新后缀但不改写手工名称', () => {
  const client = clientHarness(view({ models: [
    { id: 'workbuddy/flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'workbuddy-ai/flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'opencode-zen-free/flash', name: 'DeepSeek V4.1 Flash Free' },
  ] }));
  const labels = () => nodes(client.render(), (n) => n.props.className === 'model-name').map((n) => n.children[0]);
  assert.deepEqual(labels(), ['DeepSeek V4.1 Flash WorkBuddy', 'DeepSeek V4.1 Flash WorkBuddy GL', 'DeepSeek V4.1 Flash Free OpenCode']);
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'WorkBuddy GL' } });
  assert.deepEqual(labels(), ['DeepSeek V4.1 Flash WorkBuddy GL']);
  assert.equal(field(client.render(), '显示名称').props.value, 'DeepSeek V4.1 Flash');
  field(client.render(), '显示名称').props.onChange({ target: { value: '我的模型' } });
  assert.deepEqual(labels(), ['我的模型 WorkBuddy GL']);
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: '' } });
  nodes(client.render(), (n) => n.props.placeholder === 'provider/model-id')[1].props.onChange({ target: { value: 'opencode-zen-free/new-model' } });
  assert.equal(labels()[1], '我的模型 OpenCode');
  assert.equal(client.states[0].config.models[1].name, '我的模型');
});

test('Flash 别名统一展示、搜索和排序，保存仍使用原始名称及路由 ID', async () => {
  let posted;
  const initial = view({ models: [
    { id: 'workbuddy-ai/deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
    { id: 'qoder-cn/dfmodel', name: 'DeepSeek-Flash' },
    { id: 'opencode-zen-free/deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free' },
  ] });
  const original = structuredClone(initial.config.models);
  const client = clientHarness(initial, async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...initial, config: resolveConfig(posted.config), sync: { ok: true, count: 3 } });
  });
  const labels = () => nodes(client.render(), (n) => n.props.className === 'model-name').map((n) => n.children[0]);
  assert.deepEqual(labels(), ['DeepSeek V4.1 Flash WorkBuddy GL', 'DeepSeek V4.1 Flash Qoder', 'DeepSeek V4.1 Flash Free OpenCode']);
  assert.equal(field(client.render(), '显示名称').props.value, 'Deepseek-V4.1-Flash');
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'DeepSeek V4.1 Flash' } });
  assert.equal(labels().length, 3);
  button(client.render(), '按模型排序').props.onClick();
  assert.deepEqual(labels(), ['DeepSeek V4.1 Flash Qoder', 'DeepSeek V4.1 Flash WorkBuddy GL', 'DeepSeek V4.1 Flash Free OpenCode']);
  await button(client.render(), '保存并同步').props.onClick();
  assert.deepEqual(posted.config.models, [original[1], original[0], original[2]]);
});

test('按模型或供应商排序保留草稿、勾选和展开，点击保存后提交新顺序', async () => {
  let posted;
  const initial = view({ models: [
    { id: 'zcode/ten', name: 'Model 10', enabled: false, input: ['text', 'image'], contextWindow: 1000000 },
    { id: 'workbuddy-ai/two', name: 'Model 2 WorkBuddy GL' },
    { id: 'opencode-zen-free/two', name: 'Model 2' },
    { id: 'workbuddy/one', name: 'Model 1' },
    { id: 'qoder-cn/ten', name: 'Model 10' },
  ] });
  const client = clientHarness(initial, async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...initial, config: resolveConfig(posted.config), sync: { ok: true, count: 4 } });
  });
  field(client.render(), '思考档位（逗号分隔）').props.onChange({ target: { value: 'low,' } });
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[3].props.onClick();
  const draft = [...client.states[0].config.models];
  button(client.render(), '按模型排序').props.onClick();
  assert.deepEqual(client.states[0].config.models, [draft[3], draft[2], draft[1], draft[4], draft[0]]);
  assert.deepEqual([...client.states[6]], [4, 0]);
  assert.equal(client.states[1], true);
  assert.equal(client.states[0].config.models[4].enabled, false);
  assert.equal(client.states[0].config.models[4].effortText, 'low,');
  button(client.render(), '按供应商排序').props.onClick();
  assert.deepEqual(client.states[0].config.models, [draft[2], draft[4], draft[3], draft[1], draft[0]]);
  assert.deepEqual([...client.states[6]], [4, 2]);
  assert.equal(client.states[0].config.models[3].name, 'Model 2 WorkBuddy GL');
  assert.equal(posted, undefined, '排序只调整草稿，不自动写入 DSH');
  await button(client.render(), '保存并同步').props.onClick();
  assert.deepEqual(posted.config.models.map((m) => m.id), ['opencode-zen-free/two', 'qoder-cn/ten', 'workbuddy/one', 'workbuddy-ai/two', 'zcode/ten']);
  assert.equal(client.states[1], false);
});

test('快速排序只重排搜索结果所在位置，隐藏条目、筛选及展开状态保留', () => {
  const client = clientHarness(view({ models: [
    { id: 'hidden/one' }, { id: 'visible/z', name: 'Zebra' }, { id: 'hidden/two' },
    { id: 'visible/a', name: 'Alpha' }, { id: 'hidden/three' }, { id: 'visible/b', name: 'Beta' },
  ] }));
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'visible' } });
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  const before = [...client.states[0].config.models];
  button(client.render(), '按模型排序').props.onClick();
  assert.deepEqual(client.states[0].config.models, [before[0], before[3], before[2], before[5], before[4], before[1]]);
  assert.equal(client.states[5], 'visible');
  assert.deepEqual([...client.states[6]], [5]);
  assert.match(button(client.render(), '按模型排序').props.title, /当前搜索结果/);
});

test('排序识别 ID 后的模型名，忽略大小写，自然数字顺序，同键稳定且空条目在后', () => {
  const client = clientHarness();
  const rows = [
    { id: 'workbuddy/model10', name: 'workbuddy/model10' },
    { id: 'opencode-zen-free/model2', name: 'model2 OpenCode' },
    { id: 'qoder-cn/b', name: 'MODEL2' }, { id: 'qoder-cn/c', name: 'model2' },
    { id: '', name: '' }, { id: 'custom-routing-group', name: 'Group' },
    { id: 'constructor/x', name: 'Model1' },
  ];
  assert.deepEqual(client.module.sortModelIndexes(rows, 'model', PROVIDER_NAMES), [5, 6, 1, 2, 3, 0, 4]);
  assert.deepEqual(client.module.sortModelIndexes(rows, 'provider', PROVIDER_NAMES), [6, 1, 2, 3, 0, 5, 4]);
});

test('已排好时不产生未保存状态，处理期间或不足两个匹配模型时禁用快速排序', () => {
  const empty = clientHarness(view());
  assert.equal(button(empty.render(), '按模型排序').props.disabled, true);
  const client = clientHarness(view({ models: [{ id: 'opencode-zen-free/a', name: 'Alpha' }, { id: 'workbuddy/b', name: 'Beta' }] }));
  const original = client.states[0].config.models;
  button(client.render(), '按模型排序').props.onClick();
  button(client.render(), '按供应商排序').props.onClick();
  assert.equal(client.states[0].config.models, original);
  assert.equal(client.states[1], false);
  client.states[2] = true;
  assert.equal(button(client.render(), '按供应商排序').props.disabled, true);
  button(client.render(), '按模型排序').props.onClick();
  assert.equal(client.states[1], false);
  client.states[2] = false;
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'Alpha' } });
  assert.equal(button(client.render(), '按模型排序').props.disabled, true);
  assert.equal(button(client.render(), '按供应商排序').props.disabled, true);
});

test('程序更新请求仅携带目标路径，保留模型草稿、勾选和版本，路径由普通保存持久化', async () => {
  const requests = [];
  const customPath = resolve('portable', 'Magpie.exe');
  const backend = { supported: true, installed: false, version: null, path: resolve('magpie.exe'), defaultPath: resolve('magpie.exe') };
  const client = clientHarness({ ...view({ models: [{ id: 'draft', enabled: false }] }), backend }, async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.action === 'save') return response({ ...view(body.config), backend, sync: { ok: true, count: 0 } });
    return response({ ok: true, backend: { ...backend, latest: { version: '0.1.2' }, operation: body.action === 'backend-install' ? { id: 'job', phase: 'downloading', path: backend.path, running: true, received: 5, total: 10 } : null } });
  });
  field(client.render(), '显示名称').props.onChange({ target: { value: '尚未保存' } });
  field(client.render(), 'Magpie 程序路径').props.onChange({ target: { value: customPath } });
  await button(client.render(), '检查更新').props.onClick();
  assert.deepEqual(requests[0], { action: 'backend-check', magpiePath: customPath });
  assert.equal(client.states[0].config.models[0].name, '尚未保存');
  assert.equal(client.states[0].config.models[0].enabled, false);
  assert.equal(client.states[1], true);
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(requests[1].config.magpiePath, customPath);
  assert.equal(client.states[1], false);
  await button(client.render(), '下载 Magpie').props.onClick();
  assert.equal(requests[2].action, 'backend-install');
  assert.equal(field(client.render(), 'Magpie 程序路径').props.disabled, true);
  assert.equal(button(client.render(), '检查更新').props.disabled, true);
  assert.equal(nodes(client.render(), (n) => n.type === 'progress')[0].props.value, 5);
});

test('已安装程序显示升级，最新版本和不支持的平台禁用入口，失败原因可见', () => {
  const client = clientHarness({ ...view(), backend: { supported: true, installed: true, version: '0.1.1', latest: { version: '0.1.2' }, updateAvailable: true } });
  assert.equal(button(client.render(), '升级 Magpie').props.disabled, false);
  client.states[0].backend.updateAvailable = false;
  assert.equal(button(client.render(), '升级 Magpie').props.disabled, true);
  client.states[0].backend.supported = false;
  assert.equal(button(client.render(), '检查更新').props.disabled, true);
  client.states[0].backend.operation = { phase: 'failed', running: false, reason: '请先退出 Magpie' };
  assert.ok(nodes(client.render(), (n) => n.props.role === 'alert').some((n) => n.children.some((text) => typeof text === 'string' && text.includes('请先退出'))));
});
