import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AUTO_PREFIX, planAutoRoute, ROUTER_BASE_PATH } from './auto-route.js';
import { credential, modelEntries } from './models.js';
import { prepareErrorResponse, prepareJSON, prepareSSE } from './router-stream.js';
import { ChannelOrder, routingDay } from './channel-order.js';

export const ROUTER_PATH = `${ROUTER_BASE_PATH}/v1`;
const MAX_CHAT_BYTES = 32 * 1024 * 1024;
// 包含响应头和 SSE 首个有效输出的等待；心跳、空 role 帧不重置计时，开始输出后的长生成不受此限。
const FIRST_OUTPUT_TIMEOUT_MS = 60_000;
// 普通 400 / 401 / 403 不重放；明确余额不足时由解析器按内部 402 分类，再尝试下一渠道。
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

/** credentials / current / fetchImpl 均现取，保存配置或 Key 后下一次调用立即使用新值。 */
export function createMagpieRouter({ current, credentials, env = process.env, fetchImpl = fetch, maxBodyBytes = MAX_CHAT_BYTES, now = Date.now, firstOutputTimeoutMs = FIRST_OUTPUT_TIMEOUT_MS, loadQuotas, orderStatePath, onOrderError }) {
  const active = new Set(), channels = new ChannelOrder({ now, loadQuotas, stateFile: orderStatePath, onError: onOrderError });
  let stopped = false;
  return {
    channelStatus: () => channels.snapshot(current()),
    recoverChannel: (id, token) => channels.recover(current(), id, token),
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
        // 合并条目声明各出口档位的并集；过滤明确不支持的出口后，再按全局渠道顺序选择。
        // off 是关闭思考，各出口都接受，不需要改变优先级。
        const effort = requestedEffort(body);
        const compatible = effort && effort !== 'off' ? capable.filter((row) => effortRank(row, effort) < 2) : capable;
        const ordered = compatible.length ? compatible : capable;
        let order = await channels.prepare(config);
        if (controller.signal.aborted) return;
        let attempts = [...ordered];
        while (attempts.length) {
          if (order.day !== routingDay(now()) && current().baseURL === config.baseURL) order = await channels.prepare(config);
          // 每次尝试都采用当前全局顺序，让其它并发调用刚记录的失败同样生效。
          attempts = channels.rank(order, attempts);
          if (!attempts.length) return reply(res, 503, '该模型的可用渠道均因余额不足停用，请到 Magpie「渠道」页恢复，或等待北京时间 04:00 自动恢复');
          const attempt = attempts.shift();
          const last = attempts.length === 0;
          const generation = channels.generation(order, attempt);
          let penalized = false, blocked = false;
          const failed = (_status, insufficientBalance = false) => {
            // 同一次失败可能同时被流解析和 pipeline 观察到，只后移一次；下游主动取消不算渠道失败。
            if (controller.signal.aborted) return;
            if (insufficientBalance && !blocked) { blocked = true; penalized = true; channels.exhausted(order, attempt, generation); }
            else if (!penalized) { penalized = true; channels.failed(order, attempt); }
          };
          let upstream, prepared;
          const waiting = new AbortController();
          const timer = setTimeout(() => waiting.abort(new DOMException('Magpie first model output timed out', 'TimeoutError')), firstOutputTimeoutMs);
          timer.unref?.();
          try {
            upstream = await fetchImpl(`${config.baseURL}/v1/${endpoint}`, {
              method: 'POST', signal: AbortSignal.any([controller.signal, waiting.signal]), redirect: 'error',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`,
                ...(config.api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01', ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}) } : {}),
                'user-agent': 'deepseek-harness/dsh-magpie-router' },
              body: JSON.stringify({ ...body, model: attempt.id }),
            });
            if (!upstream.ok) {
              prepared = await prepareErrorResponse(upstream);
            } else if (/text\/event-stream/i.test(upstream.headers.get('content-type') ?? '')) {
              prepared = await prepareSSE(upstream, { onError: failed });
            } else if (upstream.ok && /application\/(?:[\w.+-]*\+)?json/i.test(upstream.headers.get('content-type') ?? '')) {
              prepared = await prepareJSON(upstream);
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            failed();
            if (last) return reply(res, 502, 'Magpie 候选出口连接失败或等待响应超时，请稍后重试');
            continue;
          } finally { clearTimeout(timer); }
          const cancel = () => prepared ? prepared.cancel() : upstream.body?.cancel().catch(() => undefined);
          if (controller.signal.aborted) { await cancel(); return; }
          const status = prepared?.status ?? upstream.status;
          if (status >= 400) failed(status, prepared?.insufficientBalance);
          if (RETRY_STATUSES.has(status)) {
            if (!last && channels.rank(order, attempts).length) { await cancel(); continue; }
          }
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
          res.flushHeaders();
          try {
            if (prepared) await pipeline(Readable.from(prepared.body), res, { signal: controller.signal });
            else if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
            else res.end();
          } catch (error) {
            // 已交付内容后不能重放（可能已触发工具）；只将失败渠道后移，供后续调用使用。
            if (!controller.signal.aborted) failed();
            throw error;
          }
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
