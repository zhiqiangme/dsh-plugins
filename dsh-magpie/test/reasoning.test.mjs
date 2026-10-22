import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_ID } from '../lib/config.js';
import { decorateAdapter, highestDefault, highestEffort, registerHighestReasoning } from '../lib/reasoning.js';

function fixtureAdapter() {
  const calls = [];
  const levels = { step: ['low', 'medium', 'high'], flash: ['max', 'low', 'high'], plain: [] };
  const metadata = (provider, id) => ({ provider, id, name: id, ...(levels[id].length ? { reasoning: { efforts: levels[id].map((level) => ({ id: level, name: level })), defaultEffort: 'low' } } : {}) });
  const adapter = {
    calls, levels,
    async resolveModel(provider, id) { return metadata(provider, id); },
    async prepareCall(provider, id) { return { model: metadata(provider, id), stream: async function* (options) { calls.push(options); yield 'prepared'; } }; },
    async *stream(options) { calls.push(options); yield 'direct'; },
  };
  return adapter;
}

test('按真实等级顺序选择最高档，不依赖输入数组排序，不补出未声明的 max', () => {
  assert.equal(highestEffort(['high', 'low', 'medium']), 'high');
  assert.equal(highestEffort(['max', 'high', 'xhigh']), 'max');
  assert.equal(highestEffort(['low', 'xhigh', 'medium']), 'xhigh');
  assert.equal(highestEffort([]), undefined);
});

test('逐模型元数据默认值：Step 选 high，Flash 选 max，无推理能力保持原样', async () => {
  const adapter = fixtureAdapter(); const restore = decorateAdapter(adapter);
  assert.equal((await adapter.resolveModel(PROVIDER_ID, 'step')).reasoning.defaultEffort, 'high');
  assert.equal((await adapter.resolveModel(PROVIDER_ID, 'flash')).reasoning.defaultEffort, 'max');
  assert.equal((await adapter.resolveModel(PROVIDER_ID, 'plain')).reasoning, undefined);
  assert.equal((await adapter.resolveModel('other-provider', 'step')).reasoning.defaultEffort, 'low');
  restore();
  assert.equal((await adapter.resolveModel(PROVIDER_ID, 'step')).reasoning.defaultEffort, 'low');
});

test('直接调用仅在未指定时补默认值，保留显式 low 与其它 provider，接受冻结请求', async () => {
  const adapter = fixtureAdapter(); const restore = decorateAdapter(adapter);
  const request = Object.freeze({ provider: PROVIDER_ID, model: 'step' });
  for await (const _ of adapter.stream(request)) {}
  assert.equal(adapter.calls.at(-1).reasoningEffort, 'high');
  assert.equal(request.reasoningEffort, undefined);
  for await (const _ of adapter.stream({ ...request, model: 'flash' })) {}
  assert.equal(adapter.calls.at(-1).reasoningEffort, 'max');
  const explicit = { ...request, reasoningEffort: 'low' };
  for await (const _ of adapter.stream(explicit)) {}
  assert.equal(adapter.calls.at(-1), explicit);
  const other = { provider: 'other', model: 'step' };
  for await (const _ of adapter.stream(other)) {}
  assert.equal(adapter.calls.at(-1), other);
  for await (const _ of adapter.stream({ ...request, model: 'plain' })) {}
  assert.equal(adapter.calls.at(-1).reasoningEffort, undefined);
  restore();
});

test('prepared 调用保留自己的元数据快照，后续配置变化不改写已有请求', async () => {
  const adapter = fixtureAdapter(); const restore = decorateAdapter(adapter);
  const prepared = await adapter.prepareCall(PROVIDER_ID, 'step');
  assert.equal(prepared.model.reasoning.defaultEffort, 'high');
  adapter.levels.step = ['low', 'max'];
  for await (const _ of prepared.stream({ provider: PROVIDER_ID, model: 'step' })) {}
  assert.equal(adapter.calls.at(-1).reasoningEffort, 'high');
  const low = { provider: PROVIDER_ID, model: 'step', reasoningEffort: 'low' };
  for await (const _ of prepared.stream(low)) {}
  assert.equal(adapter.calls.at(-1), low);
  restore();
});

test('注销后恢复原有属性，第三方后加的包装层保留且不再添加默认值', async () => {
  class Adapter {
    async resolveModel(provider, id) { return { provider, id, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }; }
    async prepareCall(provider, id) { return { model: await this.resolveModel(provider, id), stream: this.stream.bind(this) }; }
    async *stream() {}
  }
  const adapter = new Adapter();
  const restore = decorateAdapter(adapter);
  const originalDecorated = adapter.resolveModel;
  const thirdParty = async function (...args) { return { ...await originalDecorated.apply(this, args), thirdParty: true }; };
  adapter.resolveModel = thirdParty;
  restore();
  assert.equal(adapter.resolveModel, thirdParty);
  assert.equal(Object.hasOwn(adapter, 'prepareCall'), false);
  const info = await adapter.resolveModel(PROVIDER_ID, 'x');
  assert.equal(info.reasoning.defaultEffort, undefined);
  assert.equal(info.thirdParty, true);
});

test('接口不兼容或无法写入时不留下半安装的包装层', () => {
  assert.throws(() => decorateAdapter({}), /接口/);
  const adapter = fixtureAdapter(); const original = adapter.resolveModel;
  Object.defineProperty(adapter, 'prepareCall', { writable: false });
  assert.throws(() => decorateAdapter(adapter));
  assert.equal(adapter.resolveModel, original);
});

test('注册晚到和适配器更换时重新附加，卸载恢复所有处理过的实例', async () => {
  const listeners = new Set(), disposers = [];
  let current;
  const llm = { registration() { if (!current) throw new Error('NO_ADAPTER'); return { adapter: current }; }, emitAdaptersUpdated() { for (const run of [...listeners]) run(); } };
  const ctx = { get: (name) => name === 'llm' ? llm : undefined, on: (_event, run) => { listeners.add(run); return () => listeners.delete(run); }, effect: (run) => disposers.push(run()) };
  const mounts = [];
  ctx.inject = (names, run) => mounts.push({ names, run });
  registerHighestReasoning(ctx);
  assert.deepEqual(mounts[0].names, ['llm']);
  mounts[0].run(ctx);
  current = fixtureAdapter(); const first = current;
  llm.emitAdaptersUpdated(); llm.emitAdaptersUpdated();
  assert.equal((await first.resolveModel(PROVIDER_ID, 'step')).reasoning.defaultEffort, 'high');
  current = fixtureAdapter(); llm.emitAdaptersUpdated();
  assert.equal((await current.resolveModel(PROVIDER_ID, 'flash')).reasoning.defaultEffort, 'max');
  for (const dispose of disposers) dispose();
  assert.equal(listeners.size, 0);
  assert.equal((await first.resolveModel(PROVIDER_ID, 'step')).reasoning.defaultEffort, 'low');
  assert.equal((await current.resolveModel(PROVIDER_ID, 'step')).reasoning.defaultEffort, 'low');
});

test('元数据修饰不修改适配器原始对象', () => {
  const info = { provider: PROVIDER_ID, id: 'x', reasoning: { efforts: [{ id: 'high', name: 'High' }] } };
  const result = highestDefault(info);
  assert.equal(result.reasoning.defaultEffort, 'high');
  assert.equal(info.reasoning.defaultEffort, undefined);
});
