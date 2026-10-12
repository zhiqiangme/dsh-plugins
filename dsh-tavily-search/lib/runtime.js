/**
 * 运行期原语：在 DSH 进程内监听搜索接口、按凭据引用现取 API Key、一次性导入旧 key。
 *
 * 为什么在进程内监听而不是像以前那样 spawn 一个 node 子进程：
 *   适配服务只有几百行、只做 I/O，没有理由单独占一个进程。进程内跑省掉了找 node
 *   可执行文件（DSH Desktop 的 execPath 是 Electron）、等端口就绪、退出时回收子进程
 *   这一整套托管逻辑；出站请求也自然走 DSH 的代理策略（dsh-http-proxy 装的是本进程的
 *   全局 dispatcher，子进程里的 fetch 并不继承它）。
 *
 * 只依赖 node: 内置模块；Host Service（credentials）一律软取，拿不到就降级而不是让插件不激活。
 */

import { createShimServer, SERVICE_ID } from './shim.js';

/** EADDRINUSE 的重试：插件重载时，上一个实例的 close 可能还没走完，先等一等再判定冲突。 */
const LISTEN_RETRIES = 10;
const LISTEN_RETRY_DELAY_MS = 200;

/** 端口被占时探测 /health 的超时：本机回环，超过 1s 就当它不是我们的服务。 */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 软取 Host Service：服务没挂上、或者读属性时抛错（cordis 对未就绪服务会这样）都返回 undefined。
 */
export function getService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined) return viaGet;
    }
  } catch {
    /* 未就绪 */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 等 Host Service 就绪后执行一次回调。
 *
 * 用 ctx.inject 而不是直接读：插件树加载时 credentials 可能还没挂上，直接读会拿到
 * undefined 而静默跳过。注入只影响这一条回调，插件本身仍然不声明任何依赖。
 */
export function whenService(ctx, name, callback) {
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject([name], (scoped) => callback(getService(scoped, name) ?? getService(ctx, name)));
      return;
    } catch {
      /* 老版本没有这个签名时退回直接读取 */
    }
  }
  callback(getService(ctx, name));
}

/** 单个引用现取：凭据库优先（它内部已经包含"启动环境变量"这一层），凭据服务缺席时才退回本进程的环境变量。 */
async function resolveRef(credentials, ref, env) {
  if (typeof credentials?.resolve === 'function') {
    const hit = await credentials.resolve(ref);
    return typeof hit?.value === 'string' ? hit.value.trim() : '';
  }
  return typeof env[ref] === 'string' ? env[ref].trim() : '';
}

/**
 * 按凭据引用现取 API Key。传一组引用时返回按引用顺序排列的非空 key 列表（多 key 轮询用），
 * 传单个引用时返回那一个 key 或 undefined。
 */
export function createKeyResolver(ctx, refs, env = process.env) {
  const list = Array.isArray(refs) ? refs : [refs];
  return async () => {
    const credentials = getService(ctx, 'credentials');
    const values = await Promise.all(list.map((ref) => resolveRef(credentials, ref, env)));
    const keys = values.filter(Boolean);
    return Array.isArray(refs) ? keys : keys[0];
  };
}

/** 卡片里用来区分各个 key 的尾巴：只露最后 4 位；太短的 key 露尾巴等于露一半，干脆不露。 */
const KEY_TAIL_CHARS = 4;
const KEY_TAIL_MIN_LENGTH = 12;

export function keyTail(value) {
  return typeof value === 'string' && value.length >= KEY_TAIL_MIN_LENGTH ? value.slice(-KEY_TAIL_CHARS) : '';
}

/**
 * 给插件页卡片列出每个 key 槽位：有没有配置、能不能改、来源，以及末 4 位用于辨认。
 * 完整的值绝不离开宿主进程。凭据服务缺席时按环境变量报告（只读）。
 *
 * @returns {() => Promise<Array<{ ref: string, configured: boolean, writable: boolean, source?: string, tail: string }>>}
 */
export function createKeyInspector(ctx, refs, env = process.env) {
  return async () => {
    const credentials = getService(ctx, 'credentials');
    return Promise.all(
      refs.map(async (ref) => {
        const value = await resolveRef(credentials, ref, env);
        if (typeof credentials?.describe !== 'function') {
          return { ref, configured: Boolean(value), writable: false, ...(value ? { source: 'env' } : {}), tail: keyTail(value) };
        }
        const info = (await credentials.describe(ref)) ?? {};
        return {
          ref,
          configured: info.configured === true || Boolean(value),
          writable: info.writable !== false,
          ...(info.source ? { source: info.source } : {}),
          tail: keyTail(value),
        };
      }),
    );
  };
}

/** 端口被占时，看看占着的是不是同一种适配服务（例如手动起的旧 server.js）。 */
async function probeShimHealth(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    const body = await response.json();
    return body?.service === SERVICE_ID || body?.provider === 'tavily';
  } catch {
    return false;
  }
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 搜索接口的运行时：持有 http.Server 与状态，供插件生命周期与面板路由共用。
 *
 * 状态：
 *   - starting  正在监听
 *   - listening 本插件在监听
 *   - external  端口上已有同类适配服务（不是本插件起的），DSH 的请求由它处理
 *   - conflict  端口被其它程序占用
 *   - failed    监听失败（权限、地址非法等）
 *   - stopped   已停止（插件卸载）
 */
export class ShimRuntime {
  #server;
  #state = { state: 'stopped', reason: '' };
  #stopping = false;

  constructor({ host, port, endpoint, shim, resolveApiKey, missingKeyHint, logger, label }) {
    this.host = host;
    this.port = port;
    this.endpoint = endpoint;
    this.logger = logger;
    this.label = label;
    this.#server = createShimServer({ ...shim, resolveApiKey, ...(missingKeyHint ? { missingKeyHint } : {}) });
  }

  status() {
    return { ...this.#state, host: this.host, port: this.port, endpoint: this.endpoint };
  }

  async start() {
    this.#state = { state: 'starting', reason: '' };
    for (let attempt = 1; ; attempt += 1) {
      if (this.#stopping) return this.status();
      try {
        await listenOnce(this.#server, this.port, this.host);
        this.#state = { state: 'listening', reason: '' };
        this.logger.info(`[${this.label}] 搜索接口已就绪：${this.endpoint}`);
        return this.status();
      } catch (error) {
        if (error?.code !== 'EADDRINUSE') {
          this.#state = { state: 'failed', reason: message(error) };
          this.logger.error(`[${this.label}] 搜索接口监听失败：${message(error)}`);
          return this.status();
        }
        if (attempt >= LISTEN_RETRIES) break;
        await sleep(LISTEN_RETRY_DELAY_MS);
      }
    }

    if (await probeShimHealth(this.host, this.port)) {
      this.#state = {
        state: 'external',
        reason: `端口 ${this.port} 上已有另一个 Tavily 适配服务在运行（不是本插件启动的），本插件不再重复监听`,
      };
      this.logger.warn(`[${this.label}] ${this.#state.reason}`);
    } else {
      this.#state = { state: 'conflict', reason: `端口 ${this.port} 已被其它程序占用` };
      this.logger.error(`[${this.label}] ${this.#state.reason}，搜索接口未启动`);
    }
    return this.status();
  }

  async stop() {
    this.#stopping = true;
    const server = this.#server;
    if (!server.listening) {
      this.#state = { state: 'stopped', reason: '' };
      return;
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      // keep-alive 连接不主动断开的话 close 会一直等下去，插件卸载就卡住
      server.closeAllConnections?.();
    });
    this.#state = { state: 'stopped', reason: '' };
    this.logger.info(`[${this.label}] 搜索接口已停止`);
  }
}

/**
 * 一次性导入旧 key：凭据库里还没有、且可写时，把 .env 里的同名变量写进去。
 *
 * 只在"未配置"时写，所以重复启动是幂等的；凭据被启动环境变量占着（只读）时不写。
 * 旧文件原样保留——删不删由用户决定。
 *
 * @returns {Promise<'imported' | 'configured' | 'read-only' | 'absent' | 'unavailable'>}
 */
export async function importLegacyKey(credentials, { ref, value }) {
  if (!value) return 'absent';
  if (typeof credentials?.describe !== 'function' || typeof credentials?.set !== 'function') return 'unavailable';
  const info = await credentials.describe(ref);
  if (info?.configured) return 'configured';
  if (info?.writable === false) return 'read-only';
  await credentials.set(ref, value);
  return 'imported';
}
