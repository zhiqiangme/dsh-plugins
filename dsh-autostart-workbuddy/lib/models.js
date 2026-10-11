/**
 * WorkBuddy 模型列表同步：从本地 wb2api 的 `/v1/models` 拉真实模型清单，
 * 回写 profile 的 `cordis.patch.yml` 里 `llm-pi-ai` 的 workbuddy provider 的 `models:` 段。
 *
 * 为什么是"改配置"而不是"运行期注册"：
 *   DSH 的 llm 服务只允许 provider 的归属插件注册模型（registerAdapter /
 *   registerModelDiscovery 都绑定各自的 settingsNs），本插件无法给 llm-pi-ai 的
 *   workbuddy 路由追加模型；而模型清单本来就写在 profile 的 patch 层里，
 *   所以按"启动时同步一次"的方式接管，改动在下次启动（或配置热加载）后生效。
 *
 * 为什么自己做 YAML 手术而不是引 YAML 库：
 *   本插件刻意只依赖 node: 内置模块（见 services.js 顶部注释）。这里只需要替换
 *   一整段缩进列表，不需要完整解析 YAML，所以按缩进定位 + 整段替换，
 *   其余字节原样保留——profile 是手写文件，注释和排版不能被重排。
 *
 * 只依赖 node: 内置模块（fetch 是 Node 18+ 的全局实现）。
 */

import { constants, copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { isFile, resolveDshHome } from './services.js';

/** 默认保留的思考档位：与 DSH 既有的三档 UI 对齐（低/高/最大）。 */
export const DEFAULT_EFFORTS = Object.freeze(['low', 'high', 'max']);

/** id 前缀 → 名称前缀：国内版 cn: / 国际版 global:。 */
const REGION_PREFIXES = Object.freeze([
  ['cn:', 'CN'],
  ['global:', 'GL'],
]);

/** 生成的 models 段使用的备份后缀；清理旧备份时只认这个前缀。 */
const BACKUP_TAG = 'bak-before-model-sync';

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

/** 展示名：`<CN|GL> <上游名> <倍率>`；上游名已带同款后缀时不重复追加。 */
export function modelDisplayName(model) {
  const region = REGION_PREFIXES.find(([prefix]) => model.id.startsWith(prefix));
  const base = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id;
  const suffix = creditsLabel(model.credits);
  const head = region ? `${region[1]} ${base}` : base;
  return head.toLowerCase().endsWith(suffix.toLowerCase()) ? head : `${head} ${suffix}`;
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
  const only = Array.isArray(options.only) ? options.only : [];
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  const efforts = options.efforts === 'auto' ? 'auto' : Array.isArray(options.efforts) ? options.efforts : DEFAULT_EFFORTS;

  const byId = new Map();
  for (const model of models) {
    if (model && typeof model.id === 'string' && model.id.trim() && !byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }

  const picked = only.length > 0 ? only.map((id) => byId.get(id)).filter(Boolean) : [...byId.values()];

  const entries = [];
  for (const model of picked) {
    if (exclude.has(model.id)) continue;
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
 * 渲染 models 段的行（不含 `models:` 那一行本身）。
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

/**
 * 定位 provider 的 `models:` 段。
 *
 * 只认一种形状（也就是本机 profile 的实际形状）：
 *
 *     providers:
 *       <provider>:
 *         ...
 *         models:
 *           - id: ...
 *
 * 认不出就返回 ok:false，让调用方放弃写入——宁可不同步，也不能猜错位置改坏 profile。
 */
export function locateModelsBlock(lines, providerName = 'workbuddy') {
  let sawProviders = false;
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^(\s*)providers:\s*(#.*)?$/.exec(lines[i]);
    if (!header) continue;
    sawProviders = true;
    const providersIndent = header[1].length;
    const providerIndent = providersIndent + 2;
    const modelsIndent = providerIndent + 2;

    let providersEnd = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= providersIndent) {
        providersEnd = j;
        break;
      }
    }

    for (let j = i + 1; j < providersEnd; j += 1) {
      if (isBlank(lines[j]) || indentOf(lines[j]) !== providerIndent) continue;
      const key = /^\s*([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(lines[j]);
      if (!key || key[1] !== providerName) continue;

      let providerEnd = providersEnd;
      for (let k = j + 1; k < providersEnd; k += 1) {
        if (isBlank(lines[k])) continue;
        if (indentOf(lines[k]) <= providerIndent) {
          providerEnd = k;
          break;
        }
      }

      for (let k = j + 1; k < providerEnd; k += 1) {
        if (isBlank(lines[k]) || indentOf(lines[k]) !== modelsIndent) continue;
        if (!/^\s*models:\s*(#.*)?$/.test(lines[k])) continue;

        const first = lines.slice(k + 1, providerEnd).find((line) => !isBlank(line));
        if (!first || indentOf(first) <= modelsIndent) {
          return { ok: false, reason: `provider ${providerName} 的 models 段不是预期的缩进列表` };
        }

        let arrayEnd = providerEnd;
        for (let n = k + 1; n < providerEnd; n += 1) {
          if (isBlank(lines[n])) continue;
          if (indentOf(lines[n]) <= modelsIndent) {
            arrayEnd = n;
            break;
          }
        }
        while (arrayEnd > k + 1 && isBlank(lines[arrayEnd - 1])) arrayEnd -= 1;
        return { ok: true, modelsIndex: k, arrayEnd, itemIndent: indentOf(first) };
      }
      return { ok: false, reason: `provider ${providerName} 下没有 models 段` };
    }
  }
  // missing 让调用方区分"整个 provider 不在"（可以补建）与"在但形状不对"（必须拒绝）。
  if (sawProviders) return { ok: false, missing: 'provider', reason: `providers 段里没有 ${providerName}` };
  return { ok: false, reason: '文件里没有 providers: 段' };
}

/** llm-pi-ai 条目的识别：按包名认，id 可能被用户改过。 */
const LLM_PI_AI_NAME = /^\s+name:\s*["']?@deepseek-ai\/dsh-llm-pi-ai["']?\s*(#.*)?$/;

/**
 * provider 整段不在时，在 llm-pi-ai 条目的 `providers:` 末尾补建一段。
 *
 * 实际遇到过：profile 里 workbuddy provider 整段丢失后，只替换 models 段的同步就再也
 * 写不进去，DSH 模型列表里 WorkBuddy 分组随之消失，插件面板保存也无效。
 * 补建的骨架与本机原先手写的那段一致；密钥走凭据库的 WORKBUDDY_PROXY_KEY，不落明文。
 * 只往 llm-pi-ai 条目里加：别的插件（如 dsh-connect-trae）也可能有 providers: 段，不能加错地方。
 */
export function insertProviderBlock(lines, providerName, entries, provider) {
  for (let begin = 0; begin < lines.length; begin += 1) {
    if (!/^- /.test(lines[begin])) continue;
    // 条目在下一个顶格行（下一个条目或顶格注释）处结束。
    let end = lines.length;
    for (let j = begin + 1; j < lines.length; j += 1) {
      if (!isBlank(lines[j]) && indentOf(lines[j]) === 0) {
        end = j;
        break;
      }
    }
    if (!lines.slice(begin + 1, end).some((line) => LLM_PI_AI_NAME.test(line))) continue;

    for (let i = begin + 1; i < end; i += 1) {
      const header = /^(\s*)providers:\s*(#.*)?$/.exec(lines[i]);
      if (!header) continue;
      const providersIndent = header[1].length;
      let providersEnd = end;
      for (let j = i + 1; j < end; j += 1) {
        if (isBlank(lines[j])) continue;
        if (indentOf(lines[j]) <= providersIndent) {
          providersEnd = j;
          break;
        }
      }
      while (providersEnd > i + 1 && isBlank(lines[providersEnd - 1])) providersEnd -= 1;

      const pad = (n) => ' '.repeat(providersIndent + n);
      const rendered = renderModelsBlock(entries, providersIndent + 6);
      const block = [
        `${pad(2)}${providerName}:`,
        `${pad(4)}displayName: ${yamlScalar(provider.displayName)}`,
        `${pad(4)}apiKeyEnv: ${yamlScalar(provider.apiKeyEnv)}`,
        `${pad(4)}baseURL: ${yamlScalar(provider.baseURL)}`,
        `${pad(4)}api: openai-completions`,
        `${pad(4)}reasoning: max`,
        `${pad(4)}models:`,
        ...rendered,
      ];
      return { ok: true, lines: [...lines.slice(0, providersEnd), ...block, ...lines.slice(providersEnd)], rendered };
    }
    return { ok: false, reason: 'llm-pi-ai 条目下没有 providers: 段' };
  }
  return { ok: false, reason: 'profile 里没有 llm-pi-ai 条目' };
}

/** provider 的 baseURL（OpenAI 兼容，带 /v1/）：由 /v1/models 地址去掉末尾的 models 得到。 */
export function providerBaseURL(baseURL) {
  const endpoint = modelsEndpoint(baseURL);
  return endpoint ? endpoint.replace(/models$/, '') : undefined;
}

/**
 * 用生成的条目替换 `models:` 段，其余内容逐字节保留（含换行风格与结尾换行）。
 *
 * 传了 `provider`（补建用的骨架）且 provider 整段不在时，改为在 llm-pi-ai 里补建，见 insertProviderBlock。
 *
 * @returns {{ ok: boolean, changed?: boolean, created?: boolean, text?: string, rendered?: string[], reason?: string }}
 */
export function updatePatchText(text, entries, providerName = 'workbuddy', provider) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const located = locateModelsBlock(lines, providerName);
  if (!located.ok) {
    if (located.missing !== 'provider' || !provider) return { ok: false, reason: located.reason };
    const inserted = insertProviderBlock(lines, providerName, entries, provider);
    if (!inserted.ok) return { ok: false, reason: inserted.reason };
    return { ok: true, changed: true, created: true, text: inserted.lines.join(eol), rendered: inserted.rendered };
  }

  const rendered = renderModelsBlock(entries, located.itemIndent);
  const current = lines.slice(located.modelsIndex + 1, located.arrayEnd);
  if (current.length === rendered.length && current.every((line, i) => line === rendered[i])) {
    return { ok: true, changed: false, text, rendered };
  }

  const next = [
    ...lines.slice(0, located.modelsIndex + 1),
    ...rendered,
    ...lines.slice(located.arrayEnd),
  ];
  return { ok: true, changed: true, text: next.join(eol), rendered };
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
  const { baseURL, apiKey = '', timeoutMs = 30_000, signal } = options;
  const url = modelsEndpoint(baseURL);
  if (!url) return { ok: false, reason: '没有可用的 wb2api 地址' };

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
  const models = list.filter((model) => model && typeof model.id === 'string' && model.id.trim());
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
 * 读（readPluginModelsConfig）与写（updatePluginOnlyList）共用这一份定位逻辑，
 * 避免两处对"哪一段是 models"产生分歧。
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
 * 认不出就返回 ok:false，让调用方放弃——宁可不动，也不能猜错位置改坏 profile。
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
 * 为什么需要它：models 配置是 DSH 启动时由宿主传给插件的，命令行里没有宿主；
 * 手动同步（lib/sync-cli.js）与 Web 面板（lib/web.js）都直接从同一个文件里读，
 * 保证"手动跑一次"和"启动时自动同步"用的是同一份配置，不会各说各话。
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
 * 用新的白名单替换本插件那一行的 `config.models.only`，其余内容逐字节保留。
 *
 * 与 updatePatchText 的分工：那个改的是 llm-pi-ai 里 workbuddy provider 的模型清单
 * （内容由后端决定），这个改的是本插件自己的白名单（内容由用户在 Web 面板里勾选）。
 *
 * 空数组写成 `only: []` 而不是删掉整段：`only` 留空本来就等于"同步后端全部模型"，
 * 写成空数组语义相同，但用户下次打开面板能看出"这里被显式清空过"。
 *
 * @returns {{ ok: boolean, changed?: boolean, text?: string, reason?: string }}
 */
export function updatePluginOnlyList(text, only, entryId = 'dsh-autostart-workbuddy') {
  if (!Array.isArray(only) || only.some((id) => typeof id !== 'string')) {
    return { ok: false, reason: 'only 不是字符串数组' };
  }
  const ids = only.map((id) => id.trim()).filter(Boolean);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const located = locatePluginModelsBlock(lines, entryId);
  if (!located.ok) return { ok: false, reason: located.reason };

  const { modelsIndex, entryEnd, modelsIndent, keyIndent, itemIndent } = located;

  // 找现有的 only: 键，以及它名下的列表项范围。
  let onlyIndex = -1;
  let onlyEnd = -1;
  for (let i = modelsIndex + 1; i < entryEnd; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= modelsIndent) break;
    if (indent !== keyIndent) continue;
    const key = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i]);
    if (!key || key[1] !== 'only') continue;

    onlyIndex = i;
    onlyEnd = entryEnd;
    for (let j = i + 1; j < entryEnd; j += 1) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= keyIndent) {
        onlyEnd = j;
        break;
      }
    }
    while (onlyEnd > i + 1 && isBlank(lines[onlyEnd - 1])) onlyEnd -= 1;
    break;
  }

  const pad = (n) => ' '.repeat(n);
  const rendered =
    ids.length === 0
      ? [`${pad(keyIndent)}only: []`]
      : [`${pad(keyIndent)}only:`, ...ids.map((id) => `${pad(itemIndent)}- ${yamlScalar(id)}`)];

  let next;
  if (onlyIndex >= 0) {
    const current = lines.slice(onlyIndex, onlyEnd);
    if (current.length === rendered.length && current.every((line, i) => line === rendered[i])) {
      return { ok: true, changed: false, text };
    }
    next = [...lines.slice(0, onlyIndex), ...rendered, ...lines.slice(onlyEnd)];
  } else {
    // 没有 only: 就插在 models: 之后，缩进与同级键一致。
    next = [...lines.slice(0, modelsIndex + 1), ...rendered, ...lines.slice(modelsIndex + 1)];
  }
  return { ok: true, changed: true, text: next.join(eol) };
}

/** 改配置前先落备份，并只保留最近 N 份自己产生的备份，避免越积越多。 */
export function backupPatchFile(path, keep) {
  const stamp = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  })();
  // 同一秒内可能备份两次（面板保存：先备份再写白名单，紧接着同步又备份一次）。
  // 同名会让第二次覆盖第一次，丢掉"保存前"的原样；撞名就加序号，序号后缀按字典序仍排在原名之后。
  let backup = `${path}.${BACKUP_TAG}-${stamp}`;
  for (let n = 2; existsSync(backup); n += 1) backup = `${path}.${BACKUP_TAG}-${stamp}-${n}`;
  copyFileSync(path, backup, constants.COPYFILE_EXCL);

  if (keep > 0) {
    const prefix = `${basename(path)}.${BACKUP_TAG}-`;
    const stale = readdirSync(resolve(path, '..'))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, -keep);
    for (const name of stale) {
      try {
        unlinkSync(join(resolve(path, '..'), name));
      } catch {
        /* 删不掉就算了：留着不影响功能 */
      }
    }
  }
  return backup;
}

/**
 * 同步一次模型列表。
 *
 * @param {object} options
 * @param {object} options.spec     已解析的服务规格（取 host/port 拼 /v1/models）
 * @param {object} options.models   已解析的 models 配置
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.dryRun] 只算不写
 */
export async function syncModels(options) {
  const { spec, models, env = process.env, dryRun = false } = options;

  if (!models?.enabled) return { state: 'disabled' };

  const patchPath = resolveProfilePatchPath(env, models.profilePatch);
  if (!patchPath) return { state: 'skipped', reason: '无法确定 profile 的 cordis.patch.yml 路径' };
  if (!isFile(patchPath)) return { state: 'skipped', reason: `profile 配置不存在：${patchPath}` };

  const apiKey =
    models.apiKey ||
    (typeof env.WORKBUDDY_PROXY_KEY === 'string' ? env.WORKBUDDY_PROXY_KEY.trim() : '') ||
    panelApiKey(models.panelConfig);

  const fetched = await fetchModels({
    baseURL: models.baseURL || `http://${spec.host}:${spec.port}`,
    apiKey,
    timeoutMs: models.timeoutMs,
  });
  if (!fetched.ok) return { state: 'failed', reason: fetched.reason, patchPath };

  // 上游故障时面板会返回空列表（还带负缓存），此时绝不能把已有配置清空。
  if (fetched.models.length === 0) {
    return { state: 'skipped', reason: '后端返回空模型列表，保持现有配置', patchPath };
  }

  const entries = planModelEntries(fetched.models, models);
  if (entries.length === 0) {
    return { state: 'skipped', reason: '按 only/exclude 过滤后没有可写的模型', patchPath };
  }

  const before = readFileSync(patchPath, 'utf8');
  const updated = updatePatchText(before, entries, models.provider, {
    displayName: models.provider === 'workbuddy' ? 'WorkBuddy' : models.provider,
    apiKeyEnv: 'WORKBUDDY_PROXY_KEY',
    baseURL: providerBaseURL(models.baseURL || `http://${spec.host}:${spec.port}`),
  });
  if (!updated.ok) return { state: 'failed', reason: updated.reason, patchPath, entries };
  if (!updated.changed) return { state: 'unchanged', patchPath, entries };

  const { rendered, created } = updated;
  if (dryRun) return { state: 'dry-run', patchPath, entries, rendered, created };

  const backup = backupPatchFile(patchPath, models.keepBackups ?? 3);
  writeFileSync(patchPath, updated.text);
  return { state: 'updated', patchPath, entries, backup, created };
}
