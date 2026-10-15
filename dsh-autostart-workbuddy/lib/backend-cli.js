/**
 * 后端版本管理 CLI：不开 DSH 也能看状态、查更新、安装与回滚。
 *
 *   node lib/backend-cli.js                 打印本地布局与版本（不联网）
 *   node lib/backend-cli.js --check         再查一次上游最新 release
 *   node lib/backend-cli.js --update        下载并安装最新 release
 *   node lib/backend-cli.js --rollback      回滚到上一版本
 *   node lib/backend-cli.js --adopt [tag]   把现场已有的 exe 纳管（写 installed.json）
 *
 * 配置来源：与插件一致走 resolvePluginConfig 的默认值，外加环境变量
 * `DSH_WORKBUDDY_BACKEND_ROOT` 可整体换根目录。profile 里对 `config.backend.*`
 * 的覆盖只在 DSH 内生效（CLI 不解析 profile 的 YAML 片段，避免两套解析器打架）；
 * 需要按 profile 配置操作时请用面板。
 *
 * 关于停进程：--update / --rollback 需要先停掉后端（Windows 下运行中的 exe 被锁）。
 * 本 CLI 自己 new 一个 ManagedService，因此**只能停它自己拉起的进程**；
 * 如果后端是 DSH 拉起的，会明确拒绝并提示改用面板——不会去杀别人的进程。
 * 更新/回滚后为做健康检查拉起的后端是本 CLI 的子进程，结束前停掉它：否则 CLI 要等后端退出才返回，
 * 而后端本来就该由 DSH 下次启动时托管。
 */

import {
  adoptCurrentBinary,
  applyUpdate,
  backendPaths,
  checkForUpdate,
  describeBackend,
  rollbackBackend,
} from './backend.js';
import { resolvePluginConfig } from './config.js';
import { ManagedService } from './services.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

// 根目录可以用环境变量整体覆盖；其余按插件默认值。
const resolved = resolvePluginConfig({}, process.env);
const backend = resolved.backend;
const paths = backend.paths ?? backendPaths(process.env);
const apiBase = backend.apiBase || undefined;

function printStatus() {
  const snapshot = describeBackend(paths);
  const version = snapshot.version;
  console.log(`后端根目录 : ${snapshot.root}`);
  console.log(`可执行文件 : ${snapshot.exe}${snapshot.exeExists ? '' : '  [缺失]'}`);
  console.log(`配置文件   : ${snapshot.config}${snapshot.configExists ? '' : '  [缺失]'}`);
  console.log(
    `当前版本   : ${version.tag ?? '(未纳管)'}  ${version.revision ? version.revision.slice(0, 7) : '(读不到构建信息)'}`,
  );
  if (version.builtAt) console.log(`构建时间   : ${version.builtAt}`);
  if (version.drifted) console.log('提示       : 清单里的 commit 与二进制不一致（exe 被手动换过？）');
  console.log(
    `历史版本   : ${snapshot.history.length ? snapshot.history.map((item) => item.name).join(', ') : '(无)'}`,
  );
}

function exitWith(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

async function main() {
  if (has('--adopt')) {
    const tag = valueOf('--adopt');
    const result = adoptCurrentBinary(paths, { tag: tag && !tag.startsWith('--') ? tag : null });
    if (!result.ok) return exitWith(`纳管失败：${result.reason}`);
    console.log(`已纳管：${result.version.tag ?? '(无 tag)'}  ${result.version.revision.slice(0, 7)}`);
    return printStatus();
  }

  if (has('--update') || has('--rollback')) {
    const service = new ManagedService(resolved.spec, logger);
    try {
      if (has('--update')) {
        const result = await applyUpdate({
          paths,
          env: process.env,
          apiBase,
          service,
          logger,
          keepVersions: backend.keepVersions,
        });
        printResult(result);
        return result.ok ? undefined : exitWith(`更新失败：${result.reason ?? result.state}`);
      }
      const result = await rollbackBackend({ paths, service, logger });
      printResult(result);
      return result.ok ? undefined : exitWith(`回滚失败：${result.reason ?? result.state}`);
    } finally {
      await service.stop('命令行操作完成，后端交给 DSH 下次启动时托管');
    }
  }

  printStatus();

  if (has('--check')) {
    console.log('');
    try {
      const check = await checkForUpdate({
        paths,
        env: process.env,
        apiBase,
        ttlMs: backend.checkTtlMs,
        force: has('--force'),
      });
      const current = check.local.tag ?? check.local.revision?.slice(0, 7) ?? '未知';
      console.log(`上游最新   : ${check.latest.tag}  ${check.latest.commit.slice(0, 7)}  ${check.latest.publishedAt}`);
      console.log(`状态       : ${check.upToDate ? `已是最新（${current}）` : `可更新：${current} → ${check.latest.tag}`}`);
      if (check.fromCache) console.log('（结果来自本地缓存，加 --force 可强制重新查询）');
    } catch (error) {
      return exitWith(`检查更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function printResult(result) {
  if (result.ok) {
    console.log(`完成：${result.state}`);
    if (result.health) console.log(`健康检查：healthy=${result.health.healthy} total=${result.health.total}`);
    if (result.health?.servable === false) console.log('后端已启动，但还没有可用的 WorkBuddy 账号：请打开后端面板登录。');
    if (result.local) console.log(`当前版本：${result.local.tag ?? result.local.revision?.slice(0, 7)}`);
    if (result.pruned?.length) console.log(`已清理旧版本：${result.pruned.join(', ')}`);
    return;
  }
  console.error(`失败：${result.state}${result.reason ? ` — ${result.reason}` : ''}`);
  if (result.rolledBack) console.error('已自动回滚到上一个版本。');
}

await main();
