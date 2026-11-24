import { isLocal } from './config.js';
import { hostService } from './runtime.js';

export const WEB_UI_PREFIX = '/plugins/dsh-magpie/ui';
export const WEB_UI_ENTRY = `${WEB_UI_PREFIX}/`;

// 代理单次请求体上限：足以覆盖 Magpie 配置、导入与普通表单提交，同时避免内存被大包撑爆。
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'origin', 'referer', 'cookie', 'content-length',
]);
const STRIPPED_RESPONSE = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-encoding', 'content-length',
  'set-cookie', 'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
]);

// 注入到 Magpie 入口 HTML 顶部：仅在 iframe 内将写死根路径的接口、SSE 与 History 路由收敛到同源反代前缀，
// 避免与 DSH 自身占用的 /api/... 或根路径冲突；相对路径（如 boot.js、app.css、plugins/...）保持原样。
function prefixBootstrapScript(prefix) {
  const escaped = JSON.stringify(prefix);
  return `<script data-dsh-magpie-proxy>(()=>{const P=${escaped};const fix=(u)=>{if(typeof u!=='string')return u;if(u==='/'||u.startsWith('/?')||u.startsWith('/#'))return P+u;if(u.startsWith('/')&&!u.startsWith('//')&&u!==P&&!u.startsWith(P+'/'))return P+u;if(u.startsWith(location.origin+'/')){const r=u.slice(location.origin.length);if(r!==P&&!r.startsWith(P+'/'))return location.origin+P+r;}return u;};const fixIn=(i)=>{if(typeof i==='string')return fix(i);if(i instanceof URL)return new URL(fix(i.href));if(typeof Request==='function'&&i instanceof Request){const n=fix(i.url);return n===i.url?i:new Request(n,i);}return i;};const of=window.fetch.bind(window);window.fetch=(i,o)=>of(fixIn(i),o);const oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return oo.call(this,m,typeof u==='string'?fix(u):u instanceof URL?fix(u.href):u,...r);};if(typeof window.EventSource==='function'){const OE=window.EventSource;window.EventSource=function(u,o){return new OE(typeof u==='string'?fix(u):u instanceof URL?fix(u.href):u,o);};window.EventSource.prototype=OE.prototype;Object.assign(window.EventSource,OE);}for(const k of['pushState','replaceState']){const oh=history[k].bind(history);history[k]=(s,t,u)=>oh(s,t,u==null?u:typeof u==='string'?fix(u):u instanceof URL?fix(u.href):u);}})();</script>`;
}

export function injectProxyBootstrap(html, prefix = WEB_UI_PREFIX) {
  const tag = prefixBootstrapScript(prefix);
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${tag}`);
  if (/<script(?:\s[^>]*)?>/i.test(html)) return html.replace(/<script(?:\s[^>]*)?>/i, (match) => `${tag}${match}`);
  return `${tag}${html}`;
}

export function rewriteLocation(value, upstreamOrigin, prefix = WEB_UI_PREFIX) {
  if (typeof value !== 'string' || !value) return value;
  if (value === upstreamOrigin) return `${prefix}/`;
  if (value.startsWith(`${upstreamOrigin}/`)) return `${prefix}${value.slice(upstreamOrigin.length)}`;
  if (value.startsWith('/') && !value.startsWith('//') && value !== prefix && !value.startsWith(`${prefix}/`)) return `${prefix}${value}`;
  return value;
}

function sendText(res, status, text) {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': payload.length });
  res.end(payload);
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PROXY_BODY_BYTES) {
      const error = new Error('代理请求体超过 16 MiB');
      error.status = 413;
      throw error;
    }
    parts.push(chunk);
  }
  return parts.length ? Buffer.concat(parts) : undefined;
}

function forwardHeaders(req, session) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST.has(key) || value === undefined) continue;
    // 不向上游发 accept-encoding，避免不必要的压缩再解压；Node fetch 仍能处理上游压缩。
    if (key === 'accept-encoding') continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers.cookie = session.cookie;
  headers.origin = session.origin;
  headers.referer = `${session.origin}/`;
  return headers;
}

function responseHeaders(upstream, session, prefix) {
  const headers = {};
  for (const [name, value] of upstream.headers.entries()) {
    const key = name.toLowerCase();
    if (STRIPPED_RESPONSE.has(key)) continue;
    headers[key] = key === 'location' ? rewriteLocation(value, session.origin, prefix) : value;
  }
  return headers;
}

/**
 * 同源反向代理 Magpie 本机管理页：
 * - 复用宿主会话校验，后端代持 Magpie 登录 Cookie，绝不向前端暴露网页密钥；
 * - 透传普通静态资源、API 与 SSE 流；HTML 注入轻量前缀垫片隔离根路径；
 * - 上游重启导致 Cookie 失效时自动重登并重试一次。
 */
export function createWebProxy(ctx, manager, { reject, fetchImpl, prefix = WEB_UI_PREFIX } = {}) {
  let cachedSession = null;
  let pendingSession = null;
  const resolveFetch = () => fetchImpl ?? manager.backend?.web?.fetchImpl ?? fetch;

  async function getSession(force, signal) {
    if (!force && cachedSession) return cachedSession;
    if (force) cachedSession = null;
    if (!pendingSession) {
      pendingSession = manager.backend.web.session(signal)
        .then((session) => { cachedSession = session; return session; })
        .finally(() => { pendingSession = null; });
    }
    return pendingSession;
  }

  return async (req, res) => {
    const denied = reject?.(req, hostService(ctx, 'connection'));
    if (denied !== undefined) return sendText(res, denied, '请求来源或会话未获授权');
    const config = manager.current?.();
    if (config && !isLocal(config.baseURL)) return sendText(res, 403, '内嵌 Magpie 页面仅支持本机 Magpie');

    let parsed;
    try { parsed = new URL(req.url ?? `${prefix}/`, 'http://localhost'); }
    catch { return sendText(res, 400, '请求地址无效'); }
    if (parsed.pathname === prefix) {
      res.writeHead(302, { location: `${prefix}/${parsed.search}`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!parsed.pathname.startsWith(`${prefix}/`)) return sendText(res, 404, 'not found');
    const upstreamPath = parsed.pathname.slice(prefix.length) || '/';

    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.on?.('aborted', cancel);
    res.on?.('close', cancel);

    try {
      const body = await readBody(req);
      let session = await getSession(false, controller.signal);
      const send = (active) => {
        const headers = forwardHeaders(req, active);
        const accept = String(req.headers?.accept ?? '').toLowerCase();
        const streaming = accept.includes('text/event-stream');
        const signal = streaming
          ? controller.signal
          : AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
        return resolveFetch()(`${active.origin}${upstreamPath}${parsed.search}`, {
          method: req.method,
          headers,
          body,
          redirect: 'manual',
          signal,
        });
      };

      let upstream;
      try { upstream = await send(session); }
      catch (firstError) {
        if (controller.signal.aborted) return;
        // Magpie 重启换端口或刚恢复就绪时清掉旧会话再试一次。
        session = await getSession(true, controller.signal);
        upstream = await send(session).catch(() => { throw firstError; });
      }
      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => {});
        session = await getSession(true, controller.signal);
        upstream = await send(session);
      }

      const headers = responseHeaders(upstream, session, prefix);
      const contentType = String(headers['content-type'] ?? '').toLowerCase();

      if (contentType.includes('text/html')) {
        const html = injectProxyBootstrap(await upstream.text(), prefix);
        const payload = Buffer.from(html, 'utf8');
        headers['cache-control'] = 'no-store';
        headers['content-length'] = payload.length;
        res.writeHead(upstream.status, headers);
        return res.end(req.method === 'HEAD' ? undefined : payload);
      }

      if (contentType.includes('text/event-stream')) {
        headers['cache-control'] = 'no-cache';
        headers['x-accel-buffering'] = 'no';
        res.writeHead(upstream.status, headers);
        res.flushHeaders?.();
        if (!upstream.body || req.method === 'HEAD') return res.end();
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || res.writableEnded || res.destroyed) break;
            if (value?.length) res.write(Buffer.from(value));
          }
        } catch { /* 客户端关闭页面或上游重启时安静收尾。 */ }
        finally {
          await reader.cancel().catch(() => {});
          if (!res.writableEnded && !res.destroyed) res.end();
        }
        return;
      }

      res.writeHead(upstream.status, headers);
      if (!upstream.body || req.method === 'HEAD') return res.end();
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || res.writableEnded || res.destroyed) break;
          if (value?.length) res.write(Buffer.from(value));
        }
      } catch { /* 客户端取消请求时安静关闭响应。 */ }
      finally {
        await reader.cancel().catch(() => {});
        if (!res.writableEnded && !res.destroyed) res.end();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      cachedSession = null;
      return sendText(res, error.status ?? 502, error.message || 'Magpie 网页服务暂不可用');
    } finally {
      req.off?.('aborted', cancel);
      res.off?.('close', cancel);
    }
  };
}
