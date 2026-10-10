// 一次性脚本：把本仓库的插件接入 desktop profile。
//
// 为什么用脚本而不是手改 JSON：上一次任务里手工拼 JSON 的编辑通道反复被 auto-review 打断，
// 最后还把 profile 里的依赖行改坏过（`dsh-pet` 被改名成 `dsh-autostart-services`）。
// 这里全程结构化读写，只在目标键上做增补，绝不重排或改写其它字段的语义。
// 唯一的"改写"是插件改名：旧包名的依赖行删掉、bundles 里的旧名原位换成新名（保持层栈顺序）。
//
// 用法：node scripts/wire-plugins.mjs [profilePackageJsonPath]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录：从脚本自身位置推，跟 cwd 无关（在哪个目录调用都指向同一处）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 目标 profile 的 package.json。
 *
 * 优先级：命令行参数 → DSH_PROFILE_DIR（DSH 运行期就会设，最准）→
 * DSH_HOME / DSH_PROFILE 拼出来 → ~/.dsh/profiles/desktop。
 * 不写死用户名：os.homedir() 在 Windows 上读的就是 USERPROFILE。
 */
function resolveProfilePath() {
  const explicit = (process.argv[2] ?? '').trim();
  if (explicit) return explicit;

  const profileDir = (process.env.DSH_PROFILE_DIR ?? '').trim();
  if (profileDir) return join(profileDir, 'package.json');

  const dshHome = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  const profile = (process.env.DSH_PROFILE ?? '').trim() || 'desktop';
  return join(dshHome, 'profiles', profile, 'package.json');
}

const PROFILE = resolveProfilePath();

/** 要接入的插件：包名 + 本地目录（file: 协议，DSH profile 的既有做法）。 */
const PLUGINS = [
  { name: 'dsh-autostart-workbuddy', dir: join(REPO_ROOT, 'dsh-autostart-workbuddy') },
  { name: 'dsh-tavily-search', dir: join(REPO_ROOT, 'dsh-tavily-search'), formerly: ['dsh-autostart-websearch'] },
];

// profile 是活配置：往 dependencies 里写一个不存在的目录，下次 pnpm install 就会失败。
// 所以先确认插件目录真的在，再动文件。
for (const { name, dir } of PLUGINS) {
  if (!existsSync(dir)) {
    throw new Error(`插件目录不存在：${dir}（${name}）——脚本要放在仓库的 scripts/ 下运行`);
  }
}

const pkg = JSON.parse(readFileSync(PROFILE, 'utf8'));

const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();

// profile 是 DSH 的活配置：改坏了整个桌面端起不来，所以先落一份带时间戳的备份。
const backup = `${PROFILE}.bak-before-wire-plugins-${stamp}`;
copyFileSync(PROFILE, backup);
console.log(`backup: ${backup}`);

const changed = [];

if (typeof pkg.dependencies !== 'object' || pkg.dependencies === null || Array.isArray(pkg.dependencies)) {
  throw new Error('profile 的 dependencies 不是对象，拒绝继续');
}
for (const { name, dir, formerly = [] } of PLUGINS) {
  // 改名前的旧依赖行留着的话，pnpm install 会因为目录已不存在而失败
  for (const old of formerly) {
    if (old in pkg.dependencies) {
      changed.push(`dependencies.${old}: 删除（已改名为 ${name}）`);
      delete pkg.dependencies[old];
    }
  }
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
for (const { name, formerly = [] } of PLUGINS) {
  // 顺序即 patch 层栈：改名的插件原位替换，新插件追加在末尾。各插件都只 insert 自己的行，不覆盖别家配置。
  for (const old of formerly) {
    const index = bundles.indexOf(old);
    if (index === -1) continue;
    if (bundles.includes(name)) {
      bundles.splice(index, 1);
      changed.push(`bundles: -= ${old}（新名 ${name} 已在列表里）`);
    } else {
      bundles[index] = name;
      changed.push(`bundles: ${old} → ${name}（原位替换）`);
    }
  }
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
