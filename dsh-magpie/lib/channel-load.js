import { createHash } from 'node:crypto';
import { PROVIDER_ID } from './config.js';
import { ROUTER_BASE_PATH } from './auto-route.js';

export const SESSION_HEADER = 'x-dsh-magpie-session';
export const PURPOSE_HEADER = 'x-dsh-magpie-purpose';
export function sessionKey(id) {
  if (!['string', 'number'].includes(typeof id) || String(id).length === 0) return undefined;
  return createHash('sha256').update(String(id)).digest('hex');
}

/** 按会话计数；一个会话的多次模型请求和执行工具间隔只占一份，旧宿主无标识时按在途请求计数。 */
export class ChannelLoad {
  constructor({ runningSessions = () => undefined } = {}) {
    this.runningSessions = runningSessions;
    this.requests = new Map();
    this.retained = new Map();
  }
  live() {
    try { const value = this.runningSessions(); return value instanceof Map ? value : undefined; }
    catch { return undefined; }
  }
  turn(session) { return this.live()?.get(session); }
  preferred(scope, session, turn) {
    if (turn === undefined) return undefined;
    const retained = this.retained.get(scope)?.get(session);
    return retained?.turn === turn ? retained.provider : undefined;
  }
  prune(live) {
    for (const [scope, sessions] of this.retained) {
      for (const [id, { turn }] of sessions) {
        if (!live?.has(id) || live.get(id) !== turn) sessions.delete(id);
      }
      if (!sessions.size) this.retained.delete(scope);
    }
  }
  counts(scope, session) {
    this.prune(this.live());
    const providers = new Map();
    const add = (provider, identity) => {
      if (session && identity === session) return;
      if (!providers.has(provider)) providers.set(provider, new Set());
      providers.get(provider).add(identity);
    };
    for (const [id, { provider }] of this.retained.get(scope) ?? []) add(provider, id);
    for (const [token, request] of this.requests) if (request.scope === scope) add(request.provider, request.session ?? token);
    return new Map([...providers].map(([provider, ids]) => [provider, ids.size]));
  }
  reserve(scope, session, provider, turn) {
    const token = Symbol('model request');
    this.requests.set(token, { scope, session, provider });
    const stillRunning = () => {
      const live = this.live();
      return live?.has(session) && live.get(session) === turn;
    };
    // 上一轮的慢请求仍可结束，但不能覆盖新一轮的占用。
    if (stillRunning()) {
      // 同一会话改用网关或渠道时只保留最新位置；尚未结束的旧请求仍由 requests 单独计数。
      for (const sessions of this.retained.values()) sessions.delete(session);
      if (!this.retained.has(scope)) this.retained.set(scope, new Map());
      this.retained.get(scope).set(session, { provider, token, turn });
    }
    const release = (retain = false) => {
      if (!this.requests.delete(token)) return;
      const sessions = this.retained.get(scope);
      if (sessions?.get(session)?.token === token && (!retain || !stillRunning())) sessions.delete(session);
      if (sessions && !sessions.size) this.retained.delete(scope);
    };
    return { release };
  }
  releaseSession(session) {
    if (!session) return;
    for (const sessions of this.retained.values()) sessions.delete(session);
    for (const [token, request] of this.requests) if (request.session === session) this.requests.delete(token);
  }
  clear() { this.requests.clear(); this.retained.clear(); }
}

/** 只向插件本机路由传递会话摘要和标题用途；不会发给 Magpie 上游或其它 provider。 */
export function registerChannelSessions(ctx, manager) {
  const headersOff = ctx.on?.('llm-pi-ai/request-headers', (request, headers, next) => {
    const result = typeof next === 'function' ? next() : headers;
    if (request.provider !== PROVIDER_ID || !manager.current().autoRoute) return result;
    let url;
    try { url = new URL(request.baseURL); } catch { return result; }
    const id = sessionKey(request.sessionId);
    const title = request.purpose === 'session-title';
    if ((!id && !title) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || (url.pathname !== ROUTER_BASE_PATH && !url.pathname.startsWith(`${ROUTER_BASE_PATH}/`))) return result;
    const outgoing = new Headers(result);
    if (id) outgoing.set(SESSION_HEADER, id);
    // 低思考档位也可能来自正常对话，只依据 DSH 明确声明的标题用途隔离辅助请求。
    if (title) outgoing.set(PURPOSE_HEADER, 'session-title');
    else outgoing.delete(PURPOSE_HEADER);
    return outgoing;
  });
  const statusOff = ctx.on?.('agent/status', ({ agent, status }) => {
    const id = sessionKey(agent?.id);
    if (id && status === 'idle') manager.router.releaseSession(id);
  });
  ctx.effect(() => () => { headersOff?.(); statusOff?.(); }, 'dsh-magpie: routing sessions');
}
