import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { PROVIDER_NAMES, sortModelIndexes as serverSort } from '../lib/names.js';
import { ModelManager } from '../lib/runtime.js';
import { clientHarness, button, choose, control, field, nodes } from '../fixtures/client.mjs';
import { fakeHost } from '../fixtures/host.mjs';

const view = (config = {}) => ({ ok: true, config: resolveConfig(config), revision: 'revision-one', providerNames: PROVIDER_NAMES, nativeProviders: ['magpie'], editable: true, keyConfigured: false, keyWritable: true });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const handles = (tree) => nodes(tree, (n) => n.props.className === 'model-drag');
const modelRows = (tree) => nodes(tree, (n) => n.props.className?.split(' ').includes('model'));
// 拖放事件替身：count 行、每行高 38、行距 2，指针落在第 slot 个空隙（0 为第一行之前，count 为最后一行之后）。
function dragEvent(slot = 0, count = 0) {
  const children = Array.from({ length: count }, (_v, i) => ({ offsetTop: i * 40, offsetHeight: 38 }));
  return {
    clientY: slot * 40 + 5, prevented: false,
    preventDefault() { this.prevented = true; },
    dataTransfer: { setData() {}, setDragImage() {} },
    currentTarget: { getBoundingClientRect: () => ({ top: 0 }), children, contains: () => false, closest: (selector) => selector === '.model-list' ? { children } : null },
  };
}
const list = (tree) => nodes(tree, (n) => n.props.className?.split(' ').includes('model-list'))[0];
function dragModel(client, from, to, after = false) {
  const count = modelRows(client.render()).length;
  handles(client.render())[from].props.onDragStart(dragEvent(0, count));
  list(client.render()).props.onDragOver(dragEvent(to + Number(after), count));
  list(client.render()).props.onDrop(dragEvent(to + Number(after), count));
}

test('客户端模块、两个卡片入口和中英字典符合宿主契约', () => {
  const client = clientHarness(view());
  assert.equal(client.registration.id, '@zhiqiangme/dsh-magpie');
  assert.deepEqual(client.cards.map((x) => [x.meta.name, x.meta.key]), [['plugins.bundle.config', '@zhiqiangme/dsh-magpie'], ['plugins.row.config', '@zhiqiangme/dsh-magpie#dsh-magpie']]);
  assert.deepEqual(Object.keys(client.module.zh), Object.keys(client.module.en));
  assert.ok(Object.values(client.module.zh).every((value) => typeof value === 'string'));
  assert.equal(client.styles.length, 1);
  // 贴底的保存栏保留底部圆角，圆角外侧用页面底色的外阴影盖住下面延续的卡片。
  assert.match(client.styles[0], /\.foot\[data-docked\]\{(?![^}]*border-radius)[^}]*border:1px solid[^}]*box-shadow:0 6px 0 6px var\(--dsw-alias-bg-base/);
  assert.ok(button(client.render(), '手动添加模型'));
  assert.ok(button(client.render(), '从 Magpie 同步'));
  assert.ok(button(client.render(), '按模型排序'));
  assert.ok(button(client.render(), '按供应商排序'));
  assert.equal(control(client.render(), '按模型分类').type, 'select');
  assert.equal(control(client.render(), '按供应商分类').type, 'select');
});

test('开关和选项改完立即保存，只提交该项；未保存的连接设置与模型草稿保留，后续保存使用新版本号', async () => {
  const calls = [];
  let saved = resolveConfig({ models: [{ id: 'a/one' }] });
  const client = clientHarness(view(saved), async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    saved = resolveConfig(body.action === 'patch' ? { ...saved, ...body.patch } : body.config);
    return response({ ...view(saved), revision: `revision-${calls.length + 1}`, ...(body.patch?.syncEnabled !== undefined || body.action === 'save' ? { sync: { ok: true, count: 1 } } : {}) });
  });
  const toggle = (label) => control(client.render(), label);
  // 先在连接页留一份未保存的草稿。
  client.tab('连接');
  field(client.render(), 'Magpie 网关地址').props.onChange({ target: { value: 'http://127.0.0.1:4000' } });
  assert.equal(client.states[1], true);
  client.tab('偏好');
  assert.equal(toggle('退出 DSH 时关闭 Magpie').props.checked, false);
  assert.equal(toggle('退出 DSH 时关闭 Magpie').props.role, 'switch');
  await toggle('退出 DSH 时关闭 Magpie').props.onChange({ target: { checked: true } });
  assert.deepEqual(calls[0], { action: 'patch', patch: { closeOnExit: true }, revision: 'revision-one' });
  assert.equal(toggle('退出 DSH 时关闭 Magpie').props.checked, true);
  assert.equal(client.states[1], true, '草稿仍待保存');
  assert.equal(client.states[0].revision, 'revision-2');
  // 开机启动、自动轻量模式默认开启，关闭即保存。
  assert.equal(toggle('启动 DSH 时打开 Magpie').props.checked, true);
  await toggle('启动 DSH 时打开 Magpie').props.onChange({ target: { checked: false } });
  assert.deepEqual(calls[1].patch, { autoStart: false });
  assert.equal(toggle('自动开启轻量模式').props.checked, true);
  await toggle('自动开启轻量模式').props.onChange({ target: { checked: false } });
  assert.deepEqual(calls[2].patch, { autoLightweight: false });
  assert.equal(choose(client.render(), '侧边栏入口', '自动').props['aria-checked'], true);
  // 点当前选项不发请求。
  assert.equal(choose(client.render(), '侧边栏入口', '自动').props.onClick(), undefined);
  await choose(client.render(), '侧边栏入口', '显示').props.onClick();
  assert.deepEqual(calls[3].patch, { sidebarEntry: 'always' });
  assert.equal(choose(client.render(), '侧边栏入口', '显示').props['aria-checked'], true);
  client.tab('模型');
  await toggle('同步到 DSH').props.onChange({ target: { checked: true } });
  assert.deepEqual(calls[4].patch, { syncEnabled: true });
  // 保存并同步带上最新版本号和全部即时项，连接草稿一起提交。
  client.tab('连接');
  assert.equal(field(client.render(), 'Magpie 网关地址').props.value, 'http://127.0.0.1:4000', '草稿保留');
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(calls[5].action, 'save');
  assert.equal(calls[5].revision, 'revision-6');
  assert.equal(calls[5].config.baseURL, 'http://127.0.0.1:4000');
  assert.deepEqual([calls[5].config.closeOnExit, calls[5].config.autoStart, calls[5].config.autoLightweight, calls[5].config.sidebarEntry, calls[5].config.syncEnabled], [true, false, false, 'always', true]);
});

test('自动更新开关在更新页即时保存，等待期间也能关闭，保留未保存草稿', async () => {
  const host = fakeHost({ models: [{ id: 'saved-model' }] });
  const operation = { id: 'auto', phase: 'waiting-idle', running: true, received: 12, total: 12 };
  const backend = { describe: async () => ({ supported: true, installed: true, operation }), settings: () => ({ available: false }) };
  const manager = new ModelManager(host.ctx, {}, { env: {}, backend });
  const client = clientHarness(await manager.describe(), async (_url, options) => response(await manager.handle(JSON.parse(options.body))));
  client.tab('连接');
  field(client.render(), 'Magpie 网关地址').props.onChange({ target: { value: 'http://127.0.0.1:4000' } });
  client.tab('更新');
  const toggle = () => control(client.render(), '自动更新 Magpie 程序');
  assert.equal(toggle().props.checked, true);
  assert.equal(toggle().props.disabled, false);
  assert.match(JSON.stringify(client.render()), /等待所有对话空闲后升级/);
  assert.equal(button(client.render(), '检查更新').props.disabled, true);
  await toggle().props.onChange({ target: { checked: false } });
  assert.equal(host.own.options.config.autoUpdate, false);
  assert.equal(client.states[0].config.baseURL, 'http://127.0.0.1:4000');
  assert.equal(client.states[1], true);
  assert.deepEqual(host.own.options.config.models.map((m) => m.id), ['saved-model']);
  assert.equal(toggle().props.checked, false);
  for (const [phase, message] of [['waiting-status', '无法确认对话状态'], ['cooling-down', '发布未满 30 分钟'], ['invalid-release-date', '无法确认版本发布时间'], ['cancelled', '自动升级已取消']]) {
    Object.assign(operation, { phase, eligibleAt: Date.parse('2026-10-25T00:30:00Z') });
    assert.ok(JSON.stringify(client.render()).includes(message));
  }
});

test('旧页面切换即时开关后仍拒绝保存，保留草稿和其它页面的新清单', async (t) => {
  for (const dirty of [false, true]) await t.test(dirty ? '有未保存草稿' : '未编辑旧清单', async () => {
    const host = fakeHost({ models: [{ id: 'old-model' }] });
    const backend = { describe: async () => ({}), settings: () => ({ available: false }) };
    const manager = new ModelManager(host.ctx, host.own.options.config, { env: {}, backend });
    const initial = await manager.describe();
    const client = clientHarness(initial, async (_url, options) => {
      try { return response(await manager.handle(JSON.parse(options.body))); }
      catch (error) { return response({ ok: false, reason: error.message }, error.status ?? 400); }
    });
    if (dirty) {
      client.tab('连接');
      field(client.render(), 'Magpie 网关地址').props.onChange({ target: { value: 'http://127.0.0.1:4000' } });
      field(client.render(), '网关 Key').props.onChange({ target: { value: 'draft-key' } });
    }
    const draft = structuredClone(client.states[0].config);
    await manager.handle({ action: 'save', revision: initial.revision, config: { ...initial.config, models: [{ id: 'other-page-model' }] } });
    const latest = structuredClone(host.own.options.config);
    client.tab('偏好');
    await control(client.render(), '退出 DSH 时关闭 Magpie').props.onChange({ target: { checked: true } });
    assert.match(client.states[3]?.text ?? '', /其它页面/);
    assert.equal(client.states[0].revision, initial.revision, '不能把最新版本号套到旧草稿上');
    assert.deepEqual(client.states[0].config, draft);
    assert.equal(client.states[1], dirty);
    assert.equal(client.states[4], dirty ? 'draft-key' : '');
    assert.deepEqual(host.own.options.config, latest, '冲突时开关也不写入');
    await button(client.render(), '保存并同步').props.onClick();
    assert.match(client.states[3]?.text ?? '', /其它页面/);
    assert.deepEqual(client.states[0].config, draft);
    assert.deepEqual(host.own.options.config, latest);
    assert.equal(host.keys.size, 0);
  });
});

test('防止休眠直接写入 Magpie 设置；没有设置文件时禁用；打开 Magpie 界面按当前程序路径请求', async () => {
  const calls = [];
  const client = clientHarness({ ...view(), magpieSettings: { available: false }, backend: { supported: true, installed: true, version: '0.1.2' } }, async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === 'magpie-settings') return response({ ok: true, magpieSettings: { available: true, lightweight: true, keepAwake: body.keepAwake } });
    return response({ ok: true, backend: { supported: true, installed: true, version: '0.1.2' }, magpieSettings: { available: true, lightweight: true, keepAwake: 'off' } });
  });
  client.tab('偏好');
  assert.equal(choose(client.render(), '防止休眠', '开启').props.disabled, true);
  await button(client.render(), '打开 Magpie 界面').props.onClick();
  assert.deepEqual(calls[0], { action: 'backend-open', magpiePath: '' });
  assert.equal(client.states[3].text, '已打开 Magpie 窗口。');
  assert.equal(choose(client.render(), '防止休眠', '关闭').props['aria-checked'], true);
  await choose(client.render(), '防止休眠', '屏幕也常亮').props.onClick();
  assert.deepEqual(calls[1], { action: 'magpie-settings', keepAwake: 'display' });
  assert.equal(choose(client.render(), '防止休眠', '屏幕也常亮').props['aria-checked'], true);
  assert.equal(client.states[1], false, '不产生待保存改动');
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
  // first 是已保存勾选，取消全选后仍在置顶区；第一个删除按钮属于 first。
  button(client.render(), '删除').props.onClick();
  assert.equal(client.states[0].config.models.length, 1);
  assert.equal(client.states[0].config.models[0].id, 'manual/second');
});

test('从 Magpie 同步立即提交并用已保存的全量结果替换草稿，重置筛选和展开', async () => {
  let posted;
  const client = clientHarness(view({ models: [{ id: 'workbuddy/old', name: '旧模型' }, { id: 'manual/a' }] }), async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...view({ syncEnabled: true, models: [{ id: 'new/b', name: '新增', enabled: false }, { id: 'manual/a', name: '上游新名称', enabled: true }] }), saved: true, sync: { ok: true, count: 1 } });
  });
  field(client.render(), '显示名称').props.onChange({ target: { value: '未保存名称' } });
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: '未保存名称' } });
  nodes(client.render(), (n) => n.props.className === 'model-toggle')[0].props.onClick();
  control(client.render(), '按供应商分类').props.onChange({ target: { value: 'workbuddy' } });
  await button(client.render(), '从 Magpie 同步').props.onClick();
  assert.equal(posted.action, 'sync-catalog');
  assert.equal(posted.revision, 'revision-one');
  assert.equal(posted.config.models[0].name, '未保存名称');
  const list = client.states[0].config.models;
  assert.deepEqual(list.map((m) => m.id), ['new/b', 'manual/a']);
  assert.equal(list[1].name, '上游新名称');
  assert.equal(list[0].enabled, false, '同步新出现的模型不默认勾选');
  assert.equal(list[1].enabled, true, '已有模型保留勾选');
  assert.equal(client.states[1], false);
  assert.equal(client.states[5], '');
  assert.equal(control(client.render(), '按供应商分类').props.value, '', '全量同步后恢复全部供应商');
  assert.deepEqual([...client.states[6]], []);
  assert.match(client.states[3].text, /覆盖保存.*1/);
});

test('已勾选模型稳定置顶，取消已保存项后保存才下移，新勾选撤销后回到原分组', async () => {
  let posted;
  const initial = view({ models: [{ id: 'a', enabled: false }, { id: 'b' }, { id: 'c' }, { id: 'd', enabled: false }] });
  const client = clientHarness(initial, async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...initial, config: resolveConfig(posted.config), revision: 'revision-two', sync: { ok: true, count: 1 } });
  });
  const labels = () => nodes(client.render(), (n) => n.props.className === 'model-select');
  const order = () => labels().map((n) => n.props.title).join('');
  const toggle = (id, checked) => labels().find((n) => n.props.title === id).children[0].props.onChange({ target: { checked } });

  assert.equal(order(), 'bcad', '已保存勾选在首次渲染时置顶');
  toggle('b', false);
  assert.equal(order(), 'bcad', '取消已保存项后、保存前不移动');
  toggle('d', true);
  assert.equal(order(), 'bcda', '新勾选立即置顶');
  toggle('d', false);
  assert.equal(order(), 'bcad', '未保存的新勾选撤销后回到未置顶区');
  await button(client.render(), '保存并同步').props.onClick();
  assert.deepEqual(posted.config.models.map((m) => [m.id, m.enabled]), [['a', false], ['b', false], ['c', true], ['d', false]]);
  assert.equal(order(), 'cabd', '保存后才取消 b 的置顶');
});

test('即时设置返回新快照后，待保存取消项仍保持置顶', async () => {
  let saved = resolveConfig({ models: [{ id: 'a', enabled: false }, { id: 'b' }, { id: 'c' }, { id: 'd', enabled: false }] });
  const client = clientHarness(view(saved), async (_url, options) => {
    const body = JSON.parse(options.body);
    saved = resolveConfig({ ...saved, ...body.patch });
    return response({ ...view(saved), revision: 'revision-two', sync: { ok: true, count: 2 } });
  });
  const labels = () => nodes(client.render(), (n) => n.props.className === 'model-select');
  const order = () => labels().map((n) => n.props.title).join('');
  labels().find((n) => n.props.title === 'b').children[0].props.onChange({ target: { checked: false } });
  assert.equal(order(), 'bcad');
  await control(client.render(), '同步到 DSH').props.onChange({ target: { checked: true } });
  assert.equal(order(), 'bcad', '已保存行对象重建也不能让取消项提前下移');
  assert.equal(labels().find((n) => n.props.title === 'b').children[0].props.checked, false);
  assert.equal(client.states[1], true, '模型勾选草稿仍未保存');
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
  client.tab('连接');
  field(client.render(), '网关 Key').props.onChange({ target: { value: 'sensitive' } });
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(client.states[1], false);
  assert.equal(client.states[4], '');
  assert.match(client.states[3].text, /清单已保存.*服务未就绪/);
  assert.equal(client.states[3].error, true);
});

test('Key 为只读或配置服务未就绪时相应控件禁用', () => {
  const client = clientHarness({ ...view(), keyWritable: false, editable: false });
  client.tab('连接');
  assert.equal(field(client.render(), '网关 Key').props.disabled, true);
  assert.equal(button(client.render(), '保存并同步').props.disabled, true);
  client.tab('模型');
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
  const initial = view({ models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  const client = clientHarness(initial, async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...initial, config: resolveConfig(posted.config), sync: { ok: true, count: 3 } });
  });
  // 已保存项取消后仍留在原位置，便于继续拖动；保存时才按新的勾选状态重排。
  nodes(client.render(), (n) => n.props.className === 'model-select')[0].children[0].props.onChange({ target: { checked: false } });
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

test('置顶改变可见顺序后，拖放仍按落点调整同一置顶区内的顺序', () => {
  const client = clientHarness(view({ models: [{ id: 'a', enabled: false }, { id: 'b' }, { id: 'c', enabled: false }, { id: 'd' }] }));
  const order = () => nodes(client.render(), (n) => n.props.className === 'model-select').map((n) => n.props.title).join('');
  assert.equal(order(), 'bdac');
  dragModel(client, 0, 1, true);
  assert.equal(order(), 'dbac', 'b 拖到同为已勾选的 d 后面');
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['a', 'c', 'd', 'b']);
  dragModel(client, 2, 3, true);
  assert.equal(order(), 'dbca', '未置顶区也按可见落点移动');
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['c', 'a', 'd', 'b']);
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
  const foreign = dragEvent(1, 2);
  list(client.render()).props.onDragOver(foreign);
  list(client.render()).props.onDrop(foreign);
  assert.equal(foreign.prevented, false);
  handles(client.render())[0].props.onDragStart(dragEvent(0, 2));
  list(client.render()).props.onDragOver(dragEvent(2, 2));
  // 拖到末尾：被拖的行下移到落点（越过下一行 38），下一行上移让出被拖行连同行距的 40。
  assert.match(modelRows(client.render())[0].props.className, /dragging/);
  assert.match(list(client.render()).props.className, /sorting/);
  assert.deepEqual(modelRows(client.render()).map((n) => n.props.style?.transform), ['translateY(38px)', 'translateY(-40px)']);
  handles(client.render())[0].props.onDragEnd();
  // 取消后先滑回原位，再清除拖动状态。
  assert.deepEqual(modelRows(client.render()).map((n) => n.props.style), [undefined, undefined]);
  list(client.render()).props.onDrop(dragEvent(1, 2));
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
  const stale = dragEvent(1, 3);
  list(client.render()).props.onDrop(stale);
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
    { id: 'zcode/ten', name: 'Model 10', input: ['text', 'image'], contextWindow: 1000000 },
    { id: 'workbuddy-ai/two', name: 'Model 2 WorkBuddy GL' },
    { id: 'opencode-zen-free/two', name: 'Model 2' },
    { id: 'workbuddy/one', name: 'Model 1' },
    { id: 'qoder-cn/ten', name: 'Model 10' },
  ] });
  const client = clientHarness(initial, async (_url, options) => {
    posted = JSON.parse(options.body);
    return response({ ...initial, config: resolveConfig(posted.config), sync: { ok: true, count: 4 } });
  });
  // 取消的是已保存勾选，保存前仍保持原位置，不影响这组排序与展开状态断言。
  nodes(client.render(), (n) => n.props.className === 'model-select')[0].children[0].props.onChange({ target: { checked: false } });
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

test('按模型系列或供应商下拉筛选，只显示当前类别，可组合、清除并继续排序', () => {
  const client = clientHarness(view({ models: [
    { id: 'workbuddy/deepseek-pro', name: 'DeepSeek-V4-Pro', enabled: false },
    { id: 'qoder-cn/deepseek-flash', name: 'DeepSeek-Flash', enabled: false },
    { id: 'workbuddy/glm', name: 'GLM-5.3', enabled: false },
    { id: 'opencode-zen-free/glm-flash', name: 'GLM-5.3-Flash', enabled: false },
    { id: 'opencode-zen-free/deepseek-free', name: 'DeepSeek V4.1 Flash Free', enabled: false },
    { id: 'local-model', name: 'Local', enabled: false },
  ] }));
  const original = client.states[0].config.models;
  const ids = () => nodes(client.render(), (n) => n.props.className === 'model-select').map((n) => n.props.title);
  const options = (label) => nodes(control(client.render(), label), (n) => n.type === 'option').map((n) => n.children[0]);
  const chooseCategory = (label, value) => control(client.render(), label).props.onChange({ target: { value } });

  assert.deepEqual(options('按模型分类'), ['全部模型', 'DeepSeek', 'GLM', 'Local']);
  assert.deepEqual(options('按供应商分类'), ['全部供应商', 'OpenCode', 'Qoder', 'WorkBuddy', '未指定供应商']);
  chooseCategory('按模型分类', 'deepseek');
  assert.deepEqual(ids(), ['workbuddy/deepseek-pro', 'qoder-cn/deepseek-flash', 'opencode-zen-free/deepseek-free'], 'DeepSeek 跨供应商归为同一系列');
  assert.equal(client.states[0].config.models, original, '筛选不重写配置数组');
  assert.equal(client.states[1], false, '筛选不是待保存修改');
  assert.ok(handles(client.render()).every((n) => !n.props.disabled), '筛选后仍可拖动当前可见模型');

  chooseCategory('按供应商分类', 'qoder');
  assert.deepEqual(ids(), ['qoder-cn/deepseek-flash'], '模型系列与供应商筛选取交集');
  chooseCategory('按模型分类', '');
  assert.deepEqual(ids(), ['qoder-cn/deepseek-flash']);
  chooseCategory('按供应商分类', '');
  assert.equal(ids().length, 6, '恢复全部供应商');

  chooseCategory('按模型分类', 'glm');
  assert.deepEqual(ids(), ['workbuddy/glm', 'opencode-zen-free/glm-flash'], 'GLM 不同版本归为同一系列');
  chooseCategory('按供应商分类', 'opencode');
  assert.deepEqual(ids(), ['opencode-zen-free/glm-flash']);
  chooseCategory('按模型分类', '');
  assert.deepEqual(ids(), ['opencode-zen-free/glm-flash', 'opencode-zen-free/deepseek-free']);
  chooseCategory('按供应商分类', '');

  chooseCategory('按模型分类', 'deepseek');
  button(client.render(), '按模型排序').props.onClick();
  assert.equal(control(client.render(), '按模型分类').props.value, 'deepseek', '排序不会退出分类筛选');
  assert.deepEqual(ids(), ['qoder-cn/deepseek-flash', 'opencode-zen-free/deepseek-free', 'workbuddy/deepseek-pro']);
  assert.equal(nodes(client.render(), (n) => n.props.className === 'model-group').length, 0, '不再渲染分组标题');
  assert.equal(client.states[1], true, '只有真正的排序才产生待保存修改');
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
  assert.match(button(client.render(), '按模型排序').props.title, /当前搜索或分类结果/);
});

test('类别消失后真正清除筛选，同名类别再次出现也不会恢复旧筛选', () => {
  const client = clientHarness(view({ models: [
    { id: 'workbuddy/deepseek', name: 'DeepSeek-V4-Pro', enabled: false },
    { id: 'workbuddy/glm', name: 'GLM-5.3', enabled: false },
    { id: 'qoder-cn/kimi', name: 'Kimi-K3.1-Pro', enabled: false },
  ] }));
  const ids = () => nodes(client.render(), (n) => n.props.className === 'model-select').map((n) => n.props.title);
  control(client.render(), '按模型分类').props.onChange({ target: { value: 'deepseek' } });
  assert.deepEqual(ids(), ['workbuddy/deepseek']);
  button(client.render(), '删除').props.onClick();
  assert.equal(control(client.render(), '按模型分类').props.value, '');
  assert.deepEqual(ids(), ['workbuddy/glm', 'qoder-cn/kimi']);
  field(client.render(), '显示名称').props.onChange({ target: { value: 'DeepSeek-V4-Pro' } });
  field(client.render(), '完整模型 ID').props.onChange({ target: { value: 'workbuddy/deepseek-new' } });
  assert.equal(control(client.render(), '按模型分类').props.value, '', 'DeepSeek 再次出现时仍保持全部模型');
  assert.deepEqual(ids(), ['workbuddy/deepseek-new', 'qoder-cn/kimi']);
});

test('分类筛选后的全选、取消全选和拖放只影响可见模型', () => {
  const client = clientHarness(view({ models: [
    { id: 'workbuddy/deepseek-a', name: 'DeepSeek-V4-A', enabled: false },
    { id: 'qoder-cn/glm', name: 'GLM-5.3', enabled: false },
    { id: 'opencode-zen-free/deepseek-b', name: 'DeepSeek-V4-B', enabled: false },
    { id: 'workbuddy/other', name: 'Other', enabled: false },
  ] }));
  control(client.render(), '按模型分类').props.onChange({ target: { value: 'deepseek' } });
  button(client.render(), '全选').props.onClick();
  assert.deepEqual(client.states[0].config.models.map((m) => m.enabled), [true, false, true, false]);
  button(client.render(), '取消全选').props.onClick();
  assert.ok(client.states[0].config.models.every((m) => !m.enabled));
  dragModel(client, 1, 0);
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['opencode-zen-free/deepseek-b', 'workbuddy/deepseek-a', 'qoder-cn/glm', 'workbuddy/other'], '隐藏项随源项让位且不丢失、相对顺序不变');
  assert.equal(control(client.render(), '按模型分类').props.value, 'deepseek');
  assert.deepEqual(nodes(client.render(), (n) => n.props.className === 'model-select').map((n) => n.props.title), ['opencode-zen-free/deepseek-b', 'workbuddy/deepseek-a']);
});

test('模型系列按版本号前的品牌识别，兼容无分隔版本和子系列命名', () => {
  const { modelFamilyName } = clientHarness().module;
  for (const [name, family] of [
    ['DeepSeek V4.1 Flash', 'DeepSeek'], ['DeepSeek-V4-Pro', 'DeepSeek'],
    ['GLM-5.3', 'GLM'], ['GLM-5v-Turbo', 'GLM'], ['Hy4 CN', 'Hy'],
    ['Kimi-K3.1-Pro', 'Kimi'], ['Step-5-Preview', 'Step'], ['Claude-Sonnet-4.5', 'Claude'], ['', ''],
  ]) assert.equal(modelFamilyName(name), family, name || '空白模型');
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
  // 服务端同步后的排序必须与卡片按钮一致。
  for (const mode of ['model', 'provider']) assert.deepEqual(serverSort(rows, mode), client.module.sortModelIndexes(rows, mode, PROVIDER_NAMES));
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
  client.tab('更新');
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
  client.tab('更新');
  assert.equal(button(client.render(), '升级 Magpie').props.disabled, false);
  client.states[0].backend.updateAvailable = false;
  assert.equal(button(client.render(), '升级 Magpie').props.disabled, true);
  client.states[0].backend.supported = false;
  assert.equal(button(client.render(), '检查更新').props.disabled, true);
  client.states[0].backend.operation = { phase: 'failed', running: false, reason: '请先退出 Magpie' };
  assert.ok(nodes(client.render(), (n) => n.props.role === 'alert').some((n) => n.children.some((text) => typeof text === 'string' && text.includes('请先退出'))));
});

test('拖动或按供应商排序标记为手动顺序并提示；不搜索时按模型排序恢复自动排序', () => {
  // 名称顺序 Alpha/Beta/Gamma 与供应商顺序 Qoder/Trae/WorkBuddy 不同，两种排序都会真正改变顺序。
  const models = [{ id: 'workbuddy/x', name: 'Alpha' }, { id: 'qoder-cn/y', name: 'Beta' }, { id: 'trae-cn/z', name: 'Gamma' }];
  const client = clientHarness(view({ models }));
  const hint = () => nodes(client.render(), (n) => n.type === 'p' && n.children.includes(client.module.zh.manualOrder)).length;
  assert.equal(hint(), 0);
  dragModel(client, 0, 2, true);
  assert.equal(client.states[0].config.manualOrder, true);
  assert.equal(hint(), 1);
  button(client.render(), '按模型排序').props.onClick();
  assert.equal(client.states[0].config.manualOrder, false);
  assert.deepEqual(client.states[0].config.models.map((m) => m.name), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(hint(), 0);
  button(client.render(), '按供应商排序').props.onClick();
  assert.deepEqual(client.states[0].config.models.map((m) => m.name), ['Beta', 'Gamma', 'Alpha']);
  assert.equal(client.states[0].config.manualOrder, true);
  // 只排部分搜索结果仍是手动顺序：搜索 e 只命中 Beta、Gamma。
  const partial = clientHarness(view({ models: [models[0], models[2], models[1]] }));
  nodes(partial.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'e' } });
  button(partial.render(), '按模型排序').props.onClick();
  assert.deepEqual(partial.states[0].config.models.map((m) => m.name), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(partial.states[0].config.manualOrder, true);
});

test('已是模型顺序但标记为手动时，按模型排序只清除标记并进入待保存', () => {
  const client = clientHarness(view({ manualOrder: true, models: [{ id: 'qoder-cn/a', name: 'Alpha' }, { id: 'trae-cn/b', name: 'Beta' }] }));
  const original = client.states[0].config.models;
  button(client.render(), '按模型排序').props.onClick();
  assert.equal(client.states[0].config.models, original);
  assert.equal(client.states[0].config.manualOrder, false);
  assert.equal(client.states[1], true);
});

test('侧栏入口显示规则：自动模式仅在没有模型时显示，固定模式不看清单，正在查看时保留，配置未知不显示', () => {
  const { sidebarVisible } = clientHarness(view()).module;
  const model = { id: 'openai/gpt-5', name: 'GPT-5' };
  assert.equal(sidebarVisible(undefined, false), false);
  assert.equal(sidebarVisible(undefined, true), true);
  assert.equal(sidebarVisible(resolveConfig({}), false), true);
  assert.equal(sidebarVisible(resolveConfig({ models: [model] }), false), false);
  assert.equal(sidebarVisible(resolveConfig({ models: [model] }), true), true);
  assert.equal(sidebarVisible(resolveConfig({ sidebarEntry: 'always', models: [model] }), false), true);
  assert.equal(sidebarVisible(resolveConfig({ sidebarEntry: 'never' }), false), false);
  assert.equal(resolveConfig({}).sidebarEntry, 'auto');
  assert.throws(() => resolveConfig({ sidebarEntry: 'hidden' }), /侧边栏入口/);
});

test('宿主声明侧栏槽位时注册整页和入口行；保存模型后自动隐藏，改为始终显示或隐藏立即生效', async () => {
  const model = { id: 'openai/gpt-5', name: 'GPT-5' };
  const posts = [];
  let saved = resolveConfig();
  const client = clientHarness(view(), async (_url, options) => {
    if (options?.method !== 'POST') return response(view());
    const body = JSON.parse(options.body);
    posts.push(body);
    saved = resolveConfig(body.action === 'patch' ? { ...saved, ...body.patch } : body.config);
    return response({ ...view(saved), sync: { ok: true, count: saved.models.length } });
  }, { sidebar: true });
  const page = client.cards.find((x) => x.meta.name === 'main');
  assert.equal(page.meta.key, 'dsh-magpie');
  assert.equal(page.component, client.module.MagpiePage);
  // 读到已保存配置前不显示入口。
  assert.equal(client.cards.some((x) => x.meta.name === 'sidebar.panellist'), false);
  await new Promise((done) => setImmediate(done));
  const rows = () => client.cards.filter((x) => x.meta.name === 'sidebar.panellist' && !x.disposed);
  assert.equal(rows().length, 1);
  assert.deepEqual([rows()[0].meta.id, rows()[0].meta.order, rows()[0].meta.label()], ['dsh-magpie', 2, 'Magpie']);
  assert.equal(rows()[0].component, client.module.MagpieGlyph);

  const option = (label) => choose(client.render(), '侧边栏入口', label);
  client.tab('偏好');
  assert.equal(option('自动').props['aria-checked'], true);
  client.tab('模型');
  button(client.render(), '手动添加模型').props.onClick();
  client.states[0] = { ...client.states[0], config: { ...client.states[0].config, models: [{ ...model, enabled: true, input: ['text'], reasoningEfforts: [] }] } };
  // 草稿不影响入口，保存后才按已保存清单隐藏。
  assert.equal(rows().length, 1);
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(posts[0].config.sidebarEntry, 'auto');
  assert.equal(rows().length, 0);

  client.tab('偏好');
  await option('显示').props.onClick();
  assert.deepEqual(posts[1], { action: 'patch', patch: { sidebarEntry: 'always' }, revision: 'revision-one' });
  assert.equal(rows().length, 1);
  await option('隐藏').props.onClick();
  assert.equal(rows().length, 0);
});

test('正在查看 Magpie 页面时保存模型不收起入口，离开后再隐藏', async () => {
  const listeners = new Set();
  let active = null;
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: active }), subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } }, selectPanel: (id) => { active = id; } };
  const model = { id: 'openai/gpt-5', name: 'GPT-5', enabled: true, input: ['text'], reasoningEfforts: [] };
  const client = clientHarness(view(), async (_url, options) => {
    if (options?.method !== 'POST') return response(view());
    const body = JSON.parse(options.body);
    return response({ ...view(body.config), sync: { ok: true, count: 1 } });
  }, { sidebar: true, layout });
  await new Promise((done) => setImmediate(done));
  const rows = () => client.cards.filter((x) => x.meta.name === 'sidebar.panellist' && !x.disposed);
  active = 'dsh-magpie';
  for (const listener of listeners) listener();
  client.states[0] = { ...client.states[0], config: { ...client.states[0].config, models: [model] } };
  client.states[1] = true;
  await button(client.render(), '保存并同步').props.onClick();
  assert.equal(rows().length, 1);
  active = null;
  for (const listener of listeners) listener();
  assert.equal(rows().length, 0);
});

test('标题显示网关与程序状态，程序状态可跳到更新页；标签页切换内容，模型页显示数量', () => {
  const client = clientHarness({ ...view({ models: [{ id: 'a/one' }, { id: 'b/two' }] }), backend: { supported: true, installed: true, version: '0.1.1', latest: { version: '0.1.2' }, updateAvailable: true } });
  const chips = () => nodes(client.render(), (n) => n.props.className?.split(' ').includes('chip'));
  const label = (node) => node.children.flat().map((c) => typeof c === 'string' ? c : c?.children?.join('') ?? '').join('');
  assert.match(label(chips()[0]), /正在检查网关/);
  // 网关状态在更新区块之后的状态位。
  client.states[11] = { online: true, version: '0.1.1' };
  assert.equal(chips()[0].props.className, 'chip ok');
  assert.match(label(chips()[0]), /网关在线 0\.1\.1/);
  client.states[11] = { online: false };
  assert.match(label(chips()[0]), /网关未连接/);
  assert.match(label(chips()[1]), /Magpie 0\.1\.1.*可升级到 0\.1\.2/);
  const tabs = () => nodes(client.render(), (n) => n.props.role === 'tab');
  assert.deepEqual(tabs().map((n) => n.props['aria-selected']), [true, false, false, false]);
  assert.equal(tabs()[0].children[1].children[0], 2);
  assert.ok(tabs()[3].children[2], '有可升级版本时更新页带标记');
  chips()[1].props.onClick();
  assert.deepEqual(tabs().map((n) => n.props['aria-selected']), [false, false, false, true]);
  assert.ok(button(client.render(), '升级 Magpie'));
  assert.equal(button(client.render(), '从 Magpie 同步'), undefined);
});

test('默认排序按 Magpie 目录顺序排列，目录外的模型保持相对顺序排在后面；完整清单记为目录顺序，搜索时只算手动', async () => {
  const requests = [];
  const ids = ['p/c', 'p/a', 'p/b'];
  const client = clientHarness(view({ models: ['p/a', 'local/x', 'p/b', 'p/c', 'local/y'].map((id) => ({ id })) }), async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response({ ok: true, ids });
  });
  const hint = () => nodes(client.render(), (n) => n.type === 'p' && n.children.includes(client.module.zh.catalogOrder)).length;
  assert.equal(hint(), 0);
  await button(client.render(), '默认排序').props.onClick();
  assert.deepEqual(requests[0], { action: 'catalog-order', baseURL: 'http://127.0.0.1:3425' });
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['p/c', 'p/a', 'p/b', 'local/x', 'local/y']);
  assert.deepEqual([client.states[0].config.catalogOrder, client.states[0].config.manualOrder], [true, false]);
  assert.equal(client.states[1], true);
  assert.equal(hint(), 1);
  // 再按模型排序回到自动（名称）顺序。
  button(client.render(), '按模型排序').props.onClick();
  assert.deepEqual([client.states[0].config.catalogOrder, client.states[0].config.manualOrder], [false, false]);
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'p/' } });
  await button(client.render(), '默认排序').props.onClick();
  // 按模型排序后为 a、b、c、x、y；只重排可见的 p/ 三项，local 两项位置不动。
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['p/c', 'p/a', 'p/b', 'local/x', 'local/y']);
  assert.deepEqual([client.states[0].config.catalogOrder, client.states[0].config.manualOrder], [false, true]);
});

test('默认排序的目录外模型按原始配置顺序兜底，不受置顶显示影响', async () => {
  const client = clientHarness(view({ models: [{ id: 'local/a', enabled: false }, { id: 'local/b' }] }), async () => response({ ok: true, ids: [] }));
  const original = client.states[0].config.models;
  const order = () => nodes(client.render(), (n) => n.props.className === 'model-select').map((n) => n.props.title);
  assert.deepEqual(order(), ['local/b', 'local/a'], '已勾选的 b 在展示中置顶');
  await button(client.render(), '默认排序').props.onClick();
  assert.equal(client.states[0].config.models, original, '目录外模型仍保持原配置数组和顺序');
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['local/a', 'local/b']);
  assert.deepEqual(order(), ['local/b', 'local/a'], '仅目录顺序标记变化，不改变置顶展示');
  assert.equal(client.states[0].config.catalogOrder, true);
});

test('默认排序读取失败时显示原因，不改草稿', async () => {
  const client = clientHarness(view({ models: [{ id: 'p/b' }, { id: 'p/a' }] }), async () => response({ ok: false, reason: 'connect ECONNREFUSED' }, 502));
  const before = client.states[0].config.models;
  await button(client.render(), '默认排序').props.onClick();
  assert.equal(client.states[0].config.models, before);
  assert.match(client.states[3].text, /ECONNREFUSED/);
  assert.equal(client.states[1], false);
});

test('拖动手柄可用上下方向键移动，搜索时跳过隐藏模型，首尾不再移动', () => {
  const client = clientHarness(view({ models: ['a', 'hidden', 'b', 'c'].map((id) => ({ id })) }));
  const key = (index, value) => { const event = { key: value, prevented: false, preventDefault() { this.prevented = true; } }; handles(client.render())[index].props.onKeyDown(event); return event; };
  assert.equal(key(0, 'ArrowUp').prevented, false);
  assert.equal(key(0, 'ArrowDown').prevented, true);
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['hidden', 'a', 'b', 'c']);
  assert.equal(client.states[0].config.manualOrder, true);
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: 'b' } });
  // 只剩 b 可见：没有相邻的可见模型。
  assert.equal(key(0, 'ArrowUp').prevented, false);
  nodes(client.render(), (n) => n.props.type === 'search')[0].props.onChange({ target: { value: '' } });
  key(3, 'ArrowUp');
  assert.deepEqual(client.states[0].config.models.map((m) => m.id), ['hidden', 'a', 'c', 'b']);
  assert.equal(key(0, 'Enter').prevented, false);
});

test('动效：减少动态效果时全关，滑块要求锚点定位，换页签与计数变化重建节点，只有被点的按钮转圈', async () => {
  let release;
  const client = clientHarness(view({ models: [{ id: 'a/one' }, { id: 'b/two', enabled: false }] }),
    () => new Promise((resolve) => { release = () => resolve(response({ ...view(), sync: { ok: true, count: 1 } })); }));
  const css = client.styles[0];
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.dsm-mp,[^}]*\{animation:none!important;transition:none!important\}\}/);
  const anchored = css.slice(css.indexOf('@supports (anchor-name:--a) and (anchor-scope:--a)'));
  assert.match(anchored, /anchor-scope:--dsm-mp-tab/);
  assert.match(anchored, /anchor-scope:--dsm-mp-seg/);
  assert.ok([...css.matchAll(/@keyframes ([\w-]+)/g)].every(([, name]) => name.startsWith('dsm-mp-')));
  const panel = () => nodes(client.render(), (n) => n.props.role === 'tabpanel')[0];
  const listCount = () => nodes(client.render(), (n) => n.props.className === 'count' && n.type === 'span')[1];
  assert.equal(panel().props.key, 'models');
  assert.equal(listCount().props.key, '1/2');
  nodes(client.render(), (n) => n.props.className === 'model-select')[1].children[0].props.onChange({ target: { checked: true } });
  assert.equal(listCount().props.key, '2/2');
  const saving = button(client.render(), '保存并同步').props.onClick();
  assert.equal(button(client.render(), '处理中…').props['aria-busy'], true);
  assert.equal(button(client.render(), '从 Magpie 同步').props['aria-busy'], false);
  assert.equal(button(client.render(), '从 Magpie 同步').props.disabled, true);
  release();
  await saving;
  assert.equal(button(client.render(), '保存并同步').props['aria-busy'], false);
  client.tab('偏好');
  assert.equal(panel().props.key, 'preferences');
});

test('程序路径与输入框或占位符相同时不重复显示，解析出不同路径时才列出', () => {
  const exe = resolve('Magpie.exe');
  const client = clientHarness({ ...view(), backend: { supported: true, installed: true, version: '0.1.1', path: exe, defaultPath: exe } });
  client.tab('更新');
  const pathLine = () => nodes(client.render(), (n) => n.props.className === 'hint backend-path');
  assert.equal(pathLine().length, 0);
  field(client.render(), 'Magpie 程序路径').props.onChange({ target: { value: exe } });
  client.states[0].backend.path = exe;
  assert.equal(pathLine().length, 0);
  client.states[0].config.magpiePath = resolve('portable');
  client.states[0].backend.path = resolve('portable', 'Magpie.exe');
  assert.deepEqual(pathLine()[0].children, [resolve('portable', 'Magpie.exe')]);
});

test('详情页把面板提到 README 上方，规则只作用于本插件', () => {
  assert.ok(clientHarness(view()).styles[0].includes('[data-plugin-detail="@zhiqiangme/dsh-magpie"] section[data-plugin-config]{order:-1}'));
});

test('详情页首次挂载面板时回到顶部，同页重新挂载不打断滚动', () => {
  const attach = clientHarness(view()).render().props.ref;
  const scroller = { scrollTop: 900, parentElement: null };
  const page = { parentElement: scroller };
  const card = { closest: (selector) => (selector === '[data-plugin-config]' ? page : null) };
  attach(card);
  assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 300;
  attach(card);
  assert.equal(scroller.scrollTop, 300, '同一页内重新挂载不动滚动位置');
  attach(null);
  attach({ closest: () => null });
  assert.equal(scroller.scrollTop, 300, '卸载和配置页以外的挂载都不动滚动位置');
});
