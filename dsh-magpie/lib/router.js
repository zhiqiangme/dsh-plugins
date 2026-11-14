import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AUTO_PREFIX, planAutoRoute, ROUTER_BASE_PATH } from './auto-route.js';
import { credential, modelEntries } from './models.js';

export const ROUTER_PATH = `${ROUTER_BASE_PATH}/v1`;
const MAX_CHAT_BYTES = 32 * 1024 * 1024;
const PIN_IDLE_MS = 60 * 60_000;
const MAX_PINS = 500;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const TIMEOUT_COOLDOWN_MS = 30_000;
// 长生成不受此限，这里只等响应头；超时的候选短暂避让后仍可恢复。
const HEADER_TIMEOUT_MS = 60_000;
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
// 400 / 401 / 403 不跨供应商重放；404 可能是该出口刚下架，429 / 5xx 可换出口尝试。
const RETRY_STATUSES = new Set([402, 404, 408, 429, 500, 502, 503, 504]);
const ENDPOINTS = Object.freeze({ 'openai-completions': 'chat/completions', 'openai-responses': 'responses', 'anthropic-messages': 'messages' });

function reply(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { message, type: 'magpie_router_error' } }));
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

function timedOut(error) {
  return error?.name === 'TimeoutError' || TIMEOUT_CODES.has(error?.code) || TIMEOUT_CODES.has(error?.cause?.code);
}

/** 同时识别 Chat Completions、Responses 与 Anthropic 的图片内容。 */
export function requestHasImage(body) {
  for (const list of [body?.messages, body?.input]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (['image_url', 'image', 'input_image'].includes(item?.type)) return true;
      if (Array.isArray(item?.content) && item.content.some((part) => ['image_url', 'image', 'input_image'].includes(part?.type))) return true;
    }
  }
  return false;
}

/** DSH 不保证传会话 ID，沿用 WB 的第一条用户消息哈希；相同开头共享出口没有副作用。 */
export function conversationKey(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const first = messages.find((message) => message?.role === 'user');
  if (!first) return undefined;
  return createHash('sha256').update(String(body.model)).update('\0').update(JSON.stringify(first.content ?? '')).digest('hex');
}

/** 请求声明的思考档位：Chat Completions 用 reasoning_effort，Responses 用 reasoning.effort。 */
export function requestedEffort(body) {
  const value = body?.reasoning_effort ?? body?.reasoning?.effort;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 0 = 声明支持该档位，1 = 未声明（按可用处理），2 = 声明不支持。 */
function effortRank(row, effort) {
  const declared = row.reasoningEfforts ?? [];
  if (!declared.length) return 1;
  return declared.includes(effort) ? 0 : 2;
}

function createPins(now) {
  const pins = new Map();
  return {
    get(key) {
      const pin = pins.get(key);
      if (!pin) return undefined;
      pins.delete(key);
      if (now() - pin.at > PIN_IDLE_MS) return undefined;
      pins.set(key, { ...pin, at: now() });
      return pin;
    },
    set(key, id) {
      pins.delete(key); pins.set(key, { id, at: now() });
      if (pins.size > MAX_PINS) pins.delete(pins.keys().next().value);
    },
  };
}

/** 只隔离当前对话的出口，不因一次失败影响其它对话。 */
function createFailures(now) {
  const conversations = new Map();
  return {
    mark(key, id, cooldownMs) {
      if (!key) return;
      const routes = conversations.get(key) ?? new Map();
      for (const [route, until] of routes) if (until <= now()) routes.delete(route);
      routes.set(id, now() + cooldownMs);
      conversations.delete(key); conversations.set(key, routes);
      if (conversations.size > MAX_PINS) conversations.delete(conversations.keys().next().value);
    },
    remaining(key, id) {
      const routes = conversations.get(key);
      if (!routes) return 0;
      const remaining = (routes.get(id) ?? 0) - now();
      if (remaining > 0) return remaining;
      routes.delete(id);
      if (!routes.size) conversations.delete(key);
      return 0;
    },
  };
}

/** credentials / current / fetchImpl 均现取，保存配置或 Key 后下一次调用立即使用新值。 */
export function createMagpieRouter({ current, credentials, env = process.env, fetchImpl = fetch, maxBodyBytes = MAX_CHAT_BYTES, now = Date.now }) {
  const active = new Set(), pins = createPins(now), failures = createFailures(now);
  let stopped = false;
  return {
    async handle(req, res) {
      if (!localRequest(req)) return reply(res, 403, 'origin-not-trusted');
      const controller = new AbortController();
      const abort = () => { if (!res.writableFinished) controller.abort(); };
      req.on('aborted', abort); res.on('close', abort); active.add(controller);
      try {
        const config = current();
        if (stopped || !config.enabled || !config.syncEnabled || !config.autoRoute) return reply(res, 503, '自动路由未启用');
        const store = credentials();
        const key = await credential(store, env, config.baseURL);
        const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
        const supplied = String(req.headers['x-api-key'] ?? '') || bearer;
        if (!sameSecret(supplied, key)) return reply(res, 401, 'unauthorized');
        const path = new URL(req.url, 'http://localhost').pathname;
        if (req.method === 'GET' && path === `${ROUTER_PATH}/models`) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ object: 'list', data: modelEntries(config) }));
        }
        const endpoint = ENDPOINTS[config.api];
        if (path !== `${ROUTER_PATH}/${endpoint}`) return reply(res, 404, 'unknown endpoint');
        if (req.method !== 'POST') return reply(res, 405, 'method not allowed');
        if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return reply(res, 415, 'content-type 必须是 application/json');
        let size = 0;
        const chunks = [], iterable = typeof req.iterator === 'function' ? req.iterator({ destroyOnReturn: false }) : req;
        for await (const chunk of iterable) {
          size += chunk.length;
          if (size > maxBodyBytes) { req.resume?.(); return reply(res, 413, '请求体过大'); }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(res, 400, '请求体不是合法 JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') return reply(res, 400, '请求体必须包含模型 ID');
        const planned = planAutoRoute(config);
        const listed = body.model.startsWith(AUTO_PREFIX) ? planned.routes.get(body.model) ?? [] : config.models.filter((row) => row.enabled && row.id === body.model);
        if (!listed.length) return reply(res, 404, '这个模型没有已勾选的出口，请刷新模型清单');
        const image = requestHasImage(body);
        const capable = listed.filter((row) => !image || row.input?.includes('image'));
        if (!capable.length) return reply(res, 404, '这个模型的已选出口均不支持图片输入');
        // 合并条目对外声明的是各出口档位的并集，单个出口未必支持；按请求档位重排，失败仍会继续换下一个。
        // off 是关闭思考，各出口都接受，不需要改变优先级。
        const effort = requestedEffort(body);
        const ordered = effort && effort !== 'off' ? [...capable].sort((a, b) => effortRank(a, effort) - effortRank(b, effort)) : capable;
        const pin = conversationKey(body);
        const held = pins.get(pin);
        const ranked = held ? [...ordered].sort((a, b) => Number(b.id === held) - Number(a.id === held)) : ordered;
        const attempts = ranked.filter((row) => !failures.remaining(pin, row.id));
        if (!attempts.length) {
          const retryAfter = Math.max(1, Math.ceil(Math.min(...ranked.map((row) => failures.remaining(pin, row.id))) / 1000));
          res.setHeader('retry-after', String(retryAfter));
          return reply(res, 503, `本对话的可选出口均处于失败冷却中，请在 ${retryAfter} 秒后重试，或改选其它模型`);
        }
        for (const [index, attempt] of attempts.entries()) {
          const last = index === attempts.length - 1;
          let upstream;
          const waiting = new AbortController();
          const timer = setTimeout(() => waiting.abort(new DOMException('Magpie response headers timed out', 'TimeoutError')), HEADER_TIMEOUT_MS);
          timer.unref?.();
          try {
            upstream = await fetchImpl(`${config.baseURL}/v1/${endpoint}`, {
              method: 'POST', signal: AbortSignal.any([controller.signal, waiting.signal]), redirect: 'error',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`,
                ...(config.api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01', ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}) } : {}),
                'user-agent': 'deepseek-harness/dsh-magpie-router' },
              body: JSON.stringify({ ...body, model: attempt.id }),
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            failures.mark(pin, attempt.id, timedOut(error) ? TIMEOUT_COOLDOWN_MS : FAILURE_COOLDOWN_MS);
            if (last) return reply(res, 502, 'Magpie 候选出口连接失败或等待响应超时，请稍后重试');
            continue;
          } finally { clearTimeout(timer); }
          if (controller.signal.aborted) { await upstream.body?.cancel().catch(() => undefined); return; }
          if (RETRY_STATUSES.has(upstream.status)) {
            failures.mark(pin, attempt.id, [408, 504].includes(upstream.status) ? TIMEOUT_COOLDOWN_MS : FAILURE_COOLDOWN_MS);
            if (!last) { await upstream.body?.cancel().catch(() => undefined); continue; }
          }
          if (pin && upstream.ok) pins.set(pin, attempt.id);
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
          res.flushHeaders();
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
          else res.end();
          return;
        }
      } catch {
        if (!controller.signal.aborted && !res.headersSent) reply(res, 502, 'Magpie 路由请求失败，请检查网关和 Key');
        else if (!res.writableFinished) res.destroy();
      } finally {
        active.delete(controller);
        req.off('aborted', abort); res.off('close', abort);
      }
    },
    stop() { stopped = true; for (const controller of active) controller.abort(); active.clear(); },
  };
}
