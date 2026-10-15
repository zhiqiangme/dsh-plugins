/**
 * 预览模型列表同步：按 profile 里的插件配置拉一次 /v1/models，打印将要写进
 * llm-pi-ai 的 opencode2api provider 的 models 段。**不改任何文件。**
 *
 *   node lib/sync-cli.js
 *
 * 为什么不再提供"真写入"：写配置必须走 DSH 的 configEditor（持 profile 锁、校验、原子写、
 * 热重载，见 lib/models.js 顶部注释）。命令行里没有宿主，直接改 cordis.patch.yml 会和运行中的
 * DSH 互相覆盖。真正的同步发生在 DSH 启动后（插件自动做一次）与插件页点「保存」时。
 *
 * 配置来源与插件运行时一致：读 profile 的 cordis.patch.yml 里 `- id: dsh-opencode2api`
 * 那一行的 config.models——命令行里没有宿主，只能读文件。
 */

import { readFileSync } from 'node:fs';

import { resolvePluginConfig } from './config.js';
import {
  fetchModels,
  panelApiKey,
  planModelEntries,
  readPluginModelsConfig,
  renderModelsBlock,
  resolveProfilePatchPath,
} from './models.js';
import { isFile } from './services.js';

const PLUGIN_ID = 'dsh-opencode2api';

/** 预览里 `- id:` 的缩进：与本机 profile 里 providers.<name>.models 下的条目一致。 */
const PREVIEW_ITEM_INDENT = 10;

const patchPath = resolveProfilePatchPath(process.env, '');
if (!patchPath || !isFile(patchPath)) {
  console.error(
    `找不到 profile 的 cordis.patch.yml：${patchPath ?? '(无法从 DSH_PROFILE_DIR / DSH_PROFILE 推导)'}`,
  );
  process.exit(1);
}

const modelsRaw = readPluginModelsConfig(readFileSync(patchPath, 'utf8'), PLUGIN_ID);
if (!modelsRaw) {
  console.error(`profile 里没有 ${PLUGIN_ID} 的 config.models，没有可预览的同步配置。`);
  console.error('在插件页打开模型列表并保存一次白名单，或在 profile 的 cordis.patch.yml 末尾追加：');
  console.error('');
  console.error(`- id: ${PLUGIN_ID}`);
  console.error(`  name: ${PLUGIN_ID}`);
  console.error('  config:');
  console.error('    models:');
  console.error('      enabled: true');
  console.error('      only:');
  console.error('        - cn:deepseek-v4.1-flash');
  process.exit(0);
}

// 服务规格仍用内置默认值；如果改过后端端口，请同时配 models.baseURL。
const models = resolvePluginConfig({ models: modelsRaw }, process.env).models;

if (!models.enabled) {
  console.log(`profile 里 ${PLUGIN_ID} 的 models.enabled 不是 true，未开启同步。`);
  process.exit(0);
}

const apiKey =
  models.apiKey ||
  (typeof process.env.OPENCODE2API_PROXY_KEY === 'string' ? process.env.OPENCODE2API_PROXY_KEY.trim() : '') ||
  panelApiKey(models.panelConfig);

const fetched = await fetchModels({ baseURL: models.baseURL, apiKey, timeoutMs: models.timeoutMs });
if (!fetched.ok) {
  console.error(`拉取失败：${fetched.reason}`);
  process.exit(1);
}

const entries = planModelEntries(fetched.models, models);
console.log(`后端共 ${fetched.models.length} 个模型，按当前配置取 ${entries.length} 个：`);
console.log('');
console.log(renderModelsBlock(entries, PREVIEW_ITEM_INDENT).join('\n'));
console.log('');
console.log(`以上将写进 llm-pi-ai 的 providers.${models.provider}.models（本命令不改文件）。`);
console.log('DSH 启动后插件会自动同步一次；也可以在插件页的模型列表里点「保存」立即同步。');
