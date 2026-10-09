/**
 * 排障入口：不开 DSH 也能看到插件"将要做什么"。
 *
 *   node lib/cli.js            打印解析后的服务规格
 *   node lib/cli.js --check    额外校验 node / server.js / .env 是否存在、TAVILY_API_KEY 是否就绪、端口当前状态
 *
 * 只读：绝不 spawn 任何进程，也不会停止已在运行的服务。
 */

import { resolvePluginConfig, describeConfig } from './config.js';
import { isFile, probeTcp } from './services.js';

const check = process.argv.includes('--check');
const resolved = resolvePluginConfig({}, process.env);
const info = describeConfig(resolved);
const exists = (path) => (path ? isFile(path) : false);
const mark = (path) => (check ? (exists(path) ? '  [存在]' : '  [缺失]') : '');

console.log(`插件启用: ${resolved.enabled}`);
console.log(`日志目录: ${resolved.logDir}`);
console.log('');
console.log(`── ${info.title} (${info.key})`);
console.log(`   端点    : ${info.endpoint}`);
console.log(`   node    : ${info.exe}${mark(info.exe)}`);
console.log(`   脚本    : ${info.script}${mark(info.script)}`);
console.log(`   .env    : ${info.envFile}${mark(info.envFile)}`);
console.log(`   工作目录: ${info.cwd}`);
console.log(`   argv    : ${JSON.stringify(info.args)}`);
console.log(
  `   必需变量: TAVILY_API_KEY${info.missing.length ? `  [缺失: ${info.missing.join(', ')}]` : '  [已就绪]'}`,
);
if (check) {
  const listening = await probeTcp(resolved.spec.port, resolved.spec.host);
  console.log(`   端口状态: ${listening ? '已在监听（插件会跳过启动）' : '空闲（插件会拉起）'}`);
}
console.log('');

// .env 缺失不算问题：宿主环境里直接导出 TAVILY_API_KEY 同样可用。
const problems =
  (exists(info.exe) ? 0 : 1) + (exists(info.script) ? 0 : 1) + info.missing.length;
if (check && problems > 0) {
  console.log(`检查发现 ${problems} 处问题，服务将无法启动。`);
  process.exitCode = 1;
} else {
  console.log('检查通过。');
}
