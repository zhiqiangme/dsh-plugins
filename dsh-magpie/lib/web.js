import { hostService } from './runtime.js';

export const MODELS_PATH = '/plugins/dsh-magpie/models';
const BODY_LIMIT = 512 * 1024;
const local = (address = '') => address === '::1' || /^127\./.test(address.replace(/^::ffff:/, ''));

export function rejection(req, connection) {
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req);
  if (!local(req.socket?.remoteAddress) || req.headers?.['sec-fetch-site'] === 'cross-site') return 403;
  if (req.headers?.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return 403; }
    catch { return 403; }
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function bodyOf(req) {
  if (String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    const error = new Error('只接受 application/json'); error.status = 415; throw error;
  }
  const parts = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) { const error = new Error('请求超过 512 KiB'); error.status = 413; throw error; }
    parts.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象');
  return body;
}

export function handlerFor(ctx, manager) {
  return async (req, res) => {
    try {
      const denied = rejection(req, hostService(ctx, 'connection'));
      if (denied !== undefined) return json(res, denied, { ok: false, reason: '请求来源或会话未获授权' });
      if (req.method === 'GET') return json(res, 200, await manager.describe());
      if (req.method === 'POST') return json(res, 200, await manager.handle(await bodyOf(req)));
      return json(res, 405, { ok: false, reason: 'method not allowed' });
    } catch (error) {
      return json(res, error.status ?? 400, { ok: false, reason: error instanceof SyntaxError ? '请求体不是合法 JSON' : error.message });
    }
  };
}

export function registerPanel(ctx, manager) {
  const mount = (scoped) => {
    const server = hostService(scoped ?? ctx, 'webServer', (value) => typeof value?.register === 'function');
    if (!server) return;
    ctx.effect(() => server.register({ kind: 'exact', path: MODELS_PATH, handler: handlerFor(ctx, manager) }), 'dsh-magpie: routes');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mount);
  else mount(ctx);
}
