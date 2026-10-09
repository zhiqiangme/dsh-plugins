/**
 * 服务定义与进程原语（tavily-anthropic-search 版）。
 *
 * 设计约束：本文件只依赖 node: 内置模块。
 *
 * 为什么不用 ctx.subprocess / ctx.fs / ctx.webServer 等 Host Service：
 *   1. 这些 Service 各有归属插件，加载顺序由 bundle 层栈决定；本插件要做的事
 *      （DSH 启动时拉起一个外部 HTTP 服务）与会话/工具链完全无关，用内置模块可以
 *      彻底摆脱加载顺序，也不会因为某个 Service 缺席而让整个插件不激活。
 *   2. 参考实现 dsh-pet 的桌面 Helper 同样直接用 node:child_process（windowsHide），
 *      本插件沿用这一既有做法，而不是引入新的架构。
 *
 * 默认路径与命令行严格对齐 tavily-anthropic-search/start.ps1，保证「插件启动」
 * 与「手动运行脚本」起出来的是同一种服务。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/** 被托管服务的默认规格；任何字段都可以被 profile 的 config 覆盖。 */
export const SERVICE_DEFAULTS = Object.freeze({
  enabled: true,
  title: 'tavily-anthropic-search',
  key: 'tavily',
  /** server.js 的默认监听端口（若在 .env 里改了 LISTEN_PORT，需同步改本插件配置）。 */
  port: 8787,
  host: '127.0.0.1',
  cwd: 'D:\\Project\\Test\\tavily-anthropic-search',
  script: 'D:\\Project\\Test\\tavily-anthropic-search\\server.js',
  envFile: 'D:\\Project\\Test\\tavily-anthropic-search\\.env',
  args: [],
  logName: 'tavily-shim',
});

/** DSH home：优先 DSH_HOME，其次 ~/.dsh（与 @deepseek-ai/dsh-home-paths 的约定一致）。 */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit ? resolve(explicit) : join(homedir(), '.dsh');
}

/** 日志文件名用的时间戳，与脚本里 `yyyyMMdd-HHmmss` 同格式，便于两处日志对照。 */
function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * 读取 .env（KEY=VALUE，`#` 开头为注释）。
 *
 * 与 tavily start.ps1 的解析规则保持一致：只取第一个 `=` 之前作为键，键为空则跳过；
 * 结果只用于拼装子进程环境，绝不写回 process.env（脚本同样只污染自己那个进程）。
 */
export function parseEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** 在 PATH 中按 Windows 习惯补全扩展名，解析一个可执行文件；找不到返回 undefined。 */
export function resolveExecutableOnPath(command, env = process.env) {
  if (!command) return undefined;
  // 带分隔符的按显式路径处理，不做 PATH 搜索（与 subprocess 契约一致：相对路径不猜）。
  if (command.includes('/') || command.includes('\\')) {
    return isFile(command) ? command : undefined;
  }
  const pathValue = env.PATH || env.Path || '';
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const base = join(dir, command);
    if (isFile(base)) return base;
    for (const ext of exts) {
      const withExt = base + ext.toLowerCase();
      if (isFile(withExt)) return withExt;
      const upper = base + ext.toUpperCase();
      if (isFile(upper)) return upper;
    }
  }
  return undefined;
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析跑 server.js 用的 node 可执行文件。
 *
 * 为什么不能直接用 process.execPath：DSH Desktop 的 Host 是 Electron 可执行文件
 * （`DeepSeek Harness.exe --expose-internals ...`），拿它去跑 .js 会启动 Electron 而不是
 * Node。所以优先走 PATH 里的 node（与 start.ps1 的 `Get-Command node` 同源），
 * 只有 PATH 里确实没有时才退回 execPath + ELECTRON_RUN_AS_NODE 兜底。
 *
 * @returns {{ exe: string, env: Record<string, string> }} env 是需要并入子进程环境的额外变量。
 */
export function resolveNodeRuntime(env = process.env) {
  const override = typeof env.DSH_AUTOSTART_NODE === 'string' ? env.DSH_AUTOSTART_NODE.trim() : '';
  if (override) return { exe: override, env: {} };

  const onPath = resolveExecutableOnPath('node', env);
  if (onPath) return { exe: onPath, env: {} };

  return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** 探测 host:port 是否已能建立 TCP 连接；连接成功即视为服务就绪。 */
export function probeTcp(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待端口就绪。
 *
 * @param shouldContinue 返回 false 时立即放弃（用于「子进程已提前退出」这种必然失败的情况，
 *                       避免白等满超时）。
 */
export async function waitForPort(port, options = {}) {
  const {
    host = '127.0.0.1',
    timeoutMs = 30_000,
    intervalMs = 300,
    signal,
    shouldContinue,
  } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (shouldContinue && !shouldContinue()) return false;
    if (await probeTcp(port, host)) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * 一个被托管的外部服务：负责「按需拉起一次 + 记录归属 + 只停止自己拉起的进程」。
 *
 * 幂等性来源（与 start.ps1 的既有策略一致）：先探测端口。
 * 端口已在监听就认为服务已就绪，绝不重复启动第二个实例——重复启动只会端口冲突。
 */
export class ManagedService {
  /**
   * @param {object} spec 解析合并后的服务规格（见 resolvePluginConfig）。
   * @param {{ info: Function, warn: Function, error: Function }} logger
   */
  constructor(spec, logger) {
    this.spec = spec;
    this.logger = logger;
    this.child = undefined;
    /** 只有本实例真正 spawn 出来的进程才会在停止阶段被结束，避免误杀用户手动起的服务。 */
    this.startedByUs = false;
    this.pid = undefined;
    this.exitInfo = undefined;
    /** stderr 环形缓冲：启动失败时用来给出可诊断的原因，而不是只说「超时」。 */
    this.recentStderr = [];
    this.streams = [];
  }

  get key() {
    return this.spec.key;
  }

  get title() {
    return this.spec.title;
  }

  get port() {
    return this.spec.port;
  }

  isAlive() {
    const child = this.child;
    return Boolean(child) && child.exitCode === null && child.signalCode === null;
  }

  /**
   * 确保服务在监听。
   * @returns {Promise<{ state: 'already-running' | 'started' | 'failed', reason?: string }>}
   */
  async ensureRunning(signal) {
    const { port, host } = this.spec;

    if (await probeTcp(port, host)) {
      this.logger.info(
        `[websearch] ${this.title} 已在 ${host}:${port} 监听，跳过启动（不重复拉起第二个实例）`,
      );
      return { state: 'already-running' };
    }

    if (signal?.aborted) return { state: 'failed', reason: '宿主已开始关闭' };

    const spawnFailure = this.#spawn();
    if (spawnFailure) {
      return { state: 'failed', reason: spawnFailure };
    }

    const ready = await waitForPort(port, {
      host,
      timeoutMs: this.spec.readinessTimeoutMs,
      signal,
      // 子进程已经退出就不必再等满超时：端口永远不会起来了。
      shouldContinue: () => this.isAlive(),
    });

    if (ready) {
      this.logger.info(`[websearch] ${this.title} 已启动 (PID ${this.pid}) → ${host}:${port}`);
      return { state: 'started' };
    }

    const reason = this.#failureReason();
    // 关键：启动失败必须回收自己拉起的进程。否则会留下一个既不监听端口、
    // 又持有日志文件句柄的僵尸进程，并且它会一直挂在宿主进程树里。
    await this.stop('启动失败，回收进程');
    return { state: 'failed', reason };
  }

  #spawn() {
    const spec = this.spec;
    if (!isFile(spec.exe)) {
      return `未找到可执行文件: ${spec.exe}`;
    }
    if (!isFile(spec.script)) {
      return `未找到服务脚本: ${spec.script}`;
    }
    if (spec.requiredEnv) {
      const missing = spec.requiredEnv.filter((name) => !spec.env[name]);
      if (missing.length > 0) {
        return `缺少环境变量 ${missing.join(', ')}（应在 ${spec.envFile ?? '启动环境'} 中配置）`;
      }
    }

    let out;
    let err;
    try {
      mkdirSync(spec.logDir, { recursive: true });
      const stamp = timestamp();
      out = createWriteStream(join(spec.logDir, `${spec.logName}.${stamp}.out.log`), { flags: 'a' });
      err = createWriteStream(join(spec.logDir, `${spec.logName}.${stamp}.err.log`), { flags: 'a' });
    } catch (error) {
      return `无法创建日志文件: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.streams = [out, err];

    let child;
    try {
      child = spawn(spec.exe, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        // 宿主是 GUI 进程：不隐藏窗口会让 node.exe 弹出控制台窗口
        // （对应脚本里的 -WindowStyle Hidden）。
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#closeStreams();
      return `无法启动进程: ${error instanceof Error ? error.message : String(error)}`;
    }

    this.child = child;
    this.startedByUs = true;
    this.pid = child.pid;

    child.stdout?.pipe(out);
    child.stderr?.on('data', (chunk) => {
      err.write(chunk);
      this.#rememberStderr(String(chunk));
    });
    child.once('error', (error) => {
      this.exitInfo = { error: error instanceof Error ? error.message : String(error) };
      this.logger.error(`[websearch] ${this.title} 进程错误: ${this.exitInfo.error}`);
    });
    child.once('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.#closeStreams();
      // 正常停止（disposer 主动 kill）不算异常，只有「非预期退出」才值得报警。
      if (!this.stopping) {
        this.logger.warn(`[websearch] ${this.title} 已退出 (code=${code}, signal=${signal})`);
      }
    });

    return undefined;
  }

  #rememberStderr(text) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.recentStderr.push(trimmed);
      if (this.recentStderr.length > 20) this.recentStderr.shift();
    }
  }

  #failureReason() {
    if (this.exitInfo?.error) return `启动失败: ${this.exitInfo.error}`;
    if (this.exitInfo) {
      return `${this.title} 提前退出 (code=${this.exitInfo.code}, signal=${this.exitInfo.signal})`;
    }
    const tail = this.recentStderr.length > 0 ? `；stderr: ${this.recentStderr.slice(-3).join(' | ')}` : '';
    return `${this.spec.readinessTimeoutMs}ms 内未确认 ${this.spec.host}:${this.spec.port} 监听${tail}`;
  }

  /**
   * 停止本实例拉起的进程。
   *
   * 只处理 startedByUs 的进程：DSH 启动前就已在运行的服务（用户手动起的、或另一个
   * DSH 实例留下的）不属于本实例，跟着停会误杀用户自己起的服务。
   */
  async stop(reason) {
    if (!this.startedByUs || !this.child) {
      return { stopped: false, skipped: true };
    }
    const child = this.child;
    if (!this.isAlive()) {
      return { stopped: false, skipped: true };
    }

    this.stopping = true;
    this.logger.info(`[websearch] 停止 ${this.title} (PID ${this.pid})：${reason}`);
    try {
      child.kill();
    } catch (error) {
      this.logger.warn(`[websearch] 停止 ${this.title} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    const exited = await waitForExit(child, this.spec.stopTimeoutMs);
    if (!exited) {
      this.logger.warn(`[websearch] ${this.title} 未在 ${this.spec.stopTimeoutMs}ms 内退出，强制结束`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经死了：忽略 */
      }
      await waitForExit(child, 2000);
    }
    this.#closeStreams();
    return { stopped: true, skipped: false };
  }

  /**
   * 进程退出钩子里用的同步版本：只发信号、不等待。
   * `process.on('exit')` 阶段不允许异步操作，所以这里不能复用 stop()。
   */
  stopSync() {
    if (!this.startedByUs || !this.isAlive()) return;
    this.stopping = true;
    try {
      this.child.kill();
    } catch {
      /* 已经死了：忽略 */
    }
  }

  #closeStreams() {
    for (const stream of this.streams) {
      try {
        stream.end();
      } catch {
        /* 忽略 */
      }
    }
    this.streams = [];
  }
}

/** 等待子进程退出；返回是否在超时前退出。 */
export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      done(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    child.once('exit', onExit);
  });
}
