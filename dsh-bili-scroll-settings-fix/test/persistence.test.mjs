import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { liveConfigValues } from '../lib/config.js';

// Optional integration against the installed npm package; ordinary CI stays offline.
test('upstream HTTP saves survive another edit and a host reload', {
  skip: !process.env.DSH_BILI_SCROLL_ENTRY,
}, async () => {
  const { apply } = await import(pathToFileURL(process.env.DSH_BILI_SCROLL_ENTRY));
  const prefix = join(process.env.DSH_BILI_SCROLL_TEST_TMP || tmpdir(), 'bili-settings-persistence-');
  const home = mkdtempSync(prefix);
  let user = {};
  const defaults = { perDay: 5, mentionName: '', replyToComments: false, overlayMcp: true,
    keywords: [], workspace: '', peakValley: false, dmUid: 0, dmMode: 'off' };
  const refs = Object.freeze(Object.fromEntries(Object.keys(defaults).map((key) =>
    [key, { get: () => user[key] ?? defaults[key] }])));
  let handler;
  const ctx = {
    get: () => (...parts) => join(home, ...parts),
    logger: { info() {} },
    tools: { register: (tool) => tool },
    settings: {
      describe: () => [{ ns: 'bili-scroll', value: { ...defaults, ...user }, user, revision: 0 }],
      update: async (_ns, patch) => { user = { ...user, ...patch }; },
    },
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
    // The persistence check must never start an automatic browsing round.
    effect: (fn, label = '') => label.includes('/api/bili-duty') ? fn() : undefined,
  };
  const request = async (method, body) => {
    const req = Object.assign(new EventEmitter(), { method, url: '/api/bili-duty/config' });
    let payload;
    const res = { writeHead: (code) => assert.equal(code, 200), end: (text) => { payload = JSON.parse(text); } };
    const pending = handler(req, res);
    if (method === 'POST') { req.emit('data', JSON.stringify(body)); req.emit('end'); }
    await pending;
    return payload.config;
  };
  try {
    apply(ctx, liveConfigValues(refs));
    const desired = { keywords: ['原神', 'AI'], workspace: 'D:/Project', peakValley: true, dmMode: 'only', dmUid: 355838070 };
    await request('POST', desired);
    await request('POST', { perDay: 7 });
    for (const config of [await request('GET'), JSON.parse(readFileSync(join(home, 'bili-duty', 'config.json'), 'utf8'))]) {
      for (const [key, value] of Object.entries(desired)) assert.deepEqual(config[key], value);
      assert.equal(config.perDay, 7);
    }
    apply(ctx, liveConfigValues(refs));
    const reopened = await request('GET');
    for (const [key, value] of Object.entries(desired)) assert.deepEqual(reopened[key], value);
    assert.equal(reopened.perDay, 7);
  } finally {
    assert.ok(resolve(home).startsWith(resolve(prefix)));
    rmSync(home, { recursive: true, force: true });
  }
});
