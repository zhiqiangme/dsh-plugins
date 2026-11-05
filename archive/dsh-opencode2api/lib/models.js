/**
 * OpenCode 模型列表同步：从本地 opencode2api 的 `/v1/models` 拉真实模型清单，
 * 写进 `llm-pi-ai` 插件配置里 opencode2api provider 的 `models`。
 *
 * 为什么是"改配置"而不是"运行期注册"：
 *   DSH 的 llm 服务只允许 provider 的归属插件注册模型（registerAdapter /
 *   registerModelDiscovery 都绑定各自的 settingsNs），本插件无法给 llm-pi-ai 的
 *   opencode2api 路由追加模型；模型清单本来就是 llm-pi-ai 的配置，所以改它的配置。
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
import { backendApiKey } from './backend-config.js';

/** llm-pi-ai 的包名：按包名找 Loader 条目，profile 里的行 id 可能被用户改过。 */
export const LLM_PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';

/** 默认保留的思考档位：与 DSH 既有的三档 UI 对齐（低/高/最大）。 */
export const DEFAULT_EFFORTS = Object.freeze(['low', 'high', 'max']);

/** 连字符分隔的各段首字母大写；保留原分隔符和上游模型 id。 */
export function modelDisplayName(model) {
  const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id;
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
}

export function priceLabel(model) {
  const cost = model.cost ?? model.metadata?.cost;
  if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return '—';
  return cost.input === 0 && cost.output === 0 ? 'Free' : `$${cost.input} / $${cost.output}`;
}

/** 只按网关声明的能力映射，不从模型名猜视觉或推理支持。 */
export function modelMetadata(model) {
  const metadata = model.metadata ?? {};
  return {
    contextWindow: positiveInt(model.context_window ?? model.context_length ?? metadata.context_window),
    maxTokens: positiveInt(model.max_output ?? model.max_output_tokens ?? metadata.max_output),
    vision: (metadata.input_modalities ?? []).includes('image'),
    reasoning: model.supports_reasoning === true || model.reasoning === true || metadata.reasoning === true,
  };
}

function positiveInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/** 单个模型条目上的思考档位；`auto` 表示按上游声明的档位生成。 */
export function modelEfforts(model, efforts) {
  if (!modelMetadata(model).reasoning) return [];
  if (efforts !== 'auto') return [...efforts];
  const declared = Array.isArray(model.reasoning_efforts)
    ? model.reasoning_efforts.filter((e) => typeof e === 'string' && e.trim())
    : [];
  return declared;
}

/**
 * 把 `/v1/models` 的原始条目规划成 `llm-pi-ai` 的模型配置条目。
 *
 * 顺序规则：配了 `only` 就按 `only` 里的先后顺序（保留用户自己排的展示顺序），
 * 否则按后端返回顺序。
 *
 * @param {object[]} models 后端返回的模型
 * @param {{ only?: string[], exclude?: string[], efforts?: string[] | 'auto' }} options
 */
export function planModelEntries(models, options = {}) {
  const only = Array.isArray(options.only) ? options.only : [];
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  const efforts = Array.isArray(options.efforts) ? options.efforts : 'auto';

  const byId = new Map();
  for (const model of models) {
    if (model && model.native_protocol !== 'systemone' && typeof model.id === 'string' && model.id.trim() && !byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }

  const picked = only.length > 0 ? only.map((id) => byId.get(id)).filter(Boolean) : [...byId.values()];

  const entries = [];
  for (const model of picked) {
    if (exclude.has(model.id)) continue;
    const entry = { id: model.id, name: modelDisplayName(model) };
    const metadata = modelMetadata(model);
    const contextWindow = metadata.contextWindow;
    if (contextWindow) entry.contextWindow = contextWindow;
    const maxTokens = metadata.maxTokens;
    if (maxTokens) entry.maxTokens = maxTokens;
    entry.input = metadata.vision ? ['text', 'image'] : ['text'];
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
 * 补建是实际遇到过的情况：profile 里 opencode2api provider 整段丢失后，DSH 模型列表里的
 * OpenCode 分组随之消失。骨架与本机原先手写的那段一致，密钥只写变量名（凭据库里的
 * OPENCODE2API_PROXY_KEY），不落明文。其它 provider 与其它字段原样保留。
 *
 * @returns {{ changed: boolean, created: boolean, config: object }}
 */
export function withProviderModels(config, providerName, entries, skeleton) {
  const base = plainObject(config);
  const providers = plainObject(base.providers);
  const existing = providers[providerName];
  const created = Object.keys(plainObject(existing)).length === 0;
  // 地址和凭据引用随同步更新；默认档位见 providerReasoning。
  const existingOptions = { ...plainObject(existing) };
  const reasoning = providerReasoning(existingOptions.reasoning, entries, skeleton);
  delete existingOptions.reasoning;
  const provider = created ? { ...skeleton, models: entries } : {
    ...existingOptions, ...(reasoning ? { reasoning } : {}),
    baseURL: skeleton.baseURL, apiKeyEnv: skeleton.apiKeyEnv, models: entries,
  };
  const changed = created || !isDeepStrictEqual(existing, provider);
  return { changed, created, config: { ...base, providers: { ...providers, [providerName]: provider } } };
}

/**
 * provider 同步后的默认档位。
 *
 * 默认档位属于整个 provider，选中模型里有一个不支持就会被拒绝请求。所以：已有的档位（用户手设的，
 * 或之前同步写入的 max）只要新清单里每个模型都支持就原样保留；不再全部支持时移除，
 * 再按骨架决定是否用 max。这样换模型时不会留下必然失败的默认值，也不会覆盖用户自己选的档位。
 */
export function providerReasoning(current, entries, skeleton) {
  const supportedByAll = (level) => entries.length > 0 && entries.every((entry) => Boolean(entry.reasoningEfforts?.[level]));
  if (typeof current === 'string' && current && supportedByAll(current)) return current;
  return skeleton?.reasoning;
}

/** provider 当前配置里的模型 id（按配置顺序）；provider 不在时为空。 */
export function providerModelIds(config, providerName) {
  const models = plainObject(plainObject(plainObject(config).providers)[providerName]).models;
  return Array.isArray(models) ? models.map((model) => model?.id).filter((id) => typeof id === 'string') : [];
}

/**
 * 定时同步的移除确认：本轮要从 provider 里删掉的模型，必须上一轮也已缺席才放行。
 *
 * 后端每隔几分钟刷新一次上游目录，刷新途中或某个上游临时失败时 `/v1/models` 可能短暂少几个模型；
 * 只看一次就删，会把用户正在用的模型从 DSH 里抹掉，下一轮再加回来。连续两轮缺席才算真的下架。
 * guard 是调用方持有的可变状态（{ missing: Set }），每轮都按本轮结果覆盖。
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
export function providerSkeleton(models, spec, entries = []) {
  return {
    displayName: models.provider === 'opencode2api' ? 'OpenCode' : models.provider,
    apiKeyEnv: models.apiKeyRef || 'OPENCODE2API_PROXY_KEY',
    baseURL: providerBaseURL(models.baseURL || `http://${spec.host}:${spec.port}`),
    api: 'openai-completions',
    // DSH 的默认档位属于整个 provider；混有不支持 Max 的模型时不能强设，否则会拒绝请求。
    ...(entries.length > 0 && entries.every((entry) => entry.reasoningEfforts?.max) ? { reasoning: 'max' } : {}),
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

/** 读取后端 server_keys 中首个已启用的本地 API Key。 */
export function panelApiKey(panelConfigPath) {
  return backendApiKey(panelConfigPath);
}

/**
 * 从 DSH 凭据库取一个引用的值。
 *
 * 宿主 `credentials.resolve(ref)` 返回 `{ value, source }`（未配置时为 undefined），不是字符串；
 * 直接当字符串用会拼出 `Bearer [object Object]`，比较时也永远不等。
 */
export async function resolveCredential(credentials, ref) {
  if (typeof credentials?.resolve !== 'function') return '';
  const hit = await credentials.resolve(ref);
  return typeof hit?.value === 'string' ? hit.value.trim() : '';
}

/** 拉取模型清单；任何失败都返回 ok:false，由调用方决定是否保持现有配置。 */
export async function fetchModels(options = {}) {
  const { baseURL, apiKey = '', timeoutMs = 30_000, signal } = options;
  const url = modelsEndpoint(baseURL);
  if (!url) return { ok: false, reason: '没有可用的 opencode2api 地址' };

  const headers = { accept: 'application/json' };
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
  const models = list.filter((model) => model && model.native_protocol !== 'systemone' && typeof model.id === 'string' && model.id.trim());
  return { ok: true, url, models };
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
 *     - id: dsh-opencode2api
 *       name: dsh-opencode2api
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
export function readPluginModelsConfig(text, entryId = 'dsh-opencode2api') {
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
 * 同步一次模型列表：拉 /v1/models → 按白名单规划 → 通过 configEditor 写进 llm-pi-ai 的配置。
 *
 * @param {object} options
 * @param {object} options.spec     已解析的服务规格（取 host/port 拼 /v1/models）
 * @param {object} options.models   已解析的 models 配置
 * @param {object} [options.editor] 宿主的 configEditor 服务；没有就无法写入
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
  const documentPath = editor.documentPath;

  const target = findConfigEntry(editor, { name: LLM_PI_AI_PACKAGE });
  if (!target) return { state: 'skipped', reason: `DSH 里没有可编辑的 ${LLM_PI_AI_PACKAGE} 条目`, documentPath };

  const ref = models.apiKeyRef || 'OPENCODE2API_PROXY_KEY';
  const apiKey = models.apiKey || env[ref]?.trim() || panelApiKey(models.panelConfig) ||
    await resolveCredential(credentials, ref);

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

  const entries = planModelEntries(fetched.models, models);
  if (entries.length === 0) {
    return { state: 'skipped', reason: '按 only/exclude 过滤后没有可写的模型', documentPath };
  }

  if (removalGuard) {
    const removal = confirmRemovals(removalGuard, providerModelIds(target.options?.config, models.provider), entries.map((entry) => entry.id));
    if (!removal.ok) {
      return { state: 'deferred', reason: `后端暂未提供 ${removal.missing.join(', ')}，下一轮仍缺席再移除`, missing: removal.missing, entries, documentPath };
    }
  }

  // 网关本地 Key 与上游 Zen/Go Key 不同。只在显式同步时写入 DSH 凭据库，
  // provider 配置只引用变量名，避免把随机生成的本地 Key 写进 profile。
  if (!dryRun && !env[ref]) {
    try {
      if (!apiKey || typeof credentials?.set !== 'function') {
        return { state: 'failed', reason: '缺少本地 API Key 或 DSH 凭据服务，未写入模型配置', documentPath };
      }
      // 值未变就不写：每次写入都会广播 credentials/reference-updated。
      const current = await resolveCredential(credentials, ref);
      if (current !== apiKey) {
        const info = await credentials.describe?.(ref);
        if (info?.writable === false) return { state: 'failed', reason: `${ref} 为只读凭据，未写入模型配置`, documentPath };
        await credentials.set(ref, apiKey);
      }
    } catch (error) {
      return { state: 'failed', reason: `保存 DSH 凭据失败：${error.message}`, documentPath };
    }
  }

  const skeleton = providerSkeleton(models, spec, entries);
  const planned = withProviderModels(target.options?.config, models.provider, entries, skeleton);
  if (!planned.changed) return { state: 'unchanged', entries, documentPath };
  if (dryRun) return { state: 'dry-run', entries, created: planned.created, documentPath };

  // change 回调拿的是 configEditor 在锁内重新读出的最新配置：在它上面重算，
  // 而不是用上面的 planned，避免把锁外读到的旧配置写回去。
  let created = planned.created;
  try {
    await editor.edit(target, (current) => {
      const next = withProviderModels(current, models.provider, entries, skeleton);
      created = next.created;
      return next.config;
    });
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error), entries, documentPath };
  }
  return { state: 'updated', entries, created, documentPath };
}
