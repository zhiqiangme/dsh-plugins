// 把本仓库的 DSH 插件安装 / 更新 / 卸载到 DSH 的 profile，或查看安装状态。
//
// 入口是仓库根目录的 install-plugins.cmd（可双击）。它用 DSH 安装包自带的 node.exe（primary runtime）
// 执行本脚本，所以用户机器上不需要另装 Node.js。
// 本脚本只用 Node 内置模块；不带参数时逐项询问，带参数时跳过对应问题：
//
//   install-plugins.cmd --action install --plugins all --profiles desktop,web --yes
//
// 真正干活的是 DSH 自带的 `dsh plugin --profile <名> add|remove ...`：它在 profile 锁内跑 DSH 自带的 pnpm，
// 同时维护 package.json 的 dependencies 和 dsh.profile.bundles，并做插件兼容性检查，所以这里不手改 package.json。
//
// 为什么"更新"要先 remove 再 add：插件以 file: 依赖拷贝进 profile 的 node_modules，源码改动后
// 再次 add（包括 --force）pnpm 都认为"已是最新"不会重新拷贝；只有先移除再添加才会拿到新代码。
// 移除只动 package.json，插件写在 cordis.patch.yml 里的配置行（如模型白名单）原样保留。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** 仓库根目录：从脚本自身位置推，与 cwd 无关。 */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 本仓库提供的插件。legacy 是改名前的包名：profile 里还留着旧名时一并移除，
 * 否则旧目录已不存在，会让 pnpm 安装失败。
 */
const CATALOG = [
  { name: 'dsh-autostart-workbuddy', alias: 'workbuddy', title: 'WorkBuddy 自动启动 + 模型同步', legacy: [] },
  { name: 'dsh-tavily-search', alias: 'tavily-search', title: 'Tavily 网页搜索', legacy: ['dsh-autostart-websearch'] },
].map((plugin) => ({ ...plugin, dir: join(REPO_ROOT, plugin.name) }));

/** 面向用户的 profile 选项。CLI 对应 DSH 的 headless profile（`dsh headless "任务"`）：这一版 DSH 没有单独的 tui 模板。 */
const PROFILE_CHOICES = [
  { name: 'desktop', title: 'Desktop（桌面版）' },
  { name: 'web', title: 'Web（dsh web）' },
  { name: 'headless', title: 'CLI（dsh headless）' },
];

// ---------- 输出 ----------

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const step = (text) => console.log(`\n${paint(36, `== ${text}`)}`);
const ok = (text) => console.log(paint(32, `  ${text}`));
const warn = (text) => console.log(paint(33, `  ${text}`));
const bad = (text) => console.log(paint(31, `  ${text}`));

// ---------- 交互 ----------

/**
 * 逐行读 stdin。自己排队而不是每次 rl.question：管道输入时多行会一次到达，question 会丢掉后面的行。
 * terminal: false 让控制台保持行编辑模式，不进 raw 模式，调用 dsh 子进程时也不受影响。
 * stdin 结束（如管道读完）后再问一律返回 null：菜单和确认会报错退出，不拿默认值替用户做决定。
 */
const NO_INPUT = '读不到键盘输入（stdin 已关闭）。请在终端里运行，或用 --action / --plugins / --profiles / --yes 指定全部选项。';

let reader;
function ask(prompt) {
  if (!reader) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    reader = { lines: [], waiter: null, closed: false, rl };
    rl.on('line', (line) => {
      if (reader.waiter) {
        const waiter = reader.waiter;
        reader.waiter = null;
        waiter(line);
      } else {
        reader.lines.push(line);
      }
    });
    rl.on('close', () => {
      reader.closed = true;
      reader.waiter?.(null);
    });
  }
  process.stdout.write(prompt);
  if (reader.lines.length > 0) return Promise.resolve(reader.lines.shift());
  if (reader.closed) return Promise.resolve(null);
  return new Promise((done) => { reader.waiter = done; });
}

/** 单选菜单：直接回车取第一项（默认）。返回选中项下标。 */
async function choose(question, options) {
  console.log(`\n${question}`);
  options.forEach((option, i) => console.log(`  [${i + 1}] ${option}${i === 0 ? '（默认）' : ''}`));
  for (;;) {
    const answer = (await ask('请输入序号，直接回车用默认：'))?.trim();
    // stdin 已结束：没人在场作答，不能拿默认值替用户做决定（否则会悄悄装进 desktop）
    if (answer === undefined) throw new Error(NO_INPUT);
    if (answer === '') return 0;
    const number = Number(answer);
    if (Number.isInteger(number) && number >= 1 && number <= options.length) return number - 1;
    warn(`无效输入：${answer}`);
  }
}

async function confirm(question) {
  const answer = await ask(`${question} [Y/n] `);
  // stdin 已结束（管道读完）说明没人在场确认，不能当作同意；要无人值守请用 --yes
  if (answer === null) throw new Error(NO_INPUT);
  return ['', 'y', 'yes', '是'].includes(answer.trim().toLowerCase());
}

// ---------- DSH 与 profile ----------

/**
 * 找 DSH 自带的命令行入口 dsh.cmd。桌面版安装时会把 resources\runtime\cli\bin 加进用户 PATH；
 * 没加的话按默认安装位置找。也可以用环境变量 DSH_CLI 指定。
 */
function resolveDshCli() {
  const explicit = (process.env.DSH_CLI ?? '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir.replace(/^"|"$/g, ''), 'dsh.cmd');
    if (dir && existsSync(candidate)) return candidate;
  }
  const fallback = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  if (existsSync(fallback)) return fallback;
  throw new Error('找不到 DSH 的命令行入口 dsh.cmd。请先安装 DeepSeek Harness 桌面版，或用环境变量 DSH_CLI 指向 dsh.cmd。');
}

/** 与 DSH 的 resolveDshHome 一致：DSH_HOME 优先，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim();
  return resolve(fromEnv || join(homedir(), '.dsh'));
}

const profileDir = (profile) => join(dshHome(), 'profiles', profile);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readManifest(profile) {
  const path = join(profileDir(profile), 'package.json');
  return existsSync(path) ? readJson(path) : null;
}

const dependenciesOf = (manifest) => manifest?.dependencies ?? {};
const bundlesOf = (manifest) => manifest?.dsh?.profile?.bundles ?? [];

/** 递归列出目录下的文件（不用 readdirSync 的 recursive 选项，兼容较老的 Node）。 */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}

/**
 * 插件目录里会被 pnpm 拷进 profile 的文件：package.json 的 files 列表 + package.json 本身。
 * 返回 相对路径 → SHA256，用来判断 profile 里那份拷贝和仓库是否一致。
 * files 里的通配只出现在最后一段（如 locale/*.json），这里只支持这种写法。
 */
function packageDigest(dir, patterns) {
  const digest = new Map();
  if (!existsSync(dir)) return digest;
  const files = [join(dir, 'package.json')];
  for (const pattern of patterns) {
    const target = join(dir, pattern);
    if (pattern.includes('*')) {
      const slash = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'));
      const parent = target.slice(0, slash);
      const matcher = new RegExp(`^${target.slice(slash + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      if (existsSync(parent)) {
        for (const name of readdirSync(parent)) if (matcher.test(name)) files.push(join(parent, name));
      }
    } else if (existsSync(target)) {
      if (statSync(target).isDirectory()) files.push(...walk(target));
      else files.push(target);
    }
  }
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    digest.set(relative(dir, file).toLowerCase(), createHash('sha256').update(readFileSync(file)).digest('hex'));
  }
  return digest;
}

/** profile 里的拷贝是否与仓库当前代码一致（文件集合与内容都要相同）。 */
function copyIsCurrent(plugin, profile) {
  const installed = join(profileDir(profile), 'node_modules', plugin.name);
  if (!existsSync(installed)) return false;
  const patterns = readJson(join(plugin.dir, 'package.json')).files ?? [];
  const want = packageDigest(plugin.dir, patterns);
  const have = packageDigest(installed, patterns);
  if (want.size !== have.size) return false;
  for (const [key, hash] of want) if (have.get(key) !== hash) return false;
  return true;
}

/** 依赖是不是指向本仓库这个目录的 file: 依赖（pnpm 会把反斜杠改写成正斜杠，比较前统一）。 */
function specPointsHere(spec, plugin) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return false;
  const normalize = (path) => resolve(path).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(spec.slice(5)) === normalize(plugin.dir);
}

/**
 * 找正在使用该 profile 的 DSH 进程。DSH 的 CLI 和桌面宿主都是 "DeepSeek Harness.exe" 以 Node 模式运行：
 * - 桌面宿主：命令行含 dsh-desktop-host\lib\index.js 和 profile 目录；
 * - CLI（dsh web / dsh headless）：命令行含 dsh-desktop-host\lib\cli.js 和 profile 名（排除 dsh plugin 自己）。
 * 进程命令行只能经 WMI 拿到，借 Windows 自带的 powershell.exe 查；查不到时当作没在运行（只用于提醒）。
 */
function profileProcesses(profile) {
  const command = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  let processes;
  try {
    processes = [].concat(JSON.parse(result.stdout));
  } catch {
    return [];
  }
  const dir = profileDir(profile).toLowerCase();
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`(^|\\s)(--profile\\s+)?"?${escaped}"?(\\s|$)`, 'i');
  return processes.filter(({ CommandLine }) => {
    const line = String(CommandLine ?? '');
    const lower = line.toLowerCase();
    if (lower.includes('dsh-desktop-host\\lib\\index.js')) return lower.includes(dir);
    const at = lower.indexOf('dsh-desktop-host\\lib\\cli.js');
    if (at < 0) return false;
    const rest = line.slice(at + 'dsh-desktop-host\\lib\\cli.js'.length).replace(/^"/, '').trim();
    return !/(^|\s)plugin(\s|$)/.test(rest) && namePattern.test(rest);
  });
}

/**
 * DSH 要求改 desktop profile 的插件前完全退出桌面版（运行中的宿主会和 pnpm 抢 node_modules）；
 * web / CLI 正在运行时装上的插件也要重启才加载。这里等用户关掉，或放弃这个 profile。
 */
async function waitProfileIdle(profile) {
  for (;;) {
    const running = profileProcesses(profile);
    if (running.length === 0) return true;
    if (profile === 'desktop') warn('DSH 桌面版正在运行。请完全退出（包括托盘图标里的"退出"）后再继续。');
    else warn(`有 DSH 进程正在使用 ${profile} profile（PID ${running.map((p) => p.ProcessId).join(', ')}），请先关掉它。`);
    const answer = await ask('关掉后按回车重试；输入 s 跳过这个 profile：');
    if (answer === null || /^s/i.test(answer.trim())) return false;
  }
}

/** cmd 的参数引号：路径里有空格，dsh.cmd 必须经 cmd.exe 运行（Node 不允许不经 shell 直接 spawn .cmd）。 */
function cmdQuote(value) {
  if (/[%"]/.test(value)) throw new Error(`路径里含有 cmd 无法安全传递的字符（% 或 "）：${value}`);
  return /[\s&|<>^()]/.test(value) ? `"${value}"` : value;
}

let dshCli;
/** 调 dsh plugin；pnpm 的输出直接显示在控制台。返回是否成功。 */
function runDshPlugin(profile, args) {
  console.log(paint(90, `  > dsh plugin --profile ${profile} ${args.join(' ')}`));
  const line = [dshCli, 'plugin', '--profile', profile, ...args].map(cmdQuote).join(' ');
  const result = spawnSync(line, { shell: true, stdio: 'inherit' });
  return result.status === 0;
}

// ---------- 三个动作 ----------

function showStatus(profile, selected) {
  const dir = profileDir(profile);
  step(`${profile}  ${dir}`);
  const manifest = readManifest(profile);
  if (!manifest) {
    warn('尚未创建（安装时会自动创建；desktop 需要先打开一次桌面版）');
    return;
  }
  const dependencies = dependenciesOf(manifest);
  const bundles = bundlesOf(manifest);
  for (const plugin of selected) {
    const label = plugin.name.padEnd(26);
    if (!(plugin.name in dependencies)) {
      console.log(`  ${label} 未安装`);
      continue;
    }
    const installedManifest = join(dir, 'node_modules', plugin.name, 'package.json');
    const version = existsSync(installedManifest) ? `v${readJson(installedManifest).version}` : '';
    const notes = [];
    if (!bundles.includes(plugin.name)) notes.push('已在 DSH 里停用');
    if (!specPointsHere(dependencies[plugin.name], plugin)) notes.push(`来源不是本仓库：${dependencies[plugin.name]}`);
    notes.push(copyIsCurrent(plugin, profile) ? '与仓库一致' : '与仓库代码不同，需要更新');
    const text = `${label} 已安装 ${version}  ${notes.join('；')}`;
    if (notes.length === 1 && notes[0] === '与仓库一致') ok(text);
    else warn(text);
  }
  for (const plugin of CATALOG) {
    for (const old of plugin.legacy) {
      if (old in dependencies) warn(`残留旧包名 ${old}（已改名为 ${plugin.name}），安装时会自动移除`);
    }
  }
}

async function installInto(profile, selected) {
  step(`安装到 ${profile}`);
  const manifest = readManifest(profile);
  if (!manifest && profile === 'desktop') {
    bad('desktop profile 还没初始化：请先打开一次 DSH 桌面版，再完全退出，然后重新运行本脚本。');
    return false;
  }
  if (!(await waitProfileIdle(profile))) {
    warn('已跳过');
    return false;
  }

  const dependencies = dependenciesOf(manifest);
  const bundles = bundlesOf(manifest);
  const legacy = selected.flatMap((plugin) => plugin.legacy.filter((old) => old in dependencies));

  // 已装且来源正确、拷贝与仓库一致、在 DSH 里启用着 → 不动；否则（含被停用的）先移除再添加：
  // 停用的插件 pnpm add 不会重新放回 bundles，用户这次明确要装，就当作重新启用。
  const refresh = [];
  const add = [];
  for (const plugin of selected) {
    if (!(plugin.name in dependencies)) {
      add.push(plugin);
    } else if (specPointsHere(dependencies[plugin.name], plugin) && bundles.includes(plugin.name) && copyIsCurrent(plugin, profile)) {
      ok(`${plugin.name} 已是最新`);
    } else {
      refresh.push(plugin);
      add.push(plugin);
    }
  }
  if (legacy.length === 0 && add.length === 0) return true;

  if (legacy.length > 0) {
    console.log(`  移除旧包名：${legacy.join(', ')}`);
    if (!runDshPlugin(profile, ['remove', ...legacy])) {
      bad('移除旧包名失败');
      return false;
    }
  }
  if (refresh.length > 0) {
    const names = refresh.map((plugin) => plugin.name);
    console.log(`  更新：先移除旧拷贝 ${names.join(', ')}（cordis.patch.yml 里的插件配置会保留）`);
    if (!runDshPlugin(profile, ['remove', ...names])) {
      bad('移除旧拷贝失败，profile 未改动');
      return false;
    }
  }
  if (!runDshPlugin(profile, ['add', ...add.map((plugin) => `file:${plugin.dir}`)])) {
    bad('安装失败（详见上面 pnpm / dsh 的输出）。');
    if (refresh.length > 0) bad('注意：要更新的插件已被移除，排除问题后重新运行本脚本即可装回，原有配置不受影响。');
    return false;
  }
  ok(`已安装：${add.map((plugin) => plugin.name).join(', ')}`);
  return true;
}

async function uninstallFrom(profile, selected) {
  step(`从 ${profile} 卸载`);
  const dependencies = dependenciesOf(readManifest(profile));
  const names = selected.flatMap((plugin) => [plugin.name, ...plugin.legacy]).filter((name) => name in dependencies);
  if (names.length === 0) {
    ok('没有要卸载的插件');
    return true;
  }
  if (!(await waitProfileIdle(profile))) {
    warn('已跳过');
    return false;
  }
  if (!runDshPlugin(profile, ['remove', ...names])) {
    bad('卸载失败（详见上面的输出）');
    return false;
  }
  ok(`已卸载：${names.join(', ')}`);
  console.log('  插件在 cordis.patch.yml 里的配置行没有删除，重新安装后沿用；不需要的话可以在 DSH 设置里清理。');
  return true;
}

// ---------- 参数解析 ----------

const ACTIONS = ['install', 'uninstall', 'status'];

function resolvePlugins(value) {
  const result = [];
  for (const item of value.split(',')) {
    const key = item.trim().toLowerCase();
    if (!key) continue;
    if (key === 'all') return CATALOG;
    const match = CATALOG.find((plugin) => plugin.name === key || plugin.alias === key);
    if (!match) throw new Error(`未知插件：${item}（可选 all、${CATALOG.map((plugin) => plugin.alias).join('、')}）`);
    if (!result.includes(match)) result.push(match);
  }
  return result;
}

function resolveProfiles(value) {
  const result = [];
  for (const item of value.split(',')) {
    let key = item.trim().toLowerCase();
    if (!key) continue;
    if (key === 'cli') key = 'headless';
    // 与 DSH 的 resolveProfileDir 校验一致：profile 名只能是一级目录名
    if (key !== 'all' && (/[\\/]/.test(key) || key === '.' || key === '..' || key === 'node_modules')) throw new Error(`无效的 profile 名：${item}`);
    for (const name of key === 'all' ? PROFILE_CHOICES.map((choice) => choice.name) : [key]) {
      if (!result.includes(name)) result.push(name);
    }
  }
  return result;
}

const HELP = `用法：install-plugins.cmd [--action install|uninstall|status] [--plugins all|workbuddy|tavily-search]
                           [--profiles desktop|web|cli|all|<其它 profile 名>] [--yes]
不带参数时逐项询问；--plugins / --profiles 可用逗号分隔多个值。`;

async function main() {
  const { values } = parseArgs({
    options: {
      action: { type: 'string' },
      plugins: { type: 'string' },
      profiles: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.action !== undefined && !ACTIONS.includes(values.action)) throw new Error(`未知操作：${values.action}\n${HELP}`);
  for (const plugin of CATALOG) {
    if (!existsSync(join(plugin.dir, 'package.json'))) {
      throw new Error(`插件目录不存在：${plugin.dir}。本脚本需要放在仓库的 scripts\\ 目录下运行。`);
    }
  }
  dshCli = resolveDshCli();

  console.log(`DSH 插件安装脚本   仓库：${REPO_ROOT}`);
  console.log(`DSH_HOME：${dshHome()}`);

  const action = values.action ?? ACTIONS[await choose('要做什么？', ['安装 / 更新', '卸载', '查看安装状态'])];

  let plugins;
  if (values.plugins !== undefined) {
    plugins = resolvePlugins(values.plugins);
  } else {
    const index = await choose('选择插件：', ['全部', ...CATALOG.map((plugin) => `${plugin.name}（${plugin.title}）`)]);
    plugins = index === 0 ? CATALOG : [CATALOG[index - 1]];
  }

  let profiles;
  if (values.profiles !== undefined) {
    profiles = resolveProfiles(values.profiles);
  } else {
    const index = await choose('选择 DSH（profile）：', [...PROFILE_CHOICES.map((choice) => choice.title), '全部三个']);
    profiles = index === PROFILE_CHOICES.length ? PROFILE_CHOICES.map((choice) => choice.name) : [PROFILE_CHOICES[index].name];
  }
  if (plugins.length === 0 || profiles.length === 0) throw new Error('没有选中任何插件或 profile');

  if (action === 'status') {
    for (const profile of profiles) showStatus(profile, plugins);
    return 0;
  }

  console.log(`\n将要${action === 'install' ? '安装/更新' : '卸载'}：${plugins.map((plugin) => plugin.name).join(', ')}`);
  console.log(`目标 profile：${profiles.join(', ')}`);
  if (!values.yes && !(await confirm('确认执行？'))) {
    console.log('已取消');
    return 1;
  }

  const failed = [];
  for (const profile of profiles) {
    const done = action === 'install' ? await installInto(profile, plugins) : await uninstallFrom(profile, plugins);
    if (!done) failed.push(profile);
  }
  console.log('');
  if (failed.length > 0) {
    bad(`未完成的 profile：${failed.join(', ')}`);
    return 1;
  }
  ok('全部完成。重启 DSH 后生效（桌面版要完全退出再打开；dsh web / dsh headless 重新启动即可）。');
  return 0;
}

// 显式退出：交互读 stdin 的 readline 会让进程一直挂着
main().then(
  (code) => process.exit(code),
  (error) => {
    bad(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
