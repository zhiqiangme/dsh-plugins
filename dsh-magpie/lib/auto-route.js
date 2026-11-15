import { createHash } from 'node:crypto';
import { REASONING_LEVELS } from './config.js';
import { modelNameParts } from './names.js';

export const AUTO_PREFIX = 'auto:';
export const ROUTER_BASE_PATH = '/plugins/dsh-magpie/router';
/**
 * 目录没有声明思考档位时的兜底：与 WorkBuddy 及 DSH 的三档选择器一致（低 / 高 / 最大）。
 * 不兜底时目录里没写档位的模型（LongCat、MiMo、Qwen 预览版等）在 DSH 里没有思考深度可选。
 */
export const DEFAULT_EFFORTS = Object.freeze(['low', 'high', 'max']);

/** 上游快照的月日版本号与计费档位；没有这些明确标记时不猜测。 */
const MODEL_VERSION_SUFFIX = /-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
const MODEL_TIER_SUFFIX = /(?<=[a-z0-9])[-_]?(free|std)$/i;
/** Preview 与中文“预览版”是同一变体标记，合并时不算型号差异。 */
const MODEL_PREVIEW_SUFFIX = /[-_\s]?(preview|预览版)$/i;
/** (Max) 是同一模型的推理档位变体标记（Trae 命名），合并时不算型号差异。 */
const MODEL_TIER_MARKER = /\s*[(（]\s*max\s*[)）]$/i;
// 已确认的无版本号模型名：仅显式列出的具体型号可按名合并，不能放开搜索代理等通用别名。
const VERSIONLESS_MODEL_NAMES = new Set(['seed-evolving']);
// Auto 是同款的路由变体，只处理末尾或 Max 前的标记，不能把名称中间的 auto 或独立的 auto 删掉。
const MODEL_AUTO_MARKER = /[-_\s]+auto(?=[-_\s]+max$|$)/i;
// 用户确认的同款别名；高速版有独立价格，不做模糊的 fast / 高速后缀归一。
const MODEL_NAME_ALIASES = new Map([['豆包-2.1-pro', 'Seed-2.1-Pro'], ['doubao-seed-2.1-pro', 'Seed-2.1-Pro']]);

/**
 * 同款模型的合并键：供应商只看路由前缀，型号看裸 ID，不按 DeepSeek / GLM 大系列合并。
 * 月日快照、free / std 与 Auto 路由后缀不算不同型号；高速版等其它差异不能猜测合并。
 */
export function routeKey(id, { legacyGrouping = false } = {}) {
  let text = String(id ?? '').trim();
  if (text.startsWith(AUTO_PREFIX)) text = text.slice(AUTO_PREFIX.length);
  const slash = text.indexOf('/');
  if (slash >= 0) text = text.slice(slash + 1);
  const key = text.toLowerCase().replace(MODEL_VERSION_SUFFIX, '').replace(MODEL_TIER_SUFFIX, '').replace(MODEL_PREVIEW_SUFFIX, '');
  return legacyGrouping ? key : key.replace(MODEL_AUTO_MARKER, '');
}

/**
 * 条目展示用的模型本名：去掉供应商后缀和 (Max) 档位标记。
 * 例：`Kimi-K3.1-Pro (Max)` → `Kimi-K3.1-Pro`；`DeepSeek-Flash` → `DeepSeek V4.1 Flash`。
 */
function baseName(row, legacyGrouping = false) {
  const name = modelNameParts(row, {}).base.replace(MODEL_TIER_MARKER, '').trim();
  // 没填名称时 modelNameParts 会退回完整路由 ID，带供应商前缀；ID 里不要出现前缀。
  const text = name.includes('/') ? bareId(row) : name;
  // 目录里个别条目名是占位符（如 “-”）：同样退回裸 ID，避免出现 auto:- 这种没法读的 ID。
  const base = /[a-z0-9]/i.test(text) ? text : bareId(row);
  if (legacyGrouping) return base;
  const clean = base.replace(MODEL_AUTO_MARKER, '');
  return MODEL_NAME_ALIASES.get(clean.toLowerCase().replace(/[\s_]+/g, '-')) ?? clean;
}

function bareId(row) {
  return String(row.id ?? '').replace(/^.*\//, '');
}

/** 可读 ID 用的小写连字符形式；月日快照不算型号差异，一并去掉。 */
function entrySlug(row, legacyGrouping = false) {
  return baseName(row, legacyGrouping).toLowerCase().replace(/[\s_]+/g, '-').replace(MODEL_VERSION_SUFFIX, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * 别名 ID（如 frontier-1 / qmodel_latest）看不出同款，只能靠显示名识别。
 * 带版本号或已确认的具体型号才参与按名合并；search_agent_qwen_fast 这类通用别名同名也不并。
 */
function nameKey(row, legacyGrouping = false) {
  const text = entrySlug(row, legacyGrouping).replace(MODEL_TIER_SUFFIX, '').replace(MODEL_PREVIEW_SUFFIX, '');
  return /\d/.test(text) || (!legacyGrouping && VERSIONLESS_MODEL_NAMES.has(text)) ? text : '';
}

function smallest(members, field) {
  const values = members.map((row) => row[field]).filter(Boolean);
  return values.length ? { [field]: Math.min(...values) } : {};
}

/**
 * 合并条目的思考档位取并集：任一候选声明能用就算可用，DSH 的档位选择器才有选项。
 * 取交集会让部分候选没声明档位时整个条目失去思考深度；都没声明时退回默认三档。
 */
function mergedEfforts(members) {
  const declared = new Set(members.flatMap((row) => row.reasoningEfforts ?? []));
  return declared.size ? REASONING_LEVELS.filter((level) => declared.has(level)) : [...DEFAULT_EFFORTS];
}

/** 组内出现最多的名称作为条目 ID 与展示名，并列时取最先出现的，保证清单顺序变化不影响 ID。 */
function groupSlug(members, legacyGrouping = false) {
  const counts = new Map();
  for (const row of members) {
    const slug = entrySlug(row, legacyGrouping);
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  let best = '', seen = 0;
  for (const [slug, count] of counts) if (count > seen) { best = slug; seen = count; }
  return best;
}

/** 展示名用同组里最干净的写法：优先没用月日快照的成员，再按清单顺序。 */
function groupName(members, slug, legacyGrouping = false) {
  const same = members.filter((row) => entrySlug(row, legacyGrouping) === slug);
  const clean = same.find((row) => !MODEL_VERSION_SUFFIX.test(baseName(row, legacyGrouping))) ?? same[0];
  return baseName(clean, legacyGrouping).replace(/\s+/g, '-');
}

/**
 * 把当前勾选转换成 DSH 的 auto 条目和转发候选。两处共用同一份规划，避免界面列出的能力与实际选路不一致。
 * 组间按第一次出现的位置、组内按清单顺序排列；后者就是无固定记录时的选路优先级。
 *
 * ID 取实际模型名（`auto:kimi-k3.1-pro`），不再用内部别名，方便在 DSH 里对照。
 * 同名但不同款的条目使用候选原始 ID 的哈希后缀：取消、删除或重排另一组都不能让本组复用旧引用。
 * legacyIds 只用于读取本次改动前的 `-2` / `-3` 引用，新写入一律使用稳定后缀。
 * legacyGrouping 只为迁移旧版误拆分的模型引用保留旧分组规则，不用于新写入或请求选路。
 */
export function planAutoRoute(config, { legacyIds = false, legacyGrouping = false } = {}) {
  const groups = [];
  const positions = new Map(config.models.map((row, index) => [row, index]));
  const root = (group) => group?.parent ? root(group.parent) : group;
  // 裸 ID 键和名称键指向同一组：别名 ID 靠名称归组，组内后续成员两个键都要登记。
  const byKey = new Map();
  for (const row of config.models) {
    if (!row.enabled) continue;
    const keys = [routeKey(row.id, { legacyGrouping }), nameKey(row, legacyGrouping)].filter(Boolean);
    const matches = [...new Set(keys.map((key) => root(byKey.get(key))).filter(Boolean))];
    let group = legacyGrouping ? matches[0] : matches.toSorted((a, b) => a.order - b.order)[0];
    if (!group) { group = { members: [], order: groups.length }; groups.push(group); }
    if (!legacyGrouping) for (const other of matches) if (other !== group) {
      // 某一条目可能同时连到“裸 ID 相同”和“名称相同”的两个已有组；合并根节点，避免依赖导入顺序。
      group.members.push(...other.members); other.parent = group;
    }
    group.members.push(row);
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, group);
  }
  const described = groups.filter((group) => !group.parent).map(({ members }) => {
    // 组被关联后仍按原清单顺序选路，不能让合并动作改变出口优先级。
    members.sort((a, b) => positions.get(a) - positions.get(b));
    return { members, slug: groupSlug(members, legacyGrouping) || routeKey(members[0].id, { legacyGrouping }) };
  });
  const slugCounts = new Map();
  for (const { slug } of described) slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  const slugOrdinals = new Map();
  const entries = [], routes = new Map();
  for (const { members, slug } of described) {
    const ordinal = (slugOrdinals.get(slug) ?? 0) + 1;
    slugOrdinals.set(slug, ordinal);
    let id = `${AUTO_PREFIX}${slug}`, tag = '';
    if (legacyIds) {
      // 与旧实现逐字保持一致，供升级时找回已经保存的数字后缀引用。
      for (let n = 2; routes.has(id); n++) { id = `${AUTO_PREFIX}${slug}-${n}`; tag = ` ${n}`; }
    } else {
      if (slugCounts.get(slug) > 1) {
        const ids = members.map((row) => row.id).sort();
        const fingerprint = createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 12);
        id = `${AUTO_PREFIX}${slug}-${fingerprint}`;
        if (ordinal > 1) tag = ` ${ordinal}`;
      }
      // 哈希碰撞或模型名自带相同后缀时仍须保证 ID 唯一；正常模型不会进入这个兜底。
      const base = id;
      for (let n = 2; routes.has(id); n++) id = `${base}-${n}`;
    }
    const entry = {
      id, name: `${groupName(members, slug, legacyGrouping)}${tag}`,
      ...smallest(members, 'contextWindow'), ...smallest(members, 'maxTokens'),
      input: members.some((row) => row.input?.includes('image')) ? ['text', 'image'] : ['text'],
      reasoningEfforts: mergedEfforts(members),
    };
    entries.push(entry);
    routes.set(entry.id, members);
  }
  return { entries, routes };
}
