import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelLoad, PURPOSE_HEADER, SESSION_HEADER, registerChannelSessions, sessionKey } from '../lib/channel-load.js';
import { PROVIDER_ID } from '../lib/config.js';
import { fakeHost } from '../fixtures/host.mjs';

const scope = 'http://127.0.0.1:3425';

test('按真实会话计数，模型请求结束后的工具间隔保留占用，同一会话不会重复计数', () => {
  const running = new Set(['a', 'b']);
  const load = new ChannelLoad({ runningSessions: () => running });
  const one = load.reserve(scope, 'a', 'qoder');
  const two = load.reserve(scope, 'a', 'qoder');
  assert.equal(load.counts(scope).get('qoder'), 1);
  assert.equal(load.counts(scope, 'a').has('qoder'), false, '选路时不把自身当成其它对话');
  one.release(true); two.release(true);
  assert.equal(load.counts(scope).get('qoder'), 1, '等待工具时仍然占用');
  const other = load.reserve(scope, 'b', 'trae'); other.release(true);
  assert.deepEqual([...load.counts(scope)], [['qoder', 1], ['trae', 1]]);
  running.delete('b');
  assert.equal(load.counts(scope).has('trae'), false, '已停止的对话在下一次选路前释放');
  load.releaseSession('a');
  assert.equal(load.counts(scope).size, 0);
});

test('没有宿主状态或会话标识时只统计在途请求，不根据相同消息合并对话或留下占用', () => {
  const load = new ChannelLoad();
  const one = load.reserve(scope, undefined, 'qoder');
  const two = load.reserve(scope, undefined, 'qoder');
  assert.equal(load.counts(scope).get('qoder'), 2);
  one.release(true); two.release(true);
  assert.equal(load.counts(scope).size, 0);
  const known = load.reserve(scope, 'a', 'qoder'); known.release(true);
  assert.equal(load.counts(scope).size, 0);
});

test('停止、跨网关与并发旧请求的释放不会清掉新占用', () => {
  const load = new ChannelLoad({ runningSessions: () => new Set(['a']) });
  const old = load.reserve(scope, 'a', 'qoder');
  load.releaseSession('a');
  const fresh = load.reserve(scope, 'a', 'trae');
  old.release(true);
  assert.deepEqual([...load.counts(scope)], [['trae', 1]]);
  const other = load.reserve('http://127.0.0.1:3426', 'a', 'workbuddy');
  fresh.release(true);
  assert.equal(load.counts(scope).size, 0);
  assert.deepEqual([...load.counts('http://127.0.0.1:3426')], [['workbuddy', 1]]);
  other.release(); load.clear();
  assert.equal(load.counts('http://127.0.0.1:3426').size, 0);
});

test('沿用 DSH 请求头事件，只给插件本机路由注入会话摘要，空闲事件与卸载释放监听', async () => {
  const host = fakeHost(), released = [];
  let enabled = true;
  registerChannelSessions(host.ctx, { current: () => ({ autoRoute: enabled }), router: { releaseSession: (id) => released.push(id) } });
  const hook = host.events.get('llm-pi-ai/request-headers')[0];
  const request = { provider: PROVIDER_ID, baseURL: 'http://127.0.0.1:8787/plugins/dsh-magpie/router/v1/', sessionId: 'a real session id' };
  const initial = new Headers({ 'x-other-plugin': 'keep' });
  const call = (patch = {}) => hook({ ...request, ...patch }, initial, () => initial);
  const headers = call();
  assert.equal(headers.get(SESSION_HEADER), sessionKey(request.sessionId));
  assert.equal(headers.has(PURPOSE_HEADER), false);
  assert.equal(headers.get('x-other-plugin'), 'keep');
  assert.equal(initial.has(SESSION_HEADER), false, '不改其它贡献者的原始 Headers');
  assert.notEqual(sessionKey('a real session id'), sessionKey('another session id'));
  for (const patch of [{ provider: 'unrelated' }, { baseURL: 'https://remote.test/plugins/dsh-magpie/router/v1/' },
    { baseURL: 'http://127.0.0.1:3425/v1/' }, { sessionId: undefined }]) assert.equal(call(patch).has(SESSION_HEADER), false);
  assert.equal(call({ purpose: 'session-title' }).get(PURPOSE_HEADER), 'session-title');
  const titleWithoutSession = call({ purpose: 'session-title', sessionId: undefined });
  assert.equal(titleWithoutSession.get(PURPOSE_HEADER), 'session-title', '缺少会话标识也能识别宿主明确声明的标题用途');
  assert.equal(titleWithoutSession.has(SESSION_HEADER), false);
  for (const purpose of [undefined, 'agent-loop', 'session-title-other', 'low']) assert.equal(call({ purpose }).has(PURPOSE_HEADER), false);
  for (const patch of [{ provider: 'unrelated' }, { baseURL: 'https://remote.test/plugins/dsh-magpie/router/v1/' },
    { baseURL: 'http://127.0.0.1:3425/v1/' }]) assert.equal(call({ purpose: 'session-title', ...patch }).has(PURPOSE_HEADER), false);
  assert.equal(initial.has(PURPOSE_HEADER), false, '不污染其它贡献者的请求头');
  const stale = hook(request, new Headers({ [PURPOSE_HEADER]: 'session-title' }), () => new Headers({ [PURPOSE_HEADER]: 'session-title' }));
  assert.equal(stale.has(PURPOSE_HEADER), false, '正常会话不会继承旧的标题标记');
  enabled = false;
  assert.equal(call().has(SESSION_HEADER), false, '直连上游模式不注入内部标识');
  assert.equal(call({ purpose: 'session-title' }).has(PURPOSE_HEADER), false);
  const status = host.events.get('agent/status')[0];
  status({ agent: { id: request.sessionId }, status: 'running' });
  assert.equal(released.length, 0);
  status({ agent: { id: request.sessionId }, status: 'idle' });
  assert.deepEqual(released, [sessionKey(request.sessionId)]);
  await host.ctx.dispose();
  assert.equal(host.events.get('llm-pi-ai/request-headers').length, 0);
  assert.equal(host.events.get('agent/status').length, 0);
});
