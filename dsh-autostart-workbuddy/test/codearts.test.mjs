/**
 * CodeArts 出口里不依赖假 hub 的规则：展示名、思考档位、目录来源、白名单范围与健康探针。
 * 同步、路由、Key 校验的完整流程在 hub-dual.test.mjs。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeHubHealth } from '../lib/hub.js';
import { creditsLabel, confirmRemovals, hubRegionWanted, modelCreditsLabel, modelDisplayName, modelEfforts, planModelEntries, scopedSelection, selectionKey } from '../lib/models.js';

const realm = 'codearts';

test('展示名标 HW 不标 Free：CodeArts 没有倍率，WorkBuddy 缺倍率仍是 Free', () => {
  assert.equal(modelDisplayName({ id: 'GLM-5.2', name: 'GLM-5.2', realm }), 'GLM-5.2 HW');
  assert.equal(modelDisplayName({ id: 'codearts:GLM-5.2', name: 'GLM-5.2', realm }), 'GLM-5.2 HW');
  assert.equal(modelCreditsLabel({ realm }), '');
  assert.equal(modelCreditsLabel({ realm, credits: 'x0.5' }), '0.5', 'hub 日后补上倍率就照常显示');
  assert.equal(modelCreditsLabel({ realm: 'cn' }), creditsLabel(undefined));
});

test('思考档位：CodeArts 声明过的按声明收窄，没声明的沿用配置；none 不是 DSH 的档位', () => {
  const flash = { id: 'glm-5.3-flash', realm, reasoning_efforts: ['low', 'high', 'max'] };
  assert.deepEqual(modelEfforts(flash, ['low', 'medium', 'max']), ['low', 'max'], 'hub 对档位外的请求直接 400');
  assert.deepEqual(modelEfforts({ id: 'glm-5.3', realm, reasoning_efforts: ['none', 'minimal', 'low'] }, 'auto'), ['minimal', 'low']);
  assert.deepEqual(modelEfforts({ id: 'speed', realm }, ['low', 'high']), ['low', 'high']);
  assert.deepEqual(modelEfforts({ id: 'hy4', realm: 'cn', reasoning_efforts: ['high'] }, ['low', 'high']), ['low', 'high'], 'WorkBuddy 的档位由 hub 换算，不收窄');
  assert.deepEqual(Object.keys(planModelEntries([flash], { efforts: ['low', 'high', 'max'] })[0].reasoningEfforts), ['low', 'high', 'max']);
});

test('移除确认：CodeArts 的账号目录算远程来源，种子目录不算', () => {
  const guard = { missing: new Set() };
  const catalog = (at) => ({ source: realm, fetched_at: at });
  assert.equal(confirmRemovals(guard, ['a'], [], catalog(100)).ok, false, '第一轮只记缺席');
  assert.equal(confirmRemovals(guard, ['a'], [], catalog(200)).ok, true, '新批次再次缺席才移除');
  const seeded = { missing: new Set(['a']) };
  assert.equal(confirmRemovals(seeded, ['a'], [], { source: realm, fetched_at: undefined }).ok, false, '账号都拉不到目录时回退种子，不能据此下架');
});

test('白名单范围：CodeArts 没勾过时双区域不要它，同步全部时才要；老的裸 id 不展开成它', () => {
  assert.equal(selectionKey({ id: 'GLM-5.2', realm }), 'codearts:GLM-5.2');
  assert.equal(hubRegionWanted(realm, []), true);
  assert.equal(hubRegionWanted(realm, ['cn:a']), false);
  assert.equal(hubRegionWanted(realm, ['cn:a', 'codearts:b']), true);
  assert.equal(hubRegionWanted('cn', ['global:a']), true, 'CN / GL 的"没勾过 = 全部"不变');
  assert.deepEqual(scopedSelection(['legacy', 'codearts:b'], 'hub'), ['cn:legacy', 'global:legacy', 'codearts:b']);
});

test('probeHubHealth：CodeArts 账号单独报，看板切到它时按它判断能否服务', async (t) => {
  let payload;
  const server = createServer((_req, res) => res.end(JSON.stringify(payload)));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const probe = () => probeHubHealth({ port: server.address().port });

  payload = { realm, accounts: 0, accounts_ready: 0, codearts: { configured: true, accounts: 2, healthy: 1 } };
  assert.deepEqual(await probe(), { ok: true, servable: true, healthy: 0, total: 0, realm, codearts: { ready: 1, total: 2 } }, '只登录了 CodeArts 也能服务');

  payload = { realm: 'cn', accounts: 0, accounts_ready: 0, codearts: { configured: true, accounts: 2, healthy: 2 } };
  assert.equal((await probe()).servable, false, 'WorkBuddy 出口不能借 CodeArts 的账号算可用');

  payload = { realm, accounts: 3, accounts_ready: 3, codearts: { configured: true, accounts: 1, healthy: 0 } };
  assert.equal((await probe()).servable, false);

  payload = { realm: 'cn', accounts: 1, accounts_ready: 1, codearts: { configured: false } };
  assert.equal('codearts' in (await probe()), false, '没启用就不报');
});
