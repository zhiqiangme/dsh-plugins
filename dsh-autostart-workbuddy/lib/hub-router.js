/**
 * 把 CN / GL 放进一个 OpenAI provider：模型 id 带区域前缀，转发时还原 HUB 的裸 id。
 * llm-pi-ai 只能在 provider 层设置 Key / headers，不能给同组模型分别指定出口，故在已有
 * webServer 上做一层转发；不另开端口、不接管上游程序，SSE 原样流式传输。
 */
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchHubRegions, hubRegionRoutes, HUB_ROUTER_PATH, planModelEntries, providerKeyRef, findConfigEntry, LLM_PI_AI_PACKAGE, providerBaseURL, resolveModelApiKey, selectionKey } from './models.js';

// 视觉请求含 base64 图像，不能沿用面板 64KiB 的限制；仍给整个 JSON 请求设 32MiB 上限。
const MAX_CHAT_BYTES = 32 * 1024 * 1024;

function reply(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'workbuddy_router_error' } }));
}

function localRequest(req) {
  const peer = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (peer !== '::1' && !peer.startsWith('127.')) return false;
  try {
    const host = new URL(`http://${req.headers.host}`).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
  } catch { return false; }
}

function sameSecret(actual, expected) {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** 只接受两个显式区域；不能将拼错的 id 静默转成看板当前出口。 */
export function parseHubModel(id) {
  if (typeof id !== 'string') return undefined;
  const match = /^(cn|global):(.+)$/.exec(id);
  return match ? { realm: match[1] === 'cn' ? 'cn' : 'intl', model: match[2] } : undefined;
}

/** credentials/editor 均现取，保存 Key 后下一次调用立即生效。 */
export function createHubRouter({ resolved, credentials, editor, env = process.env, maxBodyBytes = MAX_CHAT_BYTES }) {
  const active = new Set();
  let stopped = false;
  return {
    async handle(req, res) {
      if (!localRequest(req)) return reply(res, 403, 'origin-not-trusted');
      if (stopped || resolved.gateway !== 'hub' || !resolved.models.hubDual) return reply(res, 503, '双区域路由未启用');
      const controller = new AbortController();
      const abort = () => { if (!res.writableFinished) controller.abort(); };
      req.on('aborted', abort); res.on('close', abort); active.add(controller);
      let timer;
      try {
        const models = resolved.models;
        const store = credentials();
        const target = findConfigEntry(editor(), { name: LLM_PI_AI_PACKAGE });
        const ref = providerKeyRef(target?.options?.config, models.provider) || models.apiKeyRef || 'WORKBUDDY_PROXY_KEY';
        const saved = await store?.resolve?.(ref);
        const expected = (typeof saved === 'string' ? saved : saved?.value) || env[ref] || await resolveModelApiKey(models, env, store);
        const supplied = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
        if (!sameSecret(supplied, expected)) return reply(res, 401, 'unauthorized');
        const path = new URL(req.url, 'http://localhost').pathname;
        if (req.method === 'GET' && path === `${HUB_ROUTER_PATH}/models`) {
          const fetched = await fetchHubRegions({ models, credentials: store, env });
          if (!fetched.ok) return reply(res, 502, fetched.reason);
          const data = fetched.regions.flatMap((region) => planModelEntries(region.models, models).map((entry) => ({ ...entry, id: selectionKey({ id: entry.id, realm: region.realm }) })));
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ object: 'list', data }));
        }
        if (path !== `${HUB_ROUTER_PATH}/chat/completions`) return reply(res, 404, 'unknown endpoint');
        if (req.method !== 'POST') return reply(res, 405, 'method not allowed');
        if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return reply(res, 415, 'content-type 必须是 application/json');
        let size = 0;
        const chunks = [];
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > maxBodyBytes) { req.resume(); return reply(res, 413, '请求体过大'); }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(res, 400, '请求体不是合法 JSON'); }
        const route = parseHubModel(body?.model);
        if (!route) return reply(res, 400, '请选择带 CN / GL 区域的 WorkBuddy 模型');
        const routes = await hubRegionRoutes({ models, credentials: store, env });
        const apiKey = routes[route.realm].apiKey;
        // timeoutMs 只管等响应头；长对话由 DSH 的流空闲超时和客户端取消控制，不能在 60s 截断。
        timer = setTimeout(() => controller.abort(), models.timeoutMs);
        timer.unref?.();
        const upstream = await fetch(`${providerBaseURL(models.baseURL)}chat/completions`, {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'content-type': 'application/json', 'X-Realm': route.realm, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ ...body, model: route.model }),
        });
        clearTimeout(timer);
        if (controller.signal.aborted) return;
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
        res.flushHeaders();
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
        else res.end();
      } catch {
        if (!controller.signal.aborted && !res.headersSent) reply(res, 502, 'HUB 请求失败，请检查网关和区域 Key');
        else if (!res.writableFinished) res.destroy();
      } finally {
        clearTimeout(timer); active.delete(controller);
        req.off('aborted', abort); res.off('close', abort);
      }
    },
    stop() { stopped = true; for (const controller of active) controller.abort(); active.clear(); },
  };
}
