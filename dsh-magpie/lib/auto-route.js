import { displayModelName } from './names.js';

export const AUTO_PREFIX = 'auto:';
export const ROUTER_BASE_PATH = '/plugins/dsh-magpie/router';

/** 上游快照的月日版本号与计费档位；没有这些明确标记时不猜测。 */
const MODEL_VERSION_SUFFIX = /-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
const MODEL_TIER_SUFFIX = /(?<=[a-z0-9])[-_]?(free|std)$/i;
/** Preview 与中文“预览版”是同一变体标记，合并时不算型号差异。 */
const MODEL_PREVIEW_SUFFIX = /[-_\s]?(preview|预览版)$/i;
/** (Max) 是同一模型的推理档位变体标记（Trae 命名），合并时不算型号差异。 */
const MODEL_TIER_MARKER = /\s*[(（]\s*max\s*[)）]$/i;

/**
 * 同款模型的合并键：供应商只看路由前缀，型号看裸 ID，不按 DeepSeek / GLM 大系列合并。
 * 与 WorkBuddy 一致，月日快照和 free / std 不算不同型号；其它名称差异不能猜测合并。
 */
export function routeKey(id) {
  let text = String(id ?? '').trim();
  if (text.startsWith(AUTO_PREFIX)) text = text.slice(AUTO_PREFIX.length);
  const slash = text.indexOf('/');
  if (slash >= 0) text = text.slice(slash + 1);
  return text.toLowerCase().replace(MODEL_VERSION_SUFFIX, '').replace(MODEL_TIER_SUFFIX, '').replace(MODEL_PREVIEW_SUFFIX, '');
}

/**
 * 别名 ID（如 frontier-1 / qmodel_latest）看不出同款，只能靠显示名识别。
 * 仅带版本号的名称才参与按名合并：search_agent_qwen_fast 这类通用别名同名也不并，避免误合不同模型。
 */
function baseName(row) {
  return displayModelName(row, {}).replace(MODEL_TIER_MARKER, '').trim();
}
function nameKey(row) {
  const text = baseName(row).toLowerCase().replace(/[\s_-]+/g, '-').replace(MODEL_PREVIEW_SUFFIX, '');
  return /\d/.test(text) ? text : '';
}

function smallest(members, field) {
  const values = members.map((row) => row[field]).filter(Boolean);
  return values.length ? { [field]: Math.min(...values) } : {};
}

function mergedEntry(key, members) {
  const first = members[0];
  // 单个候选保留供应商简称；多个候选只显示型号和 Auto，避免误以为固定到某家供应商。
  const name = members.length === 1 ? displayModelName(first) : `${baseName(first)} Auto`;
  const reasoningEfforts = (first.reasoningEfforts ?? []).filter((level) => members.every((row) => row.reasoningEfforts?.includes(level)));
  return {
    id: `${AUTO_PREFIX}${key}`, name,
    ...smallest(members, 'contextWindow'), ...smallest(members, 'maxTokens'),
    input: members.some((row) => row.input?.includes('image')) ? ['text', 'image'] : ['text'],
    reasoningEfforts,
  };
}

/**
 * 把当前勾选转换成 DSH 的 auto 条目和转发候选。两处共用同一份规划，避免界面列出的能力与实际选路不一致。
 * 组间按第一次出现的位置、组内按清单顺序排列；后者就是无固定记录时的选路优先级。
 */
export function planAutoRoute(config) {
  const groups = new Map();
  const byName = new Map();
  for (const row of config.models) {
    if (!row.enabled) continue;
    const idKey = routeKey(row.id);
    const named = nameKey(row);
    // ID 键优先；ID 看不出同款时按带版本号的显示名归组（Preview / 预览版已等价）。
    const key = groups.has(idKey) ? idKey : (named && byName.get(named)) || idKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
    if (named && !byName.has(named)) byName.set(named, key);
  }
  const entries = [], routes = new Map();
  for (const [key, members] of groups) {
    const entry = mergedEntry(key, members);
    entries.push(entry);
    routes.set(entry.id, members);
  }
  return { entries, routes };
}
