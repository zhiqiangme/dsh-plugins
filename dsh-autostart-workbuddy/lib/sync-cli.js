/**
 * 手动同步模型列表（DSH 启动时插件也会自动做一次，见 lib/index.js）。
 *
 *   node lib/sync-cli.js            按 profile 里的插件配置同步一次
 *   node lib/sync-cli.js --dry-run  只打印将要写入的 models 段，不改任何文件
 *
 * 配置来源与自动同步完全一致：读 profile 的 cordis.patch.yml 里
 * `- id: dsh-autostart-workbuddy` 那一行的 config.models——命令行里没有宿主，
 * 只能直接读文件，这样"手动跑一次"和"启动时自动同步"用的就是同一份配置。
 *
 * 这是本插件唯一会写文件的入口；lib/cli.js 保持只读。
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
  syncModels,
} from './models.js';
import { isFile } from './services.js';

const PLUGIN_ID = 'dsh-autostart-workbuddy';
const dryRun = process.argv.includes('--dry-run');

const patchPath = resolveProfilePatchPath(process.env, '');
if (!patchPath || !isFile(patchPath)) {
  console.error(
    `找不到 profile 的 cordis.patch.yml：${patchPath ?? '(无法从 DSH_PROFILE_DIR / DSH_PROFILE 推导)'}`,
  );
  process.exit(1);
}

const modelsRaw = readPluginModelsConfig(readFileSync(patchPath, 'utf8'), PLUGIN_ID);
if (!modelsRaw) {
  console.error(`profile 里没有 ${PLUGIN_ID} 的 config.models，手动同步无事可做。`);
  console.error('在 profile 的 cordis.patch.yml 末尾追加（白名单留空 = 后端全部模型）：');
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
const resolved = resolvePluginConfig({ models: { ...modelsRaw, profilePatch: patchPath } }, process.env);
const models = resolved.models;

if (!models.enabled) {
  console.log(`profile 里 ${PLUGIN_ID} 的 models.enabled 不是 true，未开启同步。`);
  process.exit(0);
}

const apiKey =
  models.apiKey ||
  (typeof process.env.WORKBUDDY_PROXY_KEY === 'string' ? process.env.WORKBUDDY_PROXY_KEY.trim() : '') ||
  panelApiKey(models.panelConfig);

if (dryRun) {
  const fetched = await fetchModels({ baseURL: models.baseURL, apiKey, timeoutMs: models.timeoutMs });
  if (!fetched.ok) {
    console.error(`拉取失败：${fetched.reason}`);
    process.exit(1);
  }
  const entries = planModelEntries(fetched.models, models);
  console.log(`后端共 ${fetched.models.length} 个模型，按当前配置取 ${entries.length} 个：`);
  console.log('');
  console.log(renderModelsBlock(entries, 10).join('\n'));
}

const result = await syncModels({ spec: resolved.spec, models, env: process.env, dryRun });

switch (result.state) {
  case 'dry-run':
    console.log('');
    console.log(`以上内容将写入 ${result.patchPath}（--dry-run 未写入）。`);
    break;
  case 'updated':
    console.log(`已同步 ${result.entries.length} 个模型 → ${result.patchPath}`);
    console.log(`备份：${result.backup}`);
    console.log('重启 DSH（或触发配置热加载）后生效。');
    break;
  case 'unchanged':
    console.log(`模型列表已是最新（${result.entries.length} 个模型），未改动文件。`);
    break;
  case 'disabled':
    console.log('模型列表同步未开启。');
    break;
  default:
    console.error(`未同步：${result.reason ?? result.state}`);
    process.exit(1);
}
