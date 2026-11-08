/**
 * 把 CN / GL / HW（CodeArts）放进一个 OpenAI provider，转发时还原 HUB 的裸 id。
 * llm-pi-ai 只能在 provider 层设置 Key / headers，不能给同组模型分别指定出口，故在已有
 * webServer 上做一层转发；不另开端口、不接管上游程序，SSE 原样流式传输。
 *
 * 写进 DSH 的模型都是 `auto:` 开头，不绑定出口：这里按积分到期选一个（规则见 exit-credits.js 的 rankExits），
 * 免费、三天内积分到期的出口优先，同一优先级内尽量固定对话出口。带区域前缀的旧 id 照旧直接转发。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createExitCredits, rankExits } from './exit-credits.js';
import { fetchHubRegions, hubRegionPlans, hubRegionRoutes, HUB_ROUTER_PATH, mergeKey, modelTier, MERGED_PREFIX, planHubEntries, providerKeyRef, findConfigEntry, LLM_PI_AI_PACKAGE, providerBaseURL, resolveModelApiKey } from './models.js';

// 视觉请求含 base64 图像，不能沿用面板 64KiB 的限制；仍给整个 JSON 请求设 32MiB 上限。
const MAX_CHAT_BYTES = 32 * 1024 * 1024;
/** 合并模型的出口表：目录变动很慢，而 hub 每次模型请求都记一行日志，不能跟着对话频率拉。 */
const ROUTE_TABLE_TTL_MS = 5 * 60_000;
/** 表里没有这个模型时的重查间隔：刚勾选的模型要能很快用上，但拼错的 id 不能每次都触发重查。 */
const ROUTE_TABLE_MISS_MS = 30_000;
/** 对话空闲超过一小时，上游缓存基本已失效，换出口不再有代价，重新按到期选。 */
const PIN_IDLE_MS = 60 * 60_000;
/** 按请求时刻滚动计算 72 小时，包含恰好三天；临期积分优先于非临期出口的缓存复用。 */
const EXPIRING_SOON_MS = 3 * 24 * 60 * 60_000;
/** 固定记录的上限：每条只有一个哈希和时间，够覆盖同时进行的对话，超出丢最久没用的。 */
const MAX_PINS = 500;
/** DSH 会重试同一轮模型请求；五分钟内不再请求该对话刚失败的候选，避免免费/临期规则反复选回它。 */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
/**
 * 这些状态说明请求没被受理，换出口可能成功。403 不在内：账号被上游风控时跨出口重打只会牵连另一边
 * （hub 的跨出口回退同样不重打）；400 / 401 换出口也没用，要让用户看到真实错误。
 * 404 在内：目录可能已更新，这个出口刚下架了这个模型。
 */
const RETRY_STATUSES = new Set([402, 404, 408, 429, 500, 502, 503, 504]);
/**
 * hub 在风控连坐暂停期间也回 429，但换出口正是这个暂停要防的：同一台设备上的账号会被牵连。
 * 状态码和类型都与普通限额相同，只有正文写了 code 11140 能区分。
 */
const RESTRICTION_HOLD = /11140/;

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

/** 用 clone 读：判定为暂停时原响应还要原样转给用户。读不到时按普通限额处理。 */
async function restrictionHold(upstream) {
  if (upstream.status !== 429) return false;
  return RESTRICTION_HOLD.test(await upstream.clone().text().catch(() => ''));
}

/** 只接受显式区域；不能将拼错的 id 静默转成看板当前出口。 */
export function parseHubModel(id) {
  if (typeof id !== 'string') return undefined;
  const match = /^(cn|global|codearts):(.+)$/.exec(id);
  return match ? { realm: match[1] === 'global' ? 'intl' : match[1], model: match[2] } : undefined;
}

/**
 * 出口表里没有这个模型时按勾选转发。CodeArts 是可选出口，目录取不到不算同步失败，条目还留在 DSH 里；
 * 只勾了 HW 的模型不能因此 404，能不能用由 hub 回答。明确的 free 档仍要先于付费尝试；
 * 其它倍率与视觉未知，不能绕过排除、免费或能力筛选，仍用正常的规划器决定能否参与。
 */
function selectedRoutes(key, models) {
  const regions = new Map();
  for (const id of models.only ?? []) {
    if (mergeKey(id) !== key) continue;
    const route = parseHubModel(id);
    if (!route) continue;
    if (!regions.has(route.realm)) regions.set(route.realm, { realm: route.realm, models: [] });
    regions.get(route.realm).models.push({ id: route.model, realm: route.realm, ...(modelTier(route.model) === 'free' ? { credits: 0 } : {}) });
  }
  return planHubEntries(hubRegionPlans([...regions.values()], models)).routes.get(key) ?? [];
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

/** 对话 → 出口和真实模型。Map 按写入顺序迭代，每次使用重新写入，最前面的就是最久没用的。 */
function createExitPins(now) {
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
    set(key, { realm, model }) {
      pins.delete(key);
      pins.set(key, { realm, model, at: now() });
      if (pins.size > MAX_PINS) pins.delete(pins.keys().next().value);
    },
  };
}

/** 只隔离当前对话的具体渠道和模型，不因一条长请求失败影响其它对话。仅保存哈希与到期时刻。 */
function createFailedAttempts(now) {
  const conversations = new Map();
  const routeKey = ({ realm, model }) => JSON.stringify([realm, model]);
  return {
    mark(key, attempt) {
      if (!key) return;
      const routes = conversations.get(key) ?? new Map();
      for (const [route, until] of routes) if (until <= now()) routes.delete(route);
      routes.set(routeKey(attempt), now() + FAILURE_COOLDOWN_MS);
      conversations.delete(key);
      conversations.set(key, routes);
      if (conversations.size > MAX_PINS) conversations.delete(conversations.keys().next().value);
    },
    remaining(key, attempt) {
      const routes = conversations.get(key);
      if (!routes) return 0;
      const route = routeKey(attempt);
      const remaining = (routes.get(route) ?? 0) - now();
      if (remaining > 0) return remaining;
      routes.delete(route);
      if (!routes.size) conversations.delete(key);
      return 0;
    },
  };
}

/**
 * 免费 → 三天内到期 → 其它；同档内沿用原排序，并把固定成员提到该档最前。
 * 两个出口都临期时仍保持对话固定，避免在它们之间反复切换；免费恢复时始终优先。
 */
function holdPinned(ranked, pinned, credits, now) {
  const priority = (member) => {
    if (member.price === 0) return 0;
    const expiry = credits[member.realm]?.expireAt;
    // 快照可能暂未刷新：已过期和未知日期不能继续享受临期优先。
    return Number.isFinite(expiry) && expiry > now && expiry - now <= EXPIRING_SOON_MS ? 1 : 2;
  };
  const ordered = [...ranked].sort((a, b) => priority(a) - priority(b));
  const held = ordered.find(({ realm, model }) => realm === pinned?.realm && model === pinned?.model);
  if (!held) return ordered;
  const rest = ordered.filter((member) => member !== held);
  rest.splice(rest.filter((member) => priority(member) < priority(held)).length, 0, held);
  return rest;
}

/** 合并模型 → 各出口的真实 id 与能力，用与写进 DSH 相同的勾选和规则算出来。 */
function createRouteTable({ resolved, env, now }) {
  let routes;
  let loadedFor;
  let loadedAt = -Infinity;
  let loading;
  const load = (credentials) => {
    const models = resolved.models;
    // 旧配置的在途查询不能充当新配置的刷新；等它结束后再查，仍只保留一条请求链。
    if (loading) return loading.models === models ? loading.promise : loading.promise.then(() => load(credentials));
    const task = { models };
    task.promise = fetchHubRegions({ models, credentials, env }).then((fetched) => {
      if (!fetched.ok || resolved.models !== models) return;
      routes = planHubEntries(hubRegionPlans(fetched.regions, models)).routes;
      loadedFor = models;
      loadedAt = now();
    }).catch(() => undefined).finally(() => { if (loading === task) loading = undefined; });
    loading = task;
    return task.promise;
  };
  return {
    async members(key, credentials) {
      // 配置一变 resolved.models 就换新对象：刚取消勾选的出口不能再收请求，这时要等新表。
      let models;
      do {
        models = resolved.models;
        if (!routes || loadedFor !== models) await load(credentials);
        else if (!routes.has(key) && now() - loadedAt >= ROUTE_TABLE_MISS_MS) await load(credentials);
        else if (now() - loadedAt >= ROUTE_TABLE_TTL_MS) void load(credentials);
      } while (models !== resolved.models);
      // 刷新失败时不能复用旧配置的表，交给调用方按最新勾选兜底。
      return loadedFor === models ? routes?.get(key) ?? [] : [];
    },
  };
}

/** credentials/editor 均现取，保存 Key 后下一次调用立即生效。 */
export function createHubRouter({ resolved, credentials, editor, env = process.env, maxBodyBytes = MAX_CHAT_BYTES, now = Date.now, exits = createExitCredits({ resolved, credentials, env, now }) }) {
  const active = new Set();
  const pins = createExitPins(now);
  const failures = createFailedAttempts(now);
  const table = createRouteTable({ resolved, env, now });
  let stopped = false;

  /** 到期数据读不到不能挡住对话：排序退回固定顺序，真实错误由 hub 报。 */
  async function mergedAttempts(body, store) {
    const key = mergeKey(body.model);
    const listed = await table.members(key, store);
    const members = listed.length ? listed : selectedRoutes(key, resolved.models);
    // 只有一个可选项时没什么可比的：不读到期数据，也就不用等 HW 的首次读取。
    if (members.length < 2) return { pin: conversationKey(body), attempts: members };
    const [credits, readiness] = await Promise.all([exits.snapshot(), exits.readiness()]).catch(() => [{}, undefined]);
    const ranked = rankExits(members, credits, { ready: readiness?.ready, image: requestHasImage(body) });
    const pin = conversationKey(body);
    return { pin, attempts: holdPinned(ranked, pin ? pins.get(pin) : undefined, credits, now()) };
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
          const { entries } = planHubEntries(hubRegionPlans(fetched.regions, models));
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
        const { pin, attempts: candidates } = merged ? await mergedAttempts(body, store) : { attempts: [route] };
        if (!candidates.length) return reply(res, 404, '这个合并模型暂时没有可用出口，请刷新模型列表');
        // 在免费、临期和对话固定排序之后过滤，故障候选不能靠高优先级再次抢占。
        const attempts = candidates.filter((attempt) => !failures.remaining(pin, attempt));
        if (!attempts.length) {
          const retryAfter = Math.max(1, Math.ceil(Math.min(...candidates.map((attempt) => failures.remaining(pin, attempt))) / 1000));
          res.setHeader('retry-after', String(retryAfter));
          return reply(res, 503, `本对话的可选渠道均处于失败冷却中，请在 ${retryAfter} 秒后重试，或改选其它模型`);
        }
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
            // 客户端取消（含宿主流空闲超时）与插件关闭不是渠道故障。
            if (controller.signal.aborted) throw error;
            failures.mark(pin, attempt);
            if (last) return reply(res, 502, `HUB 候选渠道连接失败或等待响应超时${pin ? '，已记录失败并暂时跳过' : ''}，请稍后重试`);
            continue;
          }
          if (controller.signal.aborted) return;
          if (RETRY_STATUSES.has(upstream.status) && !await restrictionHold(upstream)) {
            if (controller.signal.aborted) return;
            failures.mark(pin, attempt);
            if (!last) {
              await upstream.body?.cancel().catch(() => undefined);
              continue;
            }
          }
          if (pin && upstream.ok) pins.set(pin, attempt);
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
