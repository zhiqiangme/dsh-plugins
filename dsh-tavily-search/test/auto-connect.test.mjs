import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autoConnect } from '../lib/auto-connect.js';
import { resolvePluginConfig } from '../lib/config.js';

async function fixture(t, { inherited = 'deepseek-search-api', override = {}, legacy, installed = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tavily-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = { dir, startedBundles: [] };
  const bundles = installed ? ['@zhiqiangme/dsh-tavily-search'] : [];
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }));
  const base = { searchProvider: inherited, fetchProvider: 'http' };
  const entry = { options: { name: '@deepseek-ai/dsh-web', id: 'web', config: { ...base, ...override } } };
  const web = { entry, inherited: base, override };
  const entries = [web];
  if (legacy) entries.push({ entry: { options: { id: 'web-deepseek-api' } }, override: legacy });
  const editor = {
    configuration: () => entries,
    async edit(row, change) {
      assert.equal(row, entry);
      const current = row.options.config;
      row.options.config = change(current);
      web.override = row.options.config;
    },
  };
  const run = () => autoConnect({
    profile,
    editor,
    providerId: 'dsh-tavily-search',
    resolved: resolvePluginConfig(),
    signal: new AbortController().signal,
  });
  return { run, editor, web };
}

test('首次加载选择 Tavily，恢复默认后重启不再接入', async (t) => {
  const { run, web } = await fixture(t);
  await run();
  assert.deepEqual(web.entry.options.config, { searchProvider: 'dsh-tavily-search', fetchProvider: 'http' });
  web.entry.options.config = { ...web.inherited };
  web.override = {};
  await run();
  assert.deepEqual(web.entry.options.config, web.inherited);
});

test('保留显式搜索选择、部署自定义默认值、旧版接入和仅通过 overlay 加载的插件', async (t) => {
  for (const options of [
    { override: { searchProvider: 'deepseek-search-api' } },
    { inherited: 'custom-search' },
    { legacy: { apiKeyEnv: 'DSH_TAVILY_SEARCH_PLACEHOLDER' } },
    { installed: false },
  ]) {
    const { run, editor } = await fixture(t, options);
    editor.edit = () => assert.fail('不应写入搜索配置');
    await run();
  }
});

test('等待配置锁期间用户切换提供方时，保留新选择', async (t) => {
  const { run, web, editor } = await fixture(t);
  const edit = editor.edit;
  editor.edit = (entry, change) => {
    web.override = { searchProvider: 'deepseek-official' };
    entry.options.config = { ...web.inherited, ...web.override };
    return edit(entry, change);
  };
  await run();
  assert.equal(web.entry.options.config.searchProvider, 'deepseek-official');
});

test('DSH 写入失败后可以重试首次接入', async (t) => {
  const { run, web, editor } = await fixture(t);
  const edit = editor.edit;
  editor.edit = async () => { throw new Error('Profile write failed'); };
  await assert.rejects(run(), /Profile write failed/);
  editor.edit = edit;
  await run();
  assert.equal(web.entry.options.config.searchProvider, 'dsh-tavily-search');
});
