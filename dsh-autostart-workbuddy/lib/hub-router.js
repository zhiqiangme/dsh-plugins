/**
 * 把 CN / GL / HW（CodeArts）放进一个 OpenAI provider：模型 id 带区域前缀，转发时还原 HUB 的裸 id。
 * llm-pi-ai 只能在 provider 层设置 Key / headers，不能给同组模型分别指定出口，故在已有
 * webServer 上做一层转发；不另开端口、不接管上游程序，SSE 原样流式传输。
 *
 * `auto:` 开头的合并模型不绑定出口：这里按积分到期选一个（规则见 exit-credits.js 的 rankExits），
 * 同一对话固定在一个出口，请求没被受理时才换下一个。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createExitCredits, rankExits } from './exit-credits.js';
import { fetchHubRegions, hubRegionPlans, hubRegionRoutes, HUB_ROUTER_PATH, mergeKey, MERGED_PREFIX, planHubEntries, providerKeyRef, findConfigEntry, LLM_PI_AI_PACKAGE, providerBaseURL, resolveModelApiKey } from './models.js';

// 视觉请求含 base64 图像，不能沿用面板 64KiB 的限制；仍给整个 JSON 请求设 32MiB 上限。
const MAX_CHAT_BYTES = 32 * 1024 * 1024;
/** 合并模型的出口表：目录变动很慢，而 hub 每次模型请求都记一行日志，不能跟着对话频率拉。 */
const ROUTE_TABLE_TTL_MS = 5 * 60_000;
/** 表里没有这个模型时的重查间隔：刚勾选的模型要能很快用上，但拼错的 id 不能每次都触发重查。 */
const ROUTE_TABLE_MISS_MS = 30_000;
/** 对话空闲超过一小时，上游缓存基本已失效，换出口不再有代价，重新按到期选。 */
const PIN_IDLE_MS = 60 * 60_000;
/** 固定记录的上限：每条只有一个哈希和时间，够覆盖同时进行的对话，超出丢最久没用的。 */
const MAX_PINS = 500;
/**
 * 这些状态说明请求没被受理，换出口可能成功。403 不在内：账号被上游风控时跨出口重打只会牵连另一边
 * （hub 的跨出口回退同样不重打）；400 / 401 换出口也没用，要让用户看到真实错误。
 * 404 在内：目录可能已更新，这个出口刚下架了这个模型。
 */
const RETRY_STATUSES = new Set([402, 404, 408, 429, 500, 502, 503, 504]);

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

/** 只接受显式区域；不能将拼错的 id 静默转成看板当前出口。 */
export function parseHubModel(id) {
  if (typeof id !== 'string') return undefined;
  const match = /^(cn|global|codearts):(.+)$/.exec(id);
  return match ? { realm: match[1] === 'global' ? 'intl' : match[1], model: match[2] } : undefined;
}

/** 带图请求只能发给支持视觉的出口。 */
export function requestHasImage(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((message) => Array.isArray(message?.content) && message.content.some((part) => ['image_url', 'image', 'input_image'].includes(part?.type)));
}

/**
 * 认出同一对话：DSH 默认不把会话 id 发给自定义 provider，只能看内容。
 * 取第一条用户消息而不是系统提示：系统提示可能带时间等每轮变化的内容，第一条用户消息在对话里不变。
 * 开头相同的两个对话会共用一个出口，这没有坏处。
 */
export function conversationKey(body) {
  const first = (Array.isArray(body?.messages) ? body.messages : []).find((message) => message?.role === 'user');
  if (!first) return undefined;
  return createHash('sha256').update(String(body.model)).update('\0').update(JSON.stringify(first.content ?? '')).digest('hex');
}

/** 对话 → 出口。Map 按写入顺序迭代，每次使用重新写入，最前面的就是最久没用的。 */
function createExitPins(now) {
  const pins = new Map();
  return {
    get(key) {
      const pin = pins.get(key);
      if (!pin) return undefined;
      pins.delete(key);
      if (now() - pin.at > PIN_IDLE_MS) return undefined;
      pins.set(key, { ...pin, at: now() });
      return pin.realm;
    },
    set(key, realm) {
      pins.delete(key);
      pins.set(key, { realm, at: now() });
      if (pins.size > MAX_PINS) pins.delete(pins.keys().next().value);
    },
  };
}

/** 合并模型 → 各出口的真实 id 与能力，用与写进 DSH 相同的勾选和规则算出来。 */
function createRouteTable({ resolved, env, now }) {
  let routes;
  let loadedFor;
  let loadedAt = -Infinity;
  let loading;
  const load = (credentials) => {
    const models = resolved.models;
    loading ??= fetchHubRegions({ models, credentials, env }).then((fetched) => {
      if (!fetched.ok) return;
      routes = planHubEntries(hubRegionPlans(fetched.regions, models), models).routes;
      loadedFor = models;
      loadedAt = now();
    }).catch(() => undefined).finally(() => { loading = undefined; });
    return loading;
  };
  return {
    async members(key, credentials) {
      // 配置一变 resolved.models 就换新对象：刚取消勾选的出口不能再收请求，这时要等新表。
      if (!routes || loadedFor !== resolved.models) await load(credentials);
      else if (now() - loadedAt >= ROUTE_TABLE_TTL_MS) void load(credentials);
      if (!routes?.has(key) && now() - loadedAt >= ROUTE_TABLE_MISS_MS) await load(credentials);
      return routes?.get(key) ?? [];
    },
  };
}

/** credentials/editor 均现取，保存 Key 后下一次调用立即生效。 */
export function createHubRouter({ resolved, credentials, editor, env = process.env, maxBodyBytes = MAX_CHAT_BYTES, now = Date.now, exits = createExitCredits({ resolved, credentials, env, now }) }) {
  const active = new Set();
  const pins = createExitPins(now);
  const table = createRouteTable({ resolved, env, now });
  let stopped = false;

  /** 到期数据读不到不能挡住对话：排序退回固定顺序，真实错误由 hub 报。 */
  async function mergedAttempts(body, store) {
    const members = await table.members(mergeKey(body.model), store);
    const [credits, readiness] = await Promise.all([exits.snapshot(), exits.readiness()]).catch(() => [{}, undefined]);
    const ranked = rankExits(members, credits, { ready: readiness?.ready, image: requestHasImage(body) });
    const pin = conversationKey(body);
    const pinned = pin ? pins.get(pin) : undefined;
    const held = ranked.find((member) => member.realm === pinned);
    return { pin, attempts: held ? [held, ...ranked.filter((member) => member !== held)] : ranked };
  }

  return {
    async handle(req, res) {
      if (!localRequest(req)) return reply(res, 403, 'origin-not-trusted');
      if (stopped || resolved.gateway !== 'hub' || !resolved.models.hubDual) return reply(res, 503, '双区域路由未启用');
      const controller = new AbortController();
      const abort = () => { if (!res.writableFinished) controller.abort(); };
      req.on('aborted', abort); res.on('close', abort); active.add(controller);
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
          const { entries } = planHubEntries(hubRegionPlans(fetched.regions, models), models);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ object: 'list', data: entries }));
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
        const merged = typeof body?.model === 'string' && body.model.startsWith(MERGED_PREFIX);
        const route = merged ? undefined : parseHubModel(body?.model);
        if (!merged && !route) return reply(res, 400, '请选择带 CN / GL / HW 区域的 WorkBuddy 模型');
        const { pin, attempts } = merged ? await mergedAttempts(body, store) : { attempts: [route] };
        if (!attempts.length) return reply(res, 404, '这个合并模型暂时没有可用出口，请刷新模型列表');
        const keys = await hubRegionRoutes({ models, credentials: store, env });

        /** timeoutMs 只管等响应头；长对话由 DSH 的流空闲超时和客户端取消控制，不能在 60s 截断。 */
        const send = async ({ realm, model }) => {
          const waiting = new AbortController();
          const timer = setTimeout(() => waiting.abort(), models.timeoutMs);
          timer.unref?.();
          try {
            const apiKey = keys[realm].apiKey;
            return await fetch(`${providerBaseURL(models.baseURL)}chat/completions`, {
              method: 'POST', signal: AbortSignal.any([controller.signal, waiting.signal]), redirect: 'error',
              headers: { 'content-type': 'application/json', 'X-Realm': realm, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
              body: JSON.stringify({ ...body, model }),
            });
          } finally { clearTimeout(timer); }
        };

        for (const [index, attempt] of attempts.entries()) {
          const last = index === attempts.length - 1;
          let upstream;
          try { upstream = await send(attempt); }
          catch (error) {
            if (last || controller.signal.aborted) throw error;
            continue;
          }
          if (controller.signal.aborted) return;
          if (!last && RETRY_STATUSES.has(upstream.status)) {
            await upstream.body?.cancel().catch(() => undefined);
            continue;
          }
          if (pin && upstream.ok) pins.set(pin, attempt.realm);
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
          res.flushHeaders();
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
          else res.end();
          return;
        }
      } catch {
        if (!controller.signal.aborted && !res.headersSent) reply(res, 502, 'HUB 请求失败，请检查网关和区域 Key');
        else if (!res.writableFinished) res.destroy();
      } finally {
        active.delete(controller);
        req.off('aborted', abort); res.off('close', abort);
      }
    },
    stop() { stopped = true; for (const controller of active) controller.abort(); active.clear(); },
  };
}
