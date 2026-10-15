/**
 * 排障入口：不开 DSH 也能看到插件"将要做什么"。
 *
 *   node lib/cli.js            打印解析后的服务规格与模型列表同步配置
 *   node lib/cli.js --check    额外校验可执行文件 / profile 配置是否存在、端口当前状态
 *
 * 只读：绝不 spawn 任何进程、不联网、不改任何文件（预览模型列表用 lib/sync-cli.js）。
 */

import { readFileSync } from 'node:fs';

import { resolvePluginConfig, describeConfig } from './config.js';
import { modelsEndpoint, readPluginModelsConfig, resolveProfilePatchPath } from './models.js';
import { isFile, probeTcp } from './services.js';

const PLUGIN_ID = 'dsh-opencode2api';
const check = process.argv.includes('--check');

// 插件运行时由宿主把 config 传进来；命令行里没有宿主，所以直接从 profile 读同一份配置，
// 这样诊断出来的就是"下次启动实际会用的设置"。
const patchPath = resolveProfilePatchPath(process.env, '');
const modelsRaw = patchPath && isFile(patchPath)
  ? readPluginModelsConfig(readFileSync(patchPath, 'utf8'), PLUGIN_ID)
  : undefined;

const resolved = resolvePluginConfig(modelsRaw ? { models: modelsRaw } : {}, process.env);
const info = describeConfig(resolved);

console.log(`插件启用: ${resolved.enabled}`);
console.log(`日志目录: ${resolved.logDir}`);
console.log('');
console.log(`── ${info.title} (${info.key})`);
console.log(`   端点    : ${info.endpoint}`);
console.log(`   可执行  : ${info.exe}${check ? (isFile(info.exe) ? '  [存在]' : '  [缺失]') : ''}`);
console.log(`   工作目录: ${info.cwd}`);
console.log(`   argv    : ${JSON.stringify(info.args)}`);
if (check) {
  const listening = await probeTcp(resolved.spec.port, resolved.spec.host);
  console.log(`   端口状态: ${listening ? '已在监听（插件会跳过启动）' : '空闲（插件会拉起）'}`);
}
console.log('');

const models = resolved.models;
console.log(`── 模型列表同步 (${models.enabled ? '开启' : '关闭'})`);
if (models.enabled) {
  // 运行时由 DSH 的 configEditor 写入宿主当前 profile；这里只能按环境变量猜同一个文件。
  console.log(`   profile : ${patchPath ?? '(无法确定：缺 DSH_PROFILE_DIR / DSH_PROFILE)'}${
    check && patchPath ? (isFile(patchPath) ? '  [存在]' : '  [缺失]') : ''
  }`);
  console.log(`   接口    : ${modelsEndpoint(models.baseURL)}`);
  console.log(`   面板配置: ${models.panelConfig}`);
  console.log(
    `   范围    : ${models.only.length > 0 ? `白名单 ${models.only.length} 个模型` : '后端全部模型'}${
      models.exclude.length > 0 ? `，排除 ${models.exclude.length} 个` : ''
    }`,
  );
  console.log(`   思考档位: ${models.efforts === 'auto' ? '按上游声明' : models.efforts.join('/')}`);
} else {
  console.log('   说明    : 只拉起后端，不动 profile 里的模型列表');
}
console.log('');

if (check && !isFile(info.exe)) {
  console.log('检查发现 1 处问题：可执行文件缺失。');
  process.exitCode = 1;
} else {
  console.log('检查通过。');
}
