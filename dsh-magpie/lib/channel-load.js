import { createHash } from 'node:crypto';
import { PROVIDER_ID } from './config.js';
import { ROUTER_BASE_PATH } from './auto-route.js';

export const SESSION_HEADER = 'x-dsh-magpie-session';
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
    try { const value = this.runningSessions(); return value instanceof Set ? value : undefined; }
    catch { return undefined; }
  }
  prune(live) {
    for (const [scope, sessions] of this.retained) {
      for (const id of sessions.keys()) if (!live?.has(id)) sessions.delete(id);
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
  reserve(scope, session, provider) {
    const token = Symbol('model request');
    this.requests.set(token, { scope, session, provider });
    if (session && this.live()?.has(session)) {
      // 同一会话改用网关或渠道时只保留最新位置；尚未结束的旧请求仍由 requests 单独计数。
      for (const sessions of this.retained.values()) sessions.delete(session);
      if (!this.retained.has(scope)) this.retained.set(scope, new Map());
      this.retained.get(scope).set(session, { provider, token });
    }
    const release = (retain = false) => {
      if (!this.requests.delete(token)) return;
      const sessions = this.retained.get(scope);
      if (sessions?.get(session)?.token === token && (!retain || !this.live()?.has(session))) sessions.delete(session);
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

/** 只向插件本机路由传递不可逆会话标识；不会发给 Magpie 上游或其它 provider。 */
export function registerChannelSessions(ctx, manager) {
  const headersOff = ctx.on?.('llm-pi-ai/request-headers', (request, headers, next) => {
    const result = typeof next === 'function' ? next() : headers;
    if (request.provider !== PROVIDER_ID || !manager.current().autoRoute) return result;
    let url;
    try { url = new URL(request.baseURL); } catch { return result; }
    const id = sessionKey(request.sessionId);
    if (!id || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || (url.pathname !== ROUTER_BASE_PATH && !url.pathname.startsWith(`${ROUTER_BASE_PATH}/`))) return result;
    const outgoing = new Headers(result);
    outgoing.set(SESSION_HEADER, id);
    return outgoing;
  });
  const statusOff = ctx.on?.('agent/status', ({ agent, status }) => {
    const id = sessionKey(agent?.id);
    if (id && status === 'idle') manager.router.releaseSession(id);
  });
  ctx.effect(() => () => { headersOff?.(); statusOff?.(); }, 'dsh-magpie: routing sessions');
}
