import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ChannelOrder, creditExpiries, routingDay, REFRESH_QUOTAS_MS } from '../lib/channel-order.js';

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

test('优先使用其它运行对话占用最少的渠道，同占用再按到期及失败顺序，停用始终排除', async () => {
  const order = new ChannelOrder(), state = await order.prepare(config);
  const loads = new Map([['qoder-cn', 2], ['trae-cn', 1], ['workbuddy', 1], ['codearts', 2], ['custom', 2]]);
  assert.deepEqual(order.rank(state, rows, loads).map((row) => row.id.split('/')[0]), ['trae-cn', 'workbuddy', 'qoder-cn', 'codearts', 'custom']);
  order.failed(state, rows[1]);
  assert.equal(order.rank(state, rows, loads)[0].id, rows[2].id);
  order.exhausted(state, rows[2]);
  assert.equal(order.rank(state, rows, loads)[0].id, rows[1].id);
});

test('每小时恢复积分到期优先级，保留余额不足停用，并缓存刷新时间供重启沿用', async (t) => {
  let now = Date.parse('2026-11-16T12:00:00+08:00'), reads = 0;
  const options = { now: () => now, stateFile: stateFile(t), loadQuotas: async () => { reads++; return quotas(now); } };
  const order = new ChannelOrder(options), state = await order.prepare(config);
  order.failed(state, rows[0]); order.exhausted(state, rows[1]);
  const blocked = order.snapshot(config).blocked[0];
  now += REFRESH_QUOTAS_MS - 1;
  await order.prepare(config);
  assert.equal(reads, 1);
  const reopened = new ChannelOrder(options);
  await reopened.prepare(config);
  assert.equal(reads, 1, '重启不提前重排');
  now++;
  const updated = await reopened.prepare(config);
  assert.equal(reads, 2);
  assert.deepEqual(ids(reopened, updated), ['qoder-cn', 'workbuddy', 'codearts', 'custom']);
  assert.deepEqual(reopened.snapshot(config).blocked, [blocked]);
});

test('小时刷新失败保留当前顺序并五分钟重试，刷新期间新失败不被抹掉', async () => {
  let now = Date.parse('2026-11-16T12:00:00+08:00'), reads = 0, finish;
  const order = new ChannelOrder({ now: () => now, loadQuotas: async () => {
    reads++;
    if (reads === 2) throw new Error('quota unavailable');
    if (reads === 3) return new Promise((resolve) => { finish = resolve; });
    return quotas(now);
  } });
  const state = await order.prepare(config);
  order.failed(state, rows[0]);
  now += REFRESH_QUOTAS_MS;
  await order.prepare(config);
  assert.equal(ids(order, state).at(-1), 'qoder-cn');
  await order.prepare(config); assert.equal(reads, 2);
  now += 5 * 60_000;
  const refresh = order.prepare(config);
  order.failed(state, rows[1]);
  finish(quotas(now)); await refresh;
  assert.equal(reads, 3);
  assert.deepEqual(ids(order, state), ['qoder-cn', 'workbuddy', 'codearts', 'custom', 'trae-cn']);
});

test('当天失败顺序可持久恢复，北京时间 04:00 重读额度并重置，旧请求晚到失败不能污染新一天', async (t) => {
  const file = stateFile(t);
  let now = Date.parse('2026-11-16T03:59:59+08:00'), reads = 0;
  const loadQuotas = async () => { reads++; return quotas(now, reads === 1 ? ['qoder-cn', 'trae-cn', 'workbuddy'] : ['workbuddy', 'trae-cn', 'qoder-cn']); };
  const first = new ChannelOrder({ now: () => now, stateFile: file, loadQuotas });
  const previous = await first.prepare(config);
  first.failed(previous, rows[0]);
  assert.deepEqual(ids(first, previous), ['trae-cn', 'workbuddy', 'codearts', 'custom', 'qoder-cn']);
  const restored = new ChannelOrder({ now: () => now, stateFile: file, loadQuotas });
  const yesterday = await restored.prepare(config);
  assert.deepEqual(ids(restored, yesterday), ids(first, previous));
  assert.equal(reads, 1, '同一天重启保留顺序，不覆盖为默认');
  now = Date.parse('2026-11-16T04:00:00+08:00');
  const today = await restored.prepare(config);
  assert.equal(reads, 2);
  assert.deepEqual(ids(restored, today), ['workbuddy', 'trae-cn', 'qoder-cn', 'codearts', 'custom']);
  restored.failed(yesterday, rows[2]);
  assert.deepEqual(ids(restored, today), ['workbuddy', 'trae-cn', 'qoder-cn', 'codearts', 'custom']);
  assert.equal(readFileSync(file, 'utf8').includes('user'), false, '状态不存账号信息');
});

test('渠道日严格以北京时间 04:00 为界，00:00 与电脑时区均不影响边界', () => {
  assert.equal(routingDay(Date.parse('2026-11-16T23:59:59+08:00')), '2026-11-16');
  assert.equal(routingDay(Date.parse('2026-11-17T00:00:00+08:00')), '2026-11-16');
  assert.equal(routingDay(Date.parse('2026-11-16T19:59:59.999Z')), '2026-11-16');
  assert.equal(routingDay(Date.parse('2026-11-16T20:00:00Z')), '2026-11-17');
  assert.equal(routingDay(Date.parse('2026-07-16T20:00:00Z')), '2026-07-17');
});

test('余额不足停用整个渠道并持久化；恢复后可重选，旧请求不能重新停用，新报错可以', async (t) => {
  const file = stateFile(t);
  const now = Date.parse('2026-11-16T12:00:00+08:00');
  const options = { now: () => now, stateFile: file, loadQuotas: async () => quotas(now) };
  const order = new ChannelOrder(options), state = await order.prepare(config);
  const generation = order.generation(state, rows[0]);
  order.exhausted(state, rows[0], generation);
  const blocked = order.snapshot(config).blocked[0];
  assert.equal(blocked.id, 'qoder-cn');
  assert.equal(blocked.at, now);
  assert.ok(!ids(order, state, [...rows, { id: 'qoder-cn/another-model' }]).includes('qoder-cn'));
  const restored = new ChannelOrder(options), sameDay = await restored.prepare(config);
  assert.deepEqual(restored.snapshot(config).blocked, [blocked]);
  assert.ok(!ids(restored, sameDay).includes('qoder-cn'));
  assert.throws(() => restored.recover(config, 'qoder-cn', 'stale'), (error) => error.status === 409);
  assert.equal(restored.recover(config, 'qoder-cn', blocked.token).blocked.length, 0);
  assert.equal(new ChannelOrder(options).snapshot(config).blocked.length, 0, '手动恢复也写入缓存，重启不重新停用');
  assert.deepEqual(ids(restored, sameDay), rows.map((row) => row.id.split('/')[0]));
  restored.exhausted(sameDay, rows[0], generation);
  assert.equal(restored.snapshot(config).blocked.length, 0, '恢复前的在途请求结果不重新停用');
  restored.exhausted(sameDay, rows[0], restored.generation(sameDay, rows[0]));
  assert.equal(restored.snapshot(config).blocked.length, 1, '恢复后的新请求仍可能再次余额不足');
  assert.throws(() => restored.recover(config, 'qoder-cn', blocked.token), (error) => error.status === 409, '旧页面不能恢复新的停用记录');
  assert.equal(readFileSync(file, 'utf8').includes('secret'), false);
});

test('北京时间 04:00 清除停用并重新排序，旧日结果不影响新日，删掉再同步渠道也不能绕过当天停用', async (t) => {
  let now = Date.parse('2026-11-17T03:59:59+08:00'), reads = 0;
  const order = new ChannelOrder({ now: () => now, stateFile: stateFile(t), loadQuotas: async () => { reads++; return quotas(now); } });
  const yesterday = await order.prepare(config);
  order.exhausted(yesterday, rows[0]);
  const without = { ...config, models: rows.slice(1) };
  assert.equal(order.snapshot(without).blocked.length, 1);
  assert.ok(!ids(order, await order.prepare(config)).includes('qoder-cn'));
  now = Date.parse('2026-11-17T04:00:00+08:00');
  assert.equal(order.snapshot(config).blocked.length, 0);
  const today = await order.prepare(config);
  assert.equal(reads, 2);
  order.exhausted(yesterday, rows[0]);
  order.failed(yesterday, rows[1]);
  assert.deepEqual(ids(order, today), rows.map((row) => row.id.split('/')[0]));
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
  order.exhausted(one, rows[1]);
  assert.equal(order.snapshot(config).blocked.length, 1);
  const other = await order.prepare({ ...config, baseURL: 'http://127.0.0.1:3426' });
  assert.equal(reads, 2);
  assert.deepEqual(ids(order, other), rows.map((row) => row.id.split('/')[0]));
  assert.equal(order.snapshot({ ...config, baseURL: 'http://127.0.0.1:3426' }).blocked.length, 0, '不同网关不共用停用记录');
});
