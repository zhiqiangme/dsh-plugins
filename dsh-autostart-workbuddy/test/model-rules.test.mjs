import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModelRules, creditValue } from '../lib/model-rules.js';
import { planModelEntries } from '../lib/models.js';
const list = [{ id: 'a', credits: 'x0.00' }, { id: 'b', credits: 'x0.11', supports_images: true }, { id: 'c' }];
test('免费、倍率和视觉规则跟随新模型，未知价格不被当成免费', () => {
  assert.equal(creditValue(undefined), null);
  assert.deepEqual(applyModelRules(list, { freeOnly: true }).map((x) => x.id), ['a']);
  assert.deepEqual(applyModelRules(list, { maxCredits: 0.2, visionOnly: true }).map((x) => x.id), ['b']);
  assert.deepEqual(planModelEntries([...list, { id: 'new', credits: 0 }], { rules: { freeOnly: true } }).map((x) => x.id), ['a', 'new']);
  assert.deepEqual(applyModelRules(list, { maxCredits: 0 }).map((x) => x.id), ['a']);
});
