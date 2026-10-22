import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { clientHarness, button, field, nodes } from '../fixtures/client.mjs';

const view = (config = {}) => ({ ok: true, config: resolveConfig(config), revision: 'revision-one', nativeProviders: ['magpie'], editable: true, keyConfigured: false, keyWritable: true });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('客户端模块、两个卡片入口和中英字典符合宿主契约', () => {
  const client = clientHarness(view());
  assert.equal(client.registration.id, '@zhiqiangme/dsh-magpie');
  assert.deepEqual(client.cards.map((x) => [x.meta.name, x.meta.key]), [['plugins.bundle.config', '@zhiqiangme/dsh-magpie'], ['plugins.row.config', '@zhiqiangme/dsh-magpie#dsh-magpie']]);
  assert.deepEqual(Object.keys(client.module.zh), Object.keys(client.module.en));
  assert.ok(Object.values(client.module.zh).every((value) => typeof value === 'string'));
  assert.equal(client.styles.length, 1);
  assert.ok(button(client.render(), '手动添加模型'));
  assert.ok(button(client.render(), '从 Magpie 导入'));
});

test('添加、编辑、调整顺序、取消勾选、删除通过卡片实际事件更新待保存清单', () => {
  const client = clientHarness(view({ models: [{ id: 'first' }] }));
  button(client.render(), '手动添加模型').props.onClick();
  let tree = client.render();
  const ids = nodes(tree, (node) => node.type === 'input' && node.props.placeholder === 'provider/model-id');
  ids[1].props.onChange({ target: { value: 'manual/second' } });
  tree = client.render();
  const ups = nodes(tree, (node) => node.type === 'button' && node.props['aria-label'] === '上移');
  ups[1].props.onClick();
  assert.equal(client.states[0].config.models[0].id, 'manual/second');
  button(client.render(), '取消全选').props.onClick();
  assert.ok(client.states[0].config.models.every((m) => m.enabled === false));
  button(client.render(), '删除').props.onClick();
  assert.equal(client.states[0].config.models.length, 1);
  assert.equal(client.states[0].config.models[0].id, 'first');
});

test('重复导入不覆盖手工名称、能力、勾选或顺序；新模型默认不勾选', async () => {
  const client = clientHarness(view({ models: [{ id: 'manual/a', name: '手工名称', enabled: true }, { id: 'missing/upstream' }] }), async () => response({ ok: true, models: [{ id: 'manual/a', name: '上游新名称', enabled: false }, { id: 'new/b', name: '新增', enabled: false, input: ['text'], reasoningEfforts: [] }] }));
  await button(client.render(), '从 Magpie 导入').props.onClick();
  const list = client.states[0].config.models;
  assert.deepEqual(list.map((m) => m.id), ['manual/a', 'missing/upstream', 'new/b']);
  assert.equal(list[0].name, '手工名称');
  assert.equal(list[0].enabled, true);
  assert.equal(list[2].enabled, false);
  assert.equal(client.states[1], true);
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
});

test('紧凑行的勾选框位于显示名称左侧，下拉按钮控制原位详情，开关不改变模型选择', () => {
  const client = clientHarness(view({ models: [{ id: 'a', name: 'Step-5-Preview' }, { id: 'b', name: 'Next' }] }));
  const row = nodes(client.render(), (n) => n.props.className === 'model-header')[0];
  assert.equal(row.children[0].type, 'label');
  assert.equal(row.children[0].children[0].props.type, 'checkbox');
  assert.equal(row.children[0].children[1].children[0], 'Step-5-Preview');
  assert.equal(row.children[1].props.className, 'model-toggle');
  assert.equal(row.children[1].props['aria-expanded'], false);
  row.children[1].props.onClick();
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
  const up = nodes(client.render(), (n) => n.type === 'button' && n.props['aria-label'] === '上移')[1];
  up.props.onClick();
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
