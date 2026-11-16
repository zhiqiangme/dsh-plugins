import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ChannelOrder, creditExpiries } from '../lib/channel-order.js';

const origin = 'http://127.0.0.1:3425';
const rows = ['qoder-cn', 'trae-cn', 'workbuddy', 'codearts', 'custom'].map((provider) => ({ id: `${provider}/model` }));
const config = { baseURL: origin, models: rows };
const ids = (order, state, models = rows) => order.rank(state, models).map((row) => row.id.split('/')[0]);
function quotas(now, sequence = ['qoder-cn', 'trae-cn', 'workbuddy']) {
  return { data: sequence.map((provider, index) => ({ provider, windows: [{ runsOut: 5, runsOutAt: new Date(now + (index + 3) * 86400_000).toISOString() }] })) };
}
function stateFile(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-magpie-order-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('dsh-magpie-order-'));
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, 'order.json');
}

test('按积分最近到期排序，合并同渠道多个账号，忽略重置、已过期、零余额及无效时间', async () => {
  const now = Date.now(), hour = 3600_000;
  const payload = { data: [
    { provider: 'workbuddy', windows: [{ runsOut: 4, runsOutAt: new Date(now + 3 * hour).toISOString() }] },
    { provider: 'workbuddy', windows: [{ runsOut: 1, runsOutAt: new Date(now + hour).toISOString() }] },
    { provider: 'trae-cn', windows: [{ runsOut: 7, runsOutAt: new Date(now + 2 * hour).toISOString() }] },
    { provider: 'qoder-cn', until: new Date(now + 1).toISOString(), windows: [{ resetsAt: new Date(now + 1).toISOString() }] },
    { provider: 'custom', windows: [{ runsOut: 2, remaining: 0, runsOutAt: new Date(now + 2).toISOString() }, { runsOut: 0, runsOutAt: new Date(now + 2).toISOString() }, { runsOut: 1, runsOutAt: 'not a date' }] },
    { provider: 'codearts', windows: [{ runsOut: 5, runsOutAt: new Date(now - 1).toISOString() }] },
  ] };
  assert.equal(creditExpiries(payload, now).size, 2);
  const order = new ChannelOrder({ now: () => now, loadQuotas: async () => payload });
  const state = await order.prepare(config);
  assert.deepEqual(ids(order, state), ['workbuddy', 'trae-cn', 'qoder-cn', 'codearts', 'custom']);
});

test('所有渠道都参与轮换，失败移到末尾且保持其余相对顺序，成功不抢回首位', async () => {
  const order = new ChannelOrder();
  const state = await order.prepare(config);
  order.failed(state, rows[0]);
  assert.deepEqual(ids(order, state), ['trae-cn', 'workbuddy', 'codearts', 'custom', 'qoder-cn']);
  order.failed(state, rows[1]);
  assert.deepEqual(ids(order, state), ['workbuddy', 'codearts', 'custom', 'qoder-cn', 'trae-cn']);
  order.failed(state, rows[0]);
  assert.deepEqual(ids(order, state), ['workbuddy', 'codearts', 'custom', 'trae-cn', 'qoder-cn']);
  const updated = await order.prepare({ ...config, models: [...rows, { id: 'new-provider/model' }] });
  assert.deepEqual(ids(order, updated, [...rows, { id: 'new-provider/model' }]), ['workbuddy', 'codearts', 'custom', 'new-provider', 'trae-cn', 'qoder-cn']);
});

test('当天失败顺序可持久恢复，跨本地日期重读额度并重置，旧请求晚到失败不能污染新一天', async (t) => {
  const file = stateFile(t);
  let now = new Date(2026, 10, 16, 23, 59).getTime(), reads = 0;
  const loadQuotas = async () => { reads++; return quotas(now, reads === 1 ? ['qoder-cn', 'trae-cn', 'workbuddy'] : ['workbuddy', 'trae-cn', 'qoder-cn']); };
  const first = new ChannelOrder({ now: () => now, stateFile: file, loadQuotas });
  const previous = await first.prepare(config);
  first.failed(previous, rows[0]);
  assert.deepEqual(ids(first, previous), ['trae-cn', 'workbuddy', 'codearts', 'custom', 'qoder-cn']);
  const restored = new ChannelOrder({ now: () => now, stateFile: file, loadQuotas });
  const yesterday = await restored.prepare(config);
  assert.deepEqual(ids(restored, yesterday), ids(first, previous));
  assert.equal(reads, 1, '同一天重启保留顺序，不覆盖为默认');
  now = new Date(2026, 10, 17, 0, 0).getTime();
  const today = await restored.prepare(config);
  assert.equal(reads, 2);
  assert.deepEqual(ids(restored, today), ['workbuddy', 'trae-cn', 'qoder-cn', 'codearts', 'custom']);
  restored.failed(yesterday, rows[2]);
  assert.deepEqual(ids(restored, today), ['workbuddy', 'trae-cn', 'qoder-cn', 'codearts', 'custom']);
  assert.equal(readFileSync(file, 'utf8').includes('user'), false, '状态不存账号信息');
});

test('额度接口异常不阻断调用，重试成功建立默认顺序时仍保留当天失败后移', async () => {
  let now = Date.now(), reads = 0;
  const order = new ChannelOrder({ now: () => now, loadQuotas: async () => { if (++reads === 1) throw new Error('offline'); return quotas(now); } });
  const state = await order.prepare(config);
  order.failed(state, rows[0]);
  assert.deepEqual(ids(order, state), ['trae-cn', 'workbuddy', 'codearts', 'custom', 'qoder-cn']);
  await order.prepare(config); assert.equal(reads, 1);
  now += 5 * 60_000;
  await order.prepare(config); assert.equal(reads, 2);
  assert.deepEqual(ids(order, state), ['trae-cn', 'workbuddy', 'codearts', 'custom', 'qoder-cn']);
});

test('并发首次请求只读取一次额度，修改网关和损坏的状态文件不会沿用错误队列', async (t) => {
  const file = stateFile(t);
  writeFileSync(file, 'broken JSON');
  let reads = 0;
  const order = new ChannelOrder({ stateFile: file, loadQuotas: async () => { reads++; return []; } });
  const [one, two] = await Promise.all([order.prepare(config), order.prepare(config)]);
  assert.equal(reads, 1); assert.equal(one, two);
  order.failed(one, rows[0]);
  const other = await order.prepare({ ...config, baseURL: 'http://127.0.0.1:3426' });
  assert.equal(reads, 2);
  assert.deepEqual(ids(order, other), rows.map((row) => row.id.split('/')[0]));
});
