import { isDeepStrictEqual } from 'node:util';
import { gatewayURL, isLocal, KEY_REF, LOCAL_KEY, object, PROVIDER_ID, REASONING_LEVELS, normalizeModel } from './config.js';
import { dshModelName } from './names.js';
import { AUTO_PREFIX, planAutoRoute, routeKey, ROUTER_BASE_PATH } from './auto-route.js';

export const LLM_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';
export function findEntry(editor, name, id) {
  return [...(editor?.entries?.() ?? [])].find((row) => row.options?.name === name || (id && row.options?.id === id));
}

export async function credential(credentials, env, baseURL, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (env[KEY_REF]?.trim()) return env[KEY_REF].trim();
  const saved = (await credentials?.resolve?.(KEY_REF))?.value?.trim();
  // 本机占位标识不能当作远程 Magpie 的 Key 发出去，否则“需要有效 Key”的拦截永远不会触发。
  if (saved && (saved !== LOCAL_KEY || isLocal(baseURL))) return saved;
  return isLocal(baseURL) ? LOCAL_KEY : '';
}

export async function requestGateway(baseURL, path, key, fetchImpl = fetch, timeout = 15_000) {
  const url = `${gatewayURL(baseURL)}${path}`;
  const response = await fetchImpl(url, {
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'user-agent': 'deepseek-harness/dsh-magpie' },
    signal: AbortSignal.timeout(timeout), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Magpie 返回 HTTP ${response.status}`);
  // 不将上游错误正文带回页面：它可能包含认证或账号信息。
  return response.json();
}

/** 全量目录在写入前完整校验；异常条目不能被静默跳过，否则会误删本地模型。 */
export function catalogModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : undefined;
  if (!list) throw new Error('Magpie 模型目录格式无效');
  if (list.length > 512) throw new Error('目录超过 512 项，未同步，现有清单保持不变');
  const seen = new Set();
  return list.map((m) => {
    if (!m || typeof m.id !== 'string') throw new Error('Magpie 模型目录包含无效条目');
    const contextWindow = Number(m.context_window ?? m.context_length) || undefined;
    const output = Number(m.max_output_tokens ?? m.max_output) || undefined;
    const efforts = m.supported_reasoning_levels ?? m.reasoning_levels ?? [];
    // 上游可能有 DSH 不认识的档位（如 Codex 的 none）；只保留宿主接受的档位，剩下只有 off 时视为不声明。
    const levels = m.reasoning === true && Array.isArray(efforts)
      ? efforts.map((e) => typeof e === 'string' ? e.toLowerCase() : e?.effort?.toLowerCase?.()).filter((e) => REASONING_LEVELS.includes(e)) : [];
    return normalizeModel({
      // 自动导入只补充候选清单，不替用户选择模型；已有勾选由全量同步流程按 ID 保留。
      id: m.id, name: m.display_name || m.name || m.id, enabled: false,
      // 上游把输出上限标成等于上下文时只省略这一项，不让单个模型拖垮整次全量同步。
      contextWindow, maxTokens: contextWindow && output >= contextWindow ? undefined : output,
      input: m.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
      reasoningEfforts: levels.some((e) => e !== 'off') ? levels : [],
    });
  }).filter((m) => !seen.has(m.id) && seen.add(m.id));
}

export function modelEntries(config) {
  const models = config.autoRoute ? planAutoRoute(config).entries : config.models.filter((m) => m.enabled);
  return models.map(({ enabled: _enabled, reasoningEfforts, ...m }) => ({
    ...m, name: config.autoRoute ? m.name : dshModelName(m), ...(reasoningEfforts.length ? { reasoningEfforts: Object.fromEntries(reasoningEfforts.map((e) => [e, e])) } : {}),
  }));
}

/** 引用形如 `{ provider, model }`，开关 auto 后把旧 ID 映射到同款新 ID；未改动时返回原对象。 */
function replaceModelRefs(value, provider, swap) {
  if (Array.isArray(value)) {
    const items = value.map((item) => replaceModelRefs(item, provider, swap));
    if (items.every((item, index) => item === value[index])) return value;
    const seen = new Set();
    return items.filter((item) => {
      if (typeof item?.model !== 'string' || item.provider !== provider) return true;
      if (seen.has(item.model)) return false;
      seen.add(item.model); return true;
    });
  }
  if (typeof value !== 'object' || value === null) return value;
  if (value.provider === provider && typeof value.model === 'string') {
    const updated = swap(value.model);
    return updated === value.model ? value : { ...value, model: updated };
  }
  let next = value;
  for (const [key, item] of Object.entries(value)) {
    const updated = replaceModelRefs(item, provider, swap);
    if (updated !== item) next = next === value ? { ...value, [key]: updated } : Object.assign(next, { [key]: updated });
  }
  return next;
}

/** auto 条目改名、合并或开关变化后修复其它插件引用；同步主清单失败时不阻断，单独报告。 */
export async function retargetModelRefs({ editor, entries, routes, previousRoutes = [], autoRoute = true }) {
  const current = new Set(entries.map((entry) => entry.id));
  const currentRoutes = [...(routes ?? [])];
  const migrations = new Map(), previousOwners = new Map();
  // 上一轮名称派生的 auto ID 不在原始清单里，必须通过两组共有的原始候选找回对应关系。
  // 同时接受旧数字后缀规划，升级后第一次同步也能迁移到稳定后缀。
  for (const previous of previousRoutes) for (const [oldId, oldMembers] of previous ?? []) {
    if (!previousOwners.has(oldId)) previousOwners.set(oldId, oldMembers);
    let target;
    if (autoRoute) {
      const oldIds = new Set(oldMembers.map((row) => row.id));
      let best = 0;
      for (const [id, members] of currentRoutes) {
        const score = members.reduce((count, row) => count + Number(oldIds.has(row.id)), 0);
        if (score > best) { best = score; target = id; }
      }
    } else {
      target = oldMembers.find((row) => current.has(row.id))?.id;
    }
    if (target && !migrations.has(oldId)) migrations.set(oldId, target);
  }
  const migrationsByLower = new Map(), previousOwnersByLower = new Map();
  for (const [key, value] of migrations) if (!migrationsByLower.has(key.toLowerCase())) migrationsByLower.set(key.toLowerCase(), value);
  for (const [key, value] of previousOwners) if (!previousOwnersByLower.has(key.toLowerCase())) previousOwnersByLower.set(key.toLowerCase(), value);
  const byKey = new Map();
  for (const entry of entries) if (!byKey.has(routeKey(entry.id))) byKey.set(routeKey(entry.id), entry.id);
  // 按名合并后旧引用可能指向被并掉的别名 ID（含 auto: 前缀或裸 ID），用候选成员反查合并条目。
  const byId = new Map();
  for (const [autoId, members] of routes ?? []) for (const member of members) {
    if (!byId.has(member.id)) byId.set(member.id, autoId);
    const bare = member.id.includes('/') ? member.id.slice(member.id.indexOf('/') + 1) : member.id;
    if (!byId.has(bare)) byId.set(bare, autoId);
  }
  // 旧 ID 是按裸 ID 拼的（如 auto:doubao-seed-evolving-auto-max），大小写与现在不同，再按小写兜一层。
  const byLowerId = new Map();
  for (const [key, value] of byId) if (!byLowerId.has(key.toLowerCase())) byLowerId.set(key.toLowerCase(), value);
  const swap = (id) => {
    // 必须先查历史映射：同名 ID 即使仍存在，也可能在旧配置里代表另一个候选组。
    const migrated = migrations.get(id) ?? migrationsByLower.get(id.toLowerCase());
    if (migrated) return migrated;
    const previousOwner = previousOwners.get(id) ?? previousOwnersByLower.get(id.toLowerCase());
    // 原候选已消失时保留对它的原始引用，绝不能因另一个同名组复用该 ID 而静默改路由。
    if (previousOwner) return previousOwner[0]?.id ?? id;
    if (current.has(id)) return id;
    const bare = id.startsWith(AUTO_PREFIX) ? id.slice(AUTO_PREFIX.length) : id;
    return byId.get(id) ?? byId.get(bare) ?? byLowerId.get(bare.toLowerCase()) ?? byKey.get(routeKey(id)) ?? id;
  };
  let count = 0;
  try {
    for (const target of editor.entries?.() ?? []) {
      if (replaceModelRefs(target.options?.config, PROVIDER_ID, swap) === target.options?.config) continue;
      await editor.edit(target, (latest) => replaceModelRefs(latest, PROVIDER_ID, swap));
      count++;
    }
    return { state: count ? 'updated' : 'kept', count };
  } catch (error) { return { state: 'failed', reason: error.message }; }
}

/** 只替换自己持有的 provider；Magpie 原生分组和用户其它 provider 原样保留。 */
export function withProvider(current, config, { routeOrigin } = {}) {
  const base = object(current);
  const providers = { ...object(base.providers) };
  const previous = providers[PROVIDER_ID];
  if (previous && previous.apiKeyEnv !== KEY_REF) throw new Error(`${PROVIDER_ID} 已被其它配置占用，未覆盖`);
  const entries = modelEntries(config);
  if (!previous && (!config.enabled || !config.syncEnabled || entries.length === 0)) return { changed: false, config: base, count: 0 };
  if (!config.enabled || !config.syncEnabled || entries.length === 0) delete providers[PROVIDER_ID];
  else {
    const { reasoning: _reasoning, ...kept } = object(previous);
    const origin = typeof routeOrigin === 'function' ? routeOrigin() : routeOrigin;
    if (config.autoRoute && !origin) throw new Error('自动路由需要宿主 webServer 与可用的本机路由地址');
    providers[PROVIDER_ID] = {
      ...kept, displayName: 'Magpie', apiKeyEnv: KEY_REF,
      baseURL: config.autoRoute ? `${origin}${ROUTER_BASE_PATH}${config.api === 'anthropic-messages' ? '' : '/v1/'}` : `${config.baseURL}${config.api === 'anthropic-messages' ? '' : '/v1/'}`,
      api: config.api, models: entries,
      ...(previous?.reasoning && entries.every((m) => m.reasoningEfforts?.[previous.reasoning]) ? { reasoning: previous.reasoning } : {}),
    };
  }
  const next = { ...base, providers };
  return { changed: !isDeepStrictEqual(base, next), config: next, count: entries.length };
}

export async function syncModels(config, { editor, credentials, env = process.env, routeOrigin, previousConfig, previousProviderIds: savedProviderIds }) {
  const target = findEntry(editor, LLM_PACKAGE);
  if (!target || typeof editor?.edit !== 'function') throw new Error('宿主 llm-pi-ai / configEditor 尚未就绪');
  const previousProviderIds = savedProviderIds ?? (target.options?.config?.providers?.[PROVIDER_ID]?.models ?? []).map((row) => row?.id).filter((id) => typeof id === 'string');
  // 先检查归属；禁用或清空时不要求网关在线或凭据服务可写。
  const planned = withProvider(target.options.config, config, { routeOrigin });
  if (config.enabled && config.syncEnabled && planned.count > 0) {
    const key = await credential(credentials, env, config.baseURL);
    if (!key) throw new Error('远程 Magpie 需要有效的网关 Key，请在连接设置中保存');
    if (!env[KEY_REF]) {
      const existing = await credentials?.resolve?.(KEY_REF);
      if (existing?.value !== key) {
        if (typeof credentials?.set !== 'function' || (await credentials.describe?.(KEY_REF))?.writable === false) {
          throw new Error('DSH 凭据不可写，未同步模型');
        }
        await credentials.set(KEY_REF, key);
      }
    }
  }
  if (planned.changed) await editor.edit(target, (current) => withProvider(current, config, { routeOrigin }).config);
  const before = previousConfig ?? config;
  const currentPlan = planAutoRoute(config);
  const stablePrevious = planAutoRoute(before), legacyPrevious = planAutoRoute(before, { legacyIds: true });
  // 真实模型名可能以 2 或哈希文本结尾，与另一种规划的 ID 撞名。实际 provider 中命中更多的方案才优先认领旧引用。
  const score = (plan) => previousProviderIds.reduce((total, id) => total + Number(plan.routes.has(id)), 0);
  const stableScore = score(stablePrevious), legacyScore = score(legacyPrevious);
  const previousRoutes = legacyScore > stableScore
    ? [legacyPrevious.routes, stablePrevious.routes]
    : [stablePrevious.routes, legacyPrevious.routes];
  const refs = await retargetModelRefs({
    editor,
    entries: config.enabled && config.syncEnabled ? modelEntries(config) : [],
    routes: config.enabled && config.syncEnabled && config.autoRoute ? currentPlan.routes : undefined,
    previousRoutes,
    autoRoute: config.enabled && config.syncEnabled && config.autoRoute,
  });
  return { state: planned.changed ? 'updated' : 'unchanged', count: config.enabled && config.syncEnabled ? planned.count : 0, refs };
}
