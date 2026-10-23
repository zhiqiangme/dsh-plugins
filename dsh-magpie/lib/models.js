import { isDeepStrictEqual } from 'node:util';
import { gatewayURL, isLocal, KEY_REF, LOCAL_KEY, object, PROVIDER_ID, REASONING_LEVELS, normalizeModel } from './config.js';
import { displayModelName } from './names.js';

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
      id: m.id, name: m.display_name || m.name || m.id, enabled: true,
      // 上游把输出上限标成等于上下文时只省略这一项，不让单个模型拖垮整次全量同步。
      contextWindow, maxTokens: contextWindow && output >= contextWindow ? undefined : output,
      input: m.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
      reasoningEfforts: levels.some((e) => e !== 'off') ? levels : [],
    });
  }).filter((m) => !seen.has(m.id) && seen.add(m.id));
}

export function modelEntries(config) {
  return config.models.filter((m) => m.enabled).map(({ enabled: _enabled, reasoningEfforts, ...m }) => ({
    ...m, name: displayModelName(m), ...(reasoningEfforts.length ? { reasoningEfforts: Object.fromEntries(reasoningEfforts.map((e) => [e, e])) } : {}),
  }));
}

/** 只替换自己持有的 provider；Magpie 原生分组和用户其它 provider 原样保留。 */
export function withProvider(current, config) {
  const base = object(current);
  const providers = { ...object(base.providers) };
  const previous = providers[PROVIDER_ID];
  if (previous && previous.apiKeyEnv !== KEY_REF) throw new Error(`${PROVIDER_ID} 已被其它配置占用，未覆盖`);
  const entries = modelEntries(config);
  if (!previous && (!config.enabled || !config.syncEnabled || entries.length === 0)) return { changed: false, config: base, count: 0 };
  if (!config.enabled || !config.syncEnabled || entries.length === 0) delete providers[PROVIDER_ID];
  else {
    const { reasoning: _reasoning, ...kept } = object(previous);
    providers[PROVIDER_ID] = {
      ...kept, displayName: 'Magpie', apiKeyEnv: KEY_REF,
      baseURL: `${config.baseURL}${config.api === 'anthropic-messages' ? '' : '/v1/'}`,
      api: config.api, models: entries,
      ...(previous?.reasoning && entries.every((m) => m.reasoningEfforts?.[previous.reasoning]) ? { reasoning: previous.reasoning } : {}),
    };
  }
  const next = { ...base, providers };
  return { changed: !isDeepStrictEqual(base, next), config: next, count: entries.length };
}

export async function syncModels(config, { editor, credentials, env = process.env }) {
  const target = findEntry(editor, LLM_PACKAGE);
  if (!target || typeof editor?.edit !== 'function') throw new Error('宿主 llm-pi-ai / configEditor 尚未就绪');
  // 先检查归属；禁用或清空时不要求网关在线或凭据服务可写。
  const planned = withProvider(target.options.config, config);
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
  if (planned.changed) await editor.edit(target, (current) => withProvider(current, config).config);
  return { state: planned.changed ? 'updated' : 'unchanged', count: config.enabled && config.syncEnabled ? planned.count : 0 };
}
