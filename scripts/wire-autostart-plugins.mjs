// 一次性脚本：把拆分后的两个 autostart 插件接入 desktop profile。
//
// 为什么用脚本而不是手改 JSON：上一次任务里手工拼 JSON 的编辑通道反复被 auto-review 打断，
// 最后还把 profile 里的依赖行改坏过（`dsh-pet` 被改名成 `dsh-autostart-services`）。
// 这里全程结构化读写，只在目标键上做增补，绝不重排或改写其它字段的语义。
//
// 用法：node scripts/wire-autostart-plugins.mjs [profilePackageJsonPath]
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const PROFILE =
  process.argv[2] ?? 'C:\\Users\\Mydei\\.dsh\\profiles\\desktop\\package.json';

/** 要接入的插件：包名 + 本地目录（file: 协议，DSH profile 的既有做法）。 */
const PLUGINS = [
  { name: 'dsh-autostart-workbuddy', dir: 'D:\\Project\\DeepSeek Harness\\dsh-autostart-workbuddy' },
  { name: 'dsh-autostart-websearch', dir: 'D:\\Project\\DeepSeek Harness\\dsh-autostart-websearch' },
];

const pkg = JSON.parse(readFileSync(PROFILE, 'utf8'));

const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();

// profile 是 DSH 的活配置：改坏了整个桌面端起不来，所以先落一份带时间戳的备份。
const backup = `${PROFILE}.bak-before-autostart-split-${stamp}`;
copyFileSync(PROFILE, backup);
console.log(`backup: ${backup}`);

const changed = [];

if (typeof pkg.dependencies !== 'object' || pkg.dependencies === null || Array.isArray(pkg.dependencies)) {
  throw new Error('profile 的 dependencies 不是对象，拒绝继续');
}
for (const { name, dir } of PLUGINS) {
  const spec = `file:${dir}`;
  if (pkg.dependencies[name] !== spec) {
    changed.push(`dependencies.${name}: ${pkg.dependencies[name] ?? '(缺失)'} → ${spec}`);
    pkg.dependencies[name] = spec;
  }
}
// 按 key 排序写回，保持与既有文件一致的排布。
pkg.dependencies = Object.fromEntries(
  Object.entries(pkg.dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);

const bundles = pkg.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  throw new Error('profile 的 dsh.profile.bundles 不是数组，拒绝继续');
}
for (const { name } of PLUGINS) {
  // 顺序即 patch 层栈：追加在末尾。两个插件都只 insert 自己的行，不覆盖别家配置。
  if (!bundles.includes(name)) {
    changed.push(`bundles: += ${name}（追加到末尾）`);
    bundles.push(name);
  }
}

writeFileSync(PROFILE, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`written ${PROFILE}`);
console.log(changed.length > 0 ? `changes:\n  - ${changed.join('\n  - ')}` : 'changes: 无（已是最新）');
console.log(`dependencies: ${Object.keys(pkg.dependencies).join(', ')}`);
console.log(`bundles: ${bundles.join(', ')}`);
