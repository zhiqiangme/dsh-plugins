/**
 * WorkBuddy 模型列表同步：从本地 wb2api 的 `/v1/models` 拉真实模型清单，
 * 写进 `llm-pi-ai` 插件配置里 workbuddy provider 的 `models`。
 *
 * 为什么是"改配置"而不是"运行期注册"：
 *   DSH 的 llm 服务只允许 provider 的归属插件注册模型（registerAdapter /
 *   registerModelDiscovery 都绑定各自的 settingsNs），本插件无法给 llm-pi-ai 的
 *   workbuddy 路由追加模型；模型清单本来就是 llm-pi-ai 的配置，所以改它的配置。
 *
 * 为什么走宿主的 configEditor 而不是直接改 cordis.patch.yml：
 *   configEditor 是 DSH 设置页自己用的写入口——持 profile 锁、按目标插件的 schema 校验、
 *   原子写、只热重载被改的那一行，失败还会回滚。直接改文本既绕过锁（会和设置页互相覆盖），
 *   又得自己维护一套缩进解析，profile 形状一变就写不进去或写错位置。
 *   这里只做"旧配置 → 新配置"的纯对象变换（withProviderModels），写入交给 configEditor。
 *
 * 读 cordis.patch.yml 的部分（readPluginModelsConfig）只剩命令行预览在用：命令行里没有宿主。
 *
 * 只依赖 node: 内置模块（fetch 是 Node 18+ 的全局实现）。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isFile, resolveDshHome } from './services.js';
import { applyModelRules, hasModelRules } from './model-rules.js';

/** llm-pi-ai 的包名：按包名找 Loader 条目，profile 里的行 id 可能被用户改过。 */
export const LLM_PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';
export const HUB_KEY_REFS = Object.freeze({ cn: 'WORKBUDDY_PROXY_KEY_CN', intl: 'WORKBUDDY_PROXY_KEY_GLOBAL' });

export async function resolveModelApiKey(models, env = process.env, credentials) {
  if (models.apiKeyRef) {
    const result = await credentials?.resolve?.(models.apiKeyRef);
    return env[models.apiKeyRef] || (typeof result === 'string' ? result : result?.value) || '';
  }
  return models.apiKey || env.WORKBUDDY_PROXY_KEY || panelApiKey(models.panelConfig);
}

export async function hubRegionKeys(credentials, env = process.env) {
  const keys = {};
  for (const [realm, ref] of Object.entries(HUB_KEY_REFS)) {
    const result = await credentials?.resolve?.(ref);
    keys[realm] = env[ref] || (typeof result === 'string' ? result : result?.value) || '';
  }
  return keys;
}

/** 不把 Key 放到 URL；必须核对应答区域，旧 HUB 或错误绑定不能静默退回全局出口。 */
export async function fetchHubRegions({ models, credentials, env = process.env, keys }) {
  keys ??= await hubRegionKeys(credentials, env);
  const regions = await Promise.all(['cn', 'intl'].map(async (realm) => {
    if (!keys[realm]) return { ok: false, reason: `请先填写并保存 ${realm === 'cn' ? 'CN' : 'GL'} 绑定区域的 API Key` };
    const fetched = await fetchModels({ baseURL: models.baseURL, apiKey: keys[realm], timeoutMs: models.timeoutMs });
    if (!fetched.ok) return { ok: false, reason: `${realm === 'cn' ? 'CN' : 'GL'} 模型接口失败，请检查绑定 Key 和 HUB 状态` };
    if (fetched.realm !== realm && !(realm === 'intl' && fetched.realm === 'global')) return { ok: false, reason: 'API Key 未绑定正确区域，或 HUB 版本不支持按 Key 路由；请在 HUB 设置页核对' };
    return { ...fetched, realm, models: fetched.models.map((model) => ({ ...model, realm })), ref: HUB_KEY_REFS[realm] };
  }));
  const failed = regions.find((region) => !region.ok);
  return failed ?? { ok: true, regions };
}

function dualProviderName(provider, realm) { return `${provider}-hub-${realm === 'cn' ? 'cn' : 'global'}`; }
function ownsDualProvider(provider, ref) { return provider?.apiKeyEnv === ref && provider?.api === 'openai-completions'; }

/** 只删除使用本插件专用凭据引用的分组，不动名称碰巧相同的用户 provider。 */
function dropDualProviders(config, provider) {
  const providers = { ...config.providers };
  let changed = false;
  for (const [realm, ref] of Object.entries(HUB_KEY_REFS)) {
    const name = dualProviderName(provider, realm);
    if (ownsDualProvider(providers[name], ref)) { delete providers[name]; changed = true; }
  }
  return changed ? { ...config, providers } : config;
}

async function syncHubDual({ spec, models, editor, credentials, env, dryRun, removalGuard }) {
  const target = findConfigEntry(editor, { name: LLM_PI_AI_PACKAGE });
  if (!target) return { state: 'skipped', reason: `DSH 里没有可编辑的 ${LLM_PI_AI_PACKAGE} 条目` };
  const fetched = await fetchHubRegions({ models, credentials, env });
  if (!fetched.ok) return { state: 'failed', reason: fetched.reason };
  const documentPath = editor.documentPath;
  const groups = fetched.regions.map((region) => ({ ...region, name: dualProviderName(models.provider, region.realm), entries: planModelEntries(region.models, models) }));
  if (groups.some((group) => group.models.length === 0)) return { state: 'skipped', reason: '某个区域返回空目录，保留现有列表', documentPath };
  for (const group of groups) {
    if (!group.entries.length && (!hasModelRules(models.rules) || !selectModels(group.models, models.only).length)) return { state: 'skipped', reason: '某个区域按白名单过滤后为空，保留现有列表', documentPath };
    const existing = target.options?.config?.providers?.[group.name];
    if (existing && !ownsDualProvider(existing, group.ref)) return { state: 'failed', reason: `provider ${group.name} 已被占用，请先修改分组名`, documentPath };
  }
  if (removalGuard) {
    removalGuard.regions ??= {};
    let deferred = false;
    for (const group of groups) {
      const guard = removalGuard.regions[group.realm] ??= { missing: new Set() };
      if (!confirmRemovals(guard, providerModelIds(target.options?.config, group.name), group.entries.map((entry) => entry.id)).ok) deferred = true;
    }
    if (deferred) return { state: 'deferred', reason: '区域目录中的模型需连续两轮缺席后移除', realm: 'dual', documentPath };
  }
  const plan = (current) => {
    let config = current;
    for (const group of groups) {
      const existing = config?.providers?.[group.name];
      if (existing && !ownsDualProvider(existing, group.ref)) throw new Error(`provider ${group.name} 已被占用`);
      const skeleton = { ...providerSkeleton(models, spec), displayName: `WorkBuddy ${group.realm === 'cn' ? 'CN' : 'GL'}`, apiKeyEnv: group.ref };
      const providers = { ...plainObject(config).providers, [group.name]: { ...plainObject(existing), ...skeleton, models: group.entries } };
      // 原分组暂时清空，保留连接配置，关闭双区域后能恢复原有分组。
      if (providers[models.provider]) providers[models.provider] = { ...providers[models.provider], models: [] };
      config = { ...config, providers };
    }
    return config;
  };
  const entries = groups.flatMap((group) => group.entries);
  const planned = plan(target.options?.config ?? {});
  if (isDeepStrictEqual(planned, target.options?.config)) return { state: 'unchanged', entries, realm: 'dual', documentPath };
  if (dryRun) return { state: 'dry-run', entries, realm: 'dual', documentPath };
  try { await editor.edit(target, plan); }
  catch (error) { return { state: 'failed', reason: error.message, documentPath }; }
  return { state: 'updated', entries, realm: 'dual', documentPath };
}

/** 默认保留的思考档位：与 DSH 既有的三档 UI 对齐（低/高/最大）。 */
export const DEFAULT_EFFORTS = Object.freeze(['low', 'high', 'max']);

/** id 前缀 → 展示名里的区域标签：国内版 cn: / 国际版 global:。 */
const REGION_PREFIXES = Object.freeze([
  ['cn:', 'CN'],
  ['global:', 'GL'],
]);

/**
 * 倍率标签：`credits` 是 wb2api 给的积分倍率（形如 `x0.11`）。
 * 0 或缺失记为 `Free`（面板对免费模型不给倍率字段），其余去掉 `x` 前缀原样展示。
 */
export function creditsLabel(credits) {
  const raw = typeof credits === 'string' ? credits.trim() : typeof credits === 'number' ? String(credits) : '';
  if (!raw) return 'Free';
  const match = /^x?\s*([0-9]+(?:\.[0-9]+)?)$/i.exec(raw);
  if (match) return Number(match[1]) === 0 ? 'Free' : match[1];
  const stripped = raw.replace(/^x\s*/i, '').trim();
  return stripped || 'Free';
}

/**
 * hub 的出口名 → 展示名里的区域标签。hub 的模型 id 不带 cn:/global:（一次只服务一个出口），
 * 出口写在 /v1/models 应答顶层的 `realm` 里，由 fetchModels 抄到每个条目上。
 */
const REALM_LABELS = Object.freeze({ cn: 'CN', intl: 'GL', global: 'GL' });

/** hub 的出口 → 白名单键前缀：与 wb2api 的模型 id 前缀一致，两种网关因此共用同一份白名单。 */
const REALM_KEY_PREFIXES = Object.freeze({ cn: 'cn:', intl: 'global:', global: 'global:' });

/** 键带的出口前缀（cn: / global:）；不带前缀返回 undefined。 */
function regionPrefixOf(key) {
  return REGION_PREFIXES.find(([prefix]) => String(key).startsWith(prefix))?.[0];
}

/**
 * 模型在白名单（models.only / exclude）里的键。
 *
 * wb2api 的 id 本身带 cn:/global:，键就是 id。hub 的 id 不带前缀、一次只服务一个出口，
 * 键 = 出口前缀 + id：CN 与 GL 的勾选因此分开记，hub 在看板里切出口后，同步自动换成那个出口的那一组，
 * 不用回插件卡片重新勾。写进 DSH 的模型 id 仍是 hub 认的裸 id，键只用于挑选。
 */
export function selectionKey(model) {
  if (regionPrefixOf(model.id)) return model.id;
  const prefix = typeof model.realm === 'string' ? REALM_KEY_PREFIXES[model.realm] : undefined;
  return prefix ? `${prefix}${model.id}` : model.id;
}

/**
 * 按白名单挑模型（保持白名单里的先后顺序，同一模型只取一次）。
 *
 * - 白名单为空 = 全部（既有语义）；
 * - wb2api：键就是 id，逐个对上；
 * - hub：不带前缀的老条目（改按出口记之前存下的）对任何出口都生效；带前缀的只对当前出口生效。
 *   当前出口在白名单里一个条目都没有时按"空 = 全部"处理：第一次切到一个从没勾过的出口，
 *   DSH 里换成它的全部模型，而不是留着上个出口的旧条目。
 *
 * @returns {object[]} 选中的模型
 */
export function selectModels(models, only = []) {
  const byId = new Map();
  const byKey = new Map();
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || byId.has(model.id)) continue;
    byId.set(model.id, model);
    byKey.set(model.id, model);
    byKey.set(selectionKey(model), model);
  }
  const list = Array.isArray(only) ? only : [];
  // 只有 hub 这种"裸 id + 出口"的清单才按出口挑。wb2api 一次列出两个出口，某个出口暂时缺席
  // （网络故障）时，不能把它当成"这个出口没勾过"、换成另一个出口的全部模型。
  const realmScoped = [...byId.values()].some((model) => selectionKey(model) !== model.id);
  const listed = new Set([...byKey.keys()].map(regionPrefixOf).filter(Boolean));
  const applicable = realmScoped
    ? list.filter((key) => {
        const prefix = regionPrefixOf(key);
        return !prefix || listed.has(prefix);
      })
    : list;
  if (applicable.length === 0) return [...byId.values()];
  const picked = new Map();
  for (const key of applicable) {
    const model = byKey.get(key);
    if (model && !picked.has(model.id)) picked.set(model.id, model);
  }
  return [...picked.values()];
}

/**
 * 面板回显用的白名单：hub 下把不带前缀的老条目展开成 cn: 与 global: 两条（语义不变：两个出口都选中）。
 * 面板之后保存的就全是带前缀的键，取消一个出口的勾选不会连带另一个出口。
 */
export function scopedSelection(only = [], gateway) {
  if (gateway !== 'hub') return [...only];
  const out = [];
  for (const key of only) {
    for (const scoped of regionPrefixOf(key) ? [key] : REGION_PREFIXES.map(([prefix]) => `${prefix}${key}`)) {
      if (!out.includes(scoped)) out.push(scoped);
    }
  }
  return out;
}

/** 展示名：`<上游名> <CN|GL> <倍率>`；上游名已带同款后缀时不重复追加。 */
export function modelDisplayName(model) {
  const prefixed = REGION_PREFIXES.find(([prefix]) => model.id.startsWith(prefix))?.[1];
  const region = prefixed ?? (typeof model.realm === 'string' ? REALM_LABELS[model.realm] : undefined);
  const base = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id;
  const suffix = creditsLabel(model.credits);
  // 先去掉上游名称已有的同款倍率，再把区域插到倍率前，避免产生重复倍率或把区域放到末尾。
  const name = base.toLowerCase().endsWith(` ${suffix.toLowerCase()}`)
    ? base.slice(0, -suffix.length).trimEnd()
    : base;
  return [name, region, suffix].filter(Boolean).join(' ');
}

function positiveInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/** 单个模型条目上的思考档位；`auto` 表示按上游声明的档位生成。 */
export function modelEfforts(model, efforts) {
  if (model.supports_reasoning === false) return [];
  if (efforts !== 'auto') return [...efforts];
  const declared = Array.isArray(model.reasoning_supported_efforts)
    ? model.reasoning_supported_efforts.filter((e) => typeof e === 'string' && e.trim())
    : [];
  return declared.length > 0 ? declared : [...DEFAULT_EFFORTS];
}

/**
 * 把 `/v1/models` 的原始条目规划成 `llm-pi-ai` 的模型配置条目。
 *
 * 顺序规则：配了 `only` 就按 `only` 里的先后顺序（保留用户自己排的展示顺序），
 * 否则按后端返回顺序（上游本身就是 cn: 一批、global: 一批）。
 *
 * @param {object[]} models 后端返回的模型
 * @param {{ only?: string[], exclude?: string[], efforts?: string[] | 'auto' }} options
 */
export function planModelEntries(models, options = {}) {
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  const efforts = options.efforts === 'auto' ? 'auto' : Array.isArray(options.efforts) ? options.efforts : DEFAULT_EFFORTS;

  const entries = [];
  for (const model of applyModelRules(selectModels(models, options.only), options.rules)) {
    if (exclude.has(model.id) || exclude.has(selectionKey(model))) continue;
    const entry = { id: model.id, name: modelDisplayName(model) };
    const contextWindow = positiveInt(model.context_length);
    if (contextWindow) entry.contextWindow = contextWindow;
    const maxTokens = positiveInt(model.max_output_tokens);
    if (maxTokens) entry.maxTokens = maxTokens;
    entry.input = model.supports_images === true ? ['text', 'image'] : ['text'];
    const effortsForModel = modelEfforts(model, efforts);
    if (effortsForModel.length > 0) {
      entry.reasoningEfforts = Object.fromEntries(effortsForModel.map((e) => [e, e]));
    }
    entries.push(entry);
  }
  return entries;
}

/** YAML 标量：只在裸标量不安全时才加单引号，尽量与手写文件的排布一致。 */
export function yamlScalar(value) {
  const text = String(value);
  const unsafe =
    text === '' ||
    text !== text.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /:\s|:\s*$|\s#/.test(text) ||
    /[\n\r\t]/.test(text);
  return unsafe ? `'${text.replace(/'/g, "''")}'` : text;
}

/**
 * 渲染 models 段的行（不含 `models:` 那一行本身）；命令行预览用，排版与手写 profile 一致。
 *
 * @param {object[]} entries planModelEntries 的结果
 * @param {number} itemIndent `- id:` 那一层的缩进
 */
export function renderModelsBlock(entries, itemIndent) {
  const pad = (n) => ' '.repeat(itemIndent + n);
  const lines = [];
  for (const entry of entries) {
    lines.push(`${pad(0)}- id: ${yamlScalar(entry.id)}`);
    lines.push(`${pad(2)}name: ${yamlScalar(entry.name)}`);
    if (entry.contextWindow) lines.push(`${pad(2)}contextWindow: ${entry.contextWindow}`);
    if (entry.maxTokens) lines.push(`${pad(2)}maxTokens: ${entry.maxTokens}`);
    lines.push(`${pad(2)}input:`);
    for (const modality of entry.input) lines.push(`${pad(4)}- ${modality}`);
    if (entry.reasoningEfforts) {
      lines.push(`${pad(2)}reasoningEfforts:`);
      for (const [id, value] of Object.entries(entry.reasoningEfforts)) {
        lines.push(`${pad(4)}${yamlScalar(id)}: ${yamlScalar(value)}`);
      }
    }
  }
  return lines;
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '';

const plainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};

/**
 * 纯对象变换：把 provider 的 models 换成新条目；provider 整段不在时按骨架补建。
 *
 * 补建是实际遇到过的情况：profile 里 workbuddy provider 整段丢失后，DSH 模型列表里的
 * WorkBuddy 分组随之消失。骨架与本机原先手写的那段一致，密钥只写变量名（凭据库里的
 * WORKBUDDY_PROXY_KEY），不落明文。其它 provider 与其它字段原样保留。
 *
 * @returns {{ changed: boolean, created: boolean, config: object }}
 */
export function withProviderModels(config, providerName, entries, skeleton) {
  const base = plainObject(config);
  const providers = plainObject(base.providers);
  const existing = providers[providerName];
  const created = Object.keys(plainObject(existing)).length === 0;
  const provider = created ? { ...skeleton, models: entries } : { ...existing, models: entries };
  const changed = created || !isDeepStrictEqual(existing.models, entries);
  return { changed, created, config: { ...base, providers: { ...providers, [providerName]: provider } } };
}

/** provider 当前配置里的模型 id（按配置顺序）；provider 不在时为空。 */
export function providerModelIds(config, providerName) {
  const models = plainObject(plainObject(plainObject(config).providers)[providerName]).models;
  return Array.isArray(models) ? models.map((model) => model?.id).filter((id) => typeof id === 'string') : [];
}

/**
 * 定时同步的移除确认：本轮要从 provider 里删掉的模型，必须上一轮也已缺席才放行。
 *
 * 面板的模型列表来自上游，上游抖动或某个域（cn / global）临时拉取失败时 `/v1/models`
 * 可能短暂少一批模型；只看一次就删，会把用户正在用的模型从 DSH 里抹掉，下一轮再加回来。
 * 连续两轮缺席才算真的下架。guard 是调用方持有的可变状态（{ missing: Set }），每轮按本轮结果覆盖。
 *
 * @returns {{ ok: boolean, missing: string[] }} ok=false 表示本轮应推迟写入
 */
export function confirmRemovals(guard, currentIds, nextIds) {
  const next = new Set(nextIds);
  const missing = currentIds.filter((id) => !next.has(id));
  const previous = guard.missing instanceof Set ? guard.missing : new Set();
  guard.missing = new Set(missing);
  return { ok: missing.every((id) => previous.has(id)), missing };
}

/** 补建 provider 用的骨架：与 llm-pi-ai 的 OpenAI 兼容 provider 字段一致。 */
export function providerSkeleton(models, spec) {
  return {
    displayName: models.provider === 'workbuddy' ? 'WorkBuddy' : models.provider,
    apiKeyEnv: 'WORKBUDDY_PROXY_KEY',
    baseURL: providerBaseURL(models.baseURL || `http://${spec.host}:${spec.port}`),
    api: 'openai-completions',
    reasoning: 'max',
  };
}

/** provider 的 baseURL（OpenAI 兼容，带 /v1/）：由 /v1/models 地址去掉末尾的 models 得到。 */
export function providerBaseURL(baseURL) {
  const endpoint = modelsEndpoint(baseURL);
  return endpoint ? endpoint.replace(/models$/, '') : undefined;
}

/**
 * 在 configEditor 的可编辑条目里找一行：先按 id，再按包名。
 * 只认 configEditor.entries() 给的条目——那是 profile 顶层、id 唯一、能安全写回的行。
 */
export function findConfigEntry(editor, { id, name } = {}) {
  const entries = [...(editor?.entries?.() ?? [])];
  return (
    (id !== undefined ? entries.find((entry) => entry.options?.id === id) : undefined) ??
    (name !== undefined ? entries.find((entry) => entry.options?.name === name) : undefined)
  );
}

/** 拼 `/v1/models`：允许 baseURL 写成 `http://host:port`、`.../v1` 或 `.../v1/`。 */
export function modelsEndpoint(baseURL) {
  const base = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
  if (!base) return undefined;
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/** 读 wb2api 自己的 config.json 拿网关密钥（`api_key` 为空表示不鉴权）。 */
export function panelApiKey(panelConfigPath) {
  if (!panelConfigPath || !isFile(panelConfigPath)) return '';
  try {
    const parsed = JSON.parse(readFileSync(panelConfigPath, 'utf8'));
    return typeof parsed?.api_key === 'string' ? parsed.api_key.trim() : '';
  } catch {
    return '';
  }
}

/** 拉取模型清单；任何失败都返回 ok:false，由调用方决定是否保持现有配置。 */
export async function fetchModels(options = {}) {
  const { baseURL, apiKey = '', timeoutMs = 30_000, signal, realm: requestRealm } = options;
  const url = modelsEndpoint(baseURL);
  if (!url) return { ok: false, reason: '没有可用的网关地址' };

  const headers = { accept: 'application/json' };
  if (requestRealm) headers['x-realm'] = requestRealm;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await fetch(url, { headers, signal: composed });
  } catch (error) {
    return { ok: false, reason: `${url} 请求失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { ok: false, reason: `${url} 返回 ${response.status}` };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: `${url} 的响应不是合法 JSON` };
  }
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const realm = typeof payload?.realm === 'string' ? payload.realm : undefined;
  const models = list
    .filter((model) => model && typeof model.id === 'string' && model.id.trim())
    // 条目自己带了 realm 就不覆盖；只给 hub 这种"出口写在顶层"的应答补上。
    .map((model) => (realm && model.realm === undefined ? { ...model, realm } : model));
  return { ok: true, url, models, realm };
}

/** profile 的 cordis.patch.yml：优先显式配置，其次 DSH_PROFILE_DIR，最后 DSH_HOME/DSH_PROFILE 拼出来。 */
export function resolveProfilePatchPath(env = process.env, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit.trim());
  const profileDir = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
  if (profileDir) return join(resolve(profileDir), 'cordis.patch.yml');
  const profile = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : '';
  if (profile) return join(resolveDshHome(env), 'profiles', profile, 'cordis.patch.yml');
  return undefined;
}

/** 只认文档里写明的标量形状；解析不了就原样返回字符串。 */
function parseScalar(raw) {
  const text = raw.trim();
  if (!text) return '';
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/**
 * 定位 profile patch 里本插件那一行的 `config.models` 段。
 *
 * 只认一种形状（也就是本机 profile 的实际形状）：
 *
 *     - id: dsh-autostart-workbuddy
 *       name: dsh-autostart-workbuddy
 *       config:
 *         models:
 *           enabled: true
 *           only:
 *             - cn:xxx
 *
 * 认不出就返回 ok:false，让调用方放弃。
 */
function locatePluginModelsBlock(lines, entryId) {
  const entryIndex = lines.findIndex((line) => {
    const match = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(line);
    return Boolean(match) && parseScalar(match[2]) === entryId;
  });
  if (entryIndex < 0) return { ok: false, reason: `profile 里没有 ${entryId} 这一行` };

  const entryIndent = indentOf(lines[entryIndex]);
  let entryEnd = lines.length;
  for (let i = entryIndex + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= entryIndent) {
      entryEnd = i;
      break;
    }
  }

  const configIndex = lines.findIndex(
    (line, i) => i > entryIndex && i < entryEnd && /^\s*config:\s*(#.*)?$/.test(line),
  );
  if (configIndex < 0) return { ok: false, reason: `${entryId} 没有 config 段` };

  const modelsIndex = lines.findIndex(
    (line, i) =>
      i > configIndex &&
      i < entryEnd &&
      indentOf(line) === indentOf(lines[configIndex]) + 2 &&
      /^\s*models:\s*(#.*)?$/.test(line),
  );
  if (modelsIndex < 0) return { ok: false, reason: `${entryId} 没有 config.models 段` };

  const modelsIndent = indentOf(lines[modelsIndex]);
  return {
    ok: true,
    entryIndex,
    entryEnd,
    modelsIndex,
    modelsIndent,
    keyIndent: modelsIndent + 2,
    itemIndent: modelsIndent + 4,
  };
}

/**
 * 读 profile patch 里本插件那一行的 `config.models`。
 *
 * 只给命令行预览（lib/sync-cli.js）用：models 配置是 DSH 启动时由宿主传给插件的，
 * 命令行里没有宿主，只能读文件。插件运行时一律用宿主给的配置（见 lib/index.js 的 internal/update 钩子）。
 *
 * 形状见 locatePluginModelsBlock；认不出就返回 undefined。
 */
export function readPluginModelsConfig(text, entryId = 'dsh-autostart-workbuddy') {
  const lines = String(text).split(/\r?\n/);
  const located = locatePluginModelsBlock(lines, entryId);
  if (!located.ok) return undefined;

  const { modelsIndex, entryEnd, modelsIndent, keyIndent, itemIndent } = located;

  const out = {};
  for (let i = modelsIndex + 1; i < entryEnd; i += 1) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (indent <= modelsIndent) break;
    if (indent !== keyIndent) continue;

    const key = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!key) continue;
    const [, name, rest] = key;
    if (rest.trim() && !rest.trim().startsWith('#')) {
      // `only: []` 是"显式清空"的写法（Web 面板保存空勾选时会这么写）。YAML 里它就是
      // 空列表，不能落到 parseScalar 变成字符串 "[]"——否则调用方会以为白名单里
      // 有一个叫 "[]" 的模型，或者误判成"没配白名单"。
      out[name] = rest.trim() === '[]' ? [] : parseScalar(rest);
      continue;
    }
    // 值是缩进列表（only / exclude / efforts）。
    const items = [];
    for (let j = i + 1; j < entryEnd; j += 1) {
      if (isBlank(lines[j])) continue;
      const itemIndentNow = indentOf(lines[j]);
      if (itemIndentNow <= indent) break;
      if (itemIndentNow !== itemIndent) continue;
      const item = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
      if (item) items.push(parseScalar(item[1]));
    }
    out[name] = items;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 同步一次模型列表：拉 /v1/models → 按白名单规划 → 通过 configEditor 写进 llm-pi-ai 的配置，
 * 写入（或判定无变化）后再确保 provider 引用的网关密钥在凭据库里有值（见 ensureProxyCredential）。
 *
 * @param {object} options
 * @param {object} options.spec     已解析的服务规格（取 host/port 拼 /v1/models）
 * @param {object} options.models   已解析的 models 配置
 * @param {object} [options.editor] 宿主的 configEditor 服务；没有就无法写入
 * @param {object} [options.credentials] 宿主的 credentials 服务；没有就只同步模型、不补密钥
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.dryRun] 只算不写
 * @param {{ missing?: Set<string> }} [options.removalGuard] 定时同步传入：移除模型需连续两轮确认（见 confirmRemovals）
 */
export async function syncModels(options) {
  const { spec, models, editor, credentials, env = process.env, dryRun = false, removalGuard } = options;

  if (!models?.enabled) return { state: 'disabled' };
  if (typeof editor?.edit !== 'function') {
    return { state: 'skipped', reason: '宿主没有 configEditor 服务，无法写入模型列表' };
  }
  if (models.hubDual) return syncHubDual(options);
  const documentPath = editor.documentPath;

  const target = findConfigEntry(editor, { name: LLM_PI_AI_PACKAGE });
  if (!target) return { state: 'skipped', reason: `DSH 里没有可编辑的 ${LLM_PI_AI_PACKAGE} 条目`, documentPath };

  const apiKey = await resolveModelApiKey(models, env, credentials);

  const fetched = await fetchModels({
    baseURL: models.baseURL || `http://${spec.host}:${spec.port}`,
    apiKey,
    timeoutMs: models.timeoutMs,
  });
  if (!fetched.ok) return { state: 'failed', reason: fetched.reason, documentPath };

  // 上游故障时面板会返回空列表（还带负缓存），此时绝不能把已有配置清空。
  if (fetched.models.length === 0) {
    return { state: 'skipped', reason: '后端返回空模型列表，保持现有配置', documentPath };
  }

  // hub 的当前出口（应答顶层的 realm）；wb2api 没有这一项。定时同步靠它认出"出口切换了"。
  const realm = fetched.realm;
  const entries = planModelEntries(fetched.models, models);
  if (entries.length === 0 && (!hasModelRules(models.rules) || !selectModels(fetched.models, models.only).length)) {
    return { state: 'skipped', reason: '按 only/exclude 过滤后没有可写的模型', realm, documentPath };
  }

  // 推迟时连密钥也不碰：本轮什么都不写，下一轮确认后照常补。
  if (removalGuard) {
    const removal = confirmRemovals(removalGuard, providerModelIds(target.options?.config, models.provider), entries.map((entry) => entry.id));
    if (!removal.ok) {
      return { state: 'deferred', reason: `后端暂未提供 ${removal.missing.join(', ')}，下一轮仍缺席再移除`, missing: removal.missing, entries, realm, documentPath };
    }
  }

  const skeleton = providerSkeleton(models, spec);
  const singlePlan = (config) => {
    const planned = withProviderModels(config, models.provider, entries, skeleton);
    const cleaned = dropDualProviders(planned.config, models.provider);
    return { ...planned, config: cleaned, changed: planned.changed || cleaned !== planned.config };
  };
  const planned = singlePlan(target.options?.config);
  if (dryRun) {
    return planned.changed
      ? { state: 'dry-run', entries, created: planned.created, realm, documentPath }
      : { state: 'unchanged', entries, realm, documentPath };
  }
  if (!planned.changed) {
    const credential = await ensureProxyCredential({
      credentials, ref: providerKeyRef(planned.config, models.provider), apiKey,
    });
    return { state: 'unchanged', entries, credential, realm, documentPath };
  }

  // change 回调拿的是 configEditor 在锁内重新读出的最新配置：在它上面重算，
  // 而不是用上面的 planned，避免把锁外读到的旧配置写回去。
  let created = planned.created;
  let written = planned.config;
  try {
    await editor.edit(target, (current) => {
      const next = singlePlan(current);
      created = next.created;
      written = next.config;
      return next.config;
    });
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error), entries, documentPath };
  }
  const credential = await ensureProxyCredential({
    credentials, ref: providerKeyRef(written, models.provider), apiKey,
  });
  return { state: 'updated', entries, created, credential, realm, documentPath };
}

/**
 * 网关不鉴权（wb2api 的 config.json 里 `api_key` 为空）时写进凭据库的占位值。
 *
 * 需要它是因为两条宿主规则叠在一起：provider 配了 `apiKeyEnv` 时，llm-pi-ai 每轮都要从凭据库
 * 解析出非空值，解析不到就整轮报 MISSING_CREDENTIAL；而凭据库又拒绝存空串。
 * 不鉴权的 wb2api 不看 Authorization 头，所以随便一个非空值都能用。用固定值是为了日后认得出
 * "这是插件补的占位"：面板后来设了密钥，就可以把它换掉，而不会碰用户自己存的值。
 */
export const PLACEHOLDER_PROXY_KEY = 'workbuddy-no-auth';

/** 凭据引用的语法（与 @deepseek-ai/dsh-credentials 一致）：不合法的名字根本存不进去。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** provider 实际使用的凭据引用名（`apiKeyEnv`）；没有或不合法时返回 undefined。 */
export function providerKeyRef(config, providerName) {
  const ref = plainObject(plainObject(plainObject(config).providers)[providerName]).apiKeyEnv;
  return typeof ref === 'string' && CREDENTIAL_REF_PATTERN.test(ref) ? ref : undefined;
}

/**
 * 确保 provider 引用的网关密钥在凭据库里有值，否则 llm-pi-ai 一发消息就报 MISSING_CREDENTIAL。
 *
 * 实际遇到过的情况：新装的机器上同步补建了 workbuddy provider（只写变量名），模型选择器里有了
 * WorkBuddy 模型，但凭据库里没有 WORKBUDDY_PROXY_KEY，于是每轮都失败。
 *
 * 规则：
 *   - 已有非空值（凭据库存的、或启动环境给的）且不是本插件的占位值 → 一律不动，用户设的优先；
 *   - 没有值 → 写入同步时拉模型用的那个密钥（插件配置 apiKey / config.json 的 api_key），
 *     密钥为空（网关不鉴权）就写占位值；
 *   - 现值是占位值而网关后来设了密钥 → 换成真密钥。
 * 失败只体现在返回值里，不影响模型列表的同步结果。
 *
 * @param {{ credentials?: object, ref?: string, apiKey?: string }} options
 *   `credentials` 是宿主的 credentials 服务（resolve / set）。
 */
export async function ensureProxyCredential({ credentials, ref, apiKey = '' }) {
  if (!ref) return { state: 'skipped', reason: 'provider 没有可用的 apiKeyEnv' };
  if (typeof credentials?.resolve !== 'function' || typeof credentials?.set !== 'function') {
    return { state: 'skipped', ref, reason: '宿主没有 credentials 服务' };
  }
  const desired = apiKey || PLACEHOLDER_PROXY_KEY;
  try {
    const current = await credentials.resolve(ref);
    const value = typeof current?.value === 'string' ? current.value : '';
    if (value === desired || (value && value !== PLACEHOLDER_PROXY_KEY)) return { state: 'kept', ref };
    await credentials.set(ref, desired);
    return { state: value ? 'replaced' : 'created', ref, placeholder: !apiKey };
  } catch (error) {
    return { state: 'failed', ref, reason: error instanceof Error ? error.message : String(error) };
  }
}
