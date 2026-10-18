import assert from 'node:assert/strict';
import test from 'node:test';
import { liveConfigValues } from '../lib/config.js';

test('saved settings remain live after a second edit and reopening the view', () => {
  let saved = { keywords: ['原神', 'AI'], workspace: 'D:/Project', dmUid: 355838070, peakValley: true };
  const refs = Object.freeze(Object.fromEntries(Object.keys(saved).map((key) => [key, { get: () => saved[key] }])));
  const view = liveConfigValues(refs);
  const read = (cfg) => Object.fromEntries(Object.keys(saved).map((key) => [key, cfg[key]]));
  assert.deepEqual(read(view), saved);
  saved = { ...saved, keywords: ['DeepSeek', 'Claude'], workspace: '' };
  assert.deepEqual(read(view), saved);
  assert.deepEqual(read(liveConfigValues(refs)), saved);
  assert.equal(view.peakValley, true);
  assert.equal(view.dmUid, 355838070);
});

test('plain config and missing fields retain their normal behavior', () => {
  const plain = { keywords: [], workspace: '', enabled: false, dmUid: 0 };
  const view = liveConfigValues(plain);
  assert.deepEqual({ ...view }, plain);
  assert.equal(view.missing, undefined);
  assert.equal(liveConfigValues(null).missing, undefined);
});
