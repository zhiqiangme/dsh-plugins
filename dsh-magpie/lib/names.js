// Magpie 的 workbuddy-ai 是国际版，workbuddy 是国内版；按路由 ID 识别，不能从模型名猜供应商。
export const PROVIDER_NAMES = Object.freeze({
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy GL',
  'opencode-zen-free': 'OpenCode',
  'qoder-cn': 'Qoder',
  qoder: 'Qoder GL',
  'trae-cn': 'Trae',
  'trae-global': 'Trae GL',
  zcode: 'ZCode',
  'mimo-app': 'MiMo',
  'commandcode-plan': 'CommandCode',
  cline: 'Cline',
  codex: 'Codex',
});

function normalizeDisplayName(name) {
  // 上游的 DeepSeek-Flash 与 V4.1 Flash 别名统一展示，保留 Free、Max 等尾缀及原始配置。
  // 展示默认不出现中文：中文“预览版”统一显示为 Preview（含括号写法），保存的名称不变。
  return name.replace(/^deepseek[\s_-]+(?:v4\.1[\s_-]+)?flash(?=$|[\s(_-])/i, 'DeepSeek V4.1 Flash')
    .replace(/\s*[（(]?\s*预览版\s*[)）]?/g, ' Preview').trim();
}

/** 拆出模型本名与供应商后缀；名称里已带后缀时不重复追加。 */
function modelNameParts(row, providers = PROVIDER_NAMES) {
  const name = normalizeDisplayName(row.name || row.id || '');
  const provider = row.id?.includes('/') ? row.id.split('/')[0] : '';
  const supplier = Object.hasOwn(providers, provider) ? providers[provider] : undefined;
  if (!supplier) return { base: name, suffix: '' };
  const lower = name.toLowerCase(), tag = supplier.toLowerCase();
  if (lower === tag) return { base: '', suffix: supplier };
  if (lower.endsWith(` ${tag}`)) return { base: name.slice(0, name.length - supplier.length - 1), suffix: supplier };
  return { base: name, suffix: supplier };
}

/** 只派生展示名称，手工名称和完整路由 ID 仍原样保存；未知供应商及路由组不乱加标签。 */
export function displayModelName(row, providers = PROVIDER_NAMES) {
  const { base, suffix } = modelNameParts(row, providers);
  return base ? (suffix ? `${base} ${suffix}` : base) : suffix;
}

/** DSH 模型列表用的名字：模型本名内空格换 -，与 Auto / 供应商后缀之间保留空格。 */
export function dshModelName(row, providers = PROVIDER_NAMES) {
  const { base, suffix } = modelNameParts(row, providers);
  return [base.replace(/\s+/g, '-'), suffix].filter(Boolean).join(' ');
}

/**
 * 与卡片「按模型排序 / 按供应商排序」相同的排序（client.js 的同名函数，两处需保持一致）：
 * 名称取 ID 后段并去掉已带的供应商后缀，忽略大小写、数字按自然顺序，同键保持原顺序，空名称排后。
 * 返回原数组下标的新顺序。
 */
export function sortModelIndexes(rows, mode = 'model', providers = PROVIDER_NAMES) {
  const collator = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' });
  const compare = (a, b) => a && b ? collator.compare(a, b) : a ? -1 : b ? 1 : 0;
  const keys = rows.map((row, index) => {
    const slash = row.id.indexOf('/');
    const provider = slash > 0 ? row.id.slice(0, slash) : '';
    const supplier = Object.hasOwn(providers, provider) ? providers[provider] : provider;
    let name = (row.name || row.id).trim();
    if (name === row.id && slash > 0) name = row.id.slice(slash + 1);
    if (supplier && name.toLowerCase().endsWith(` ${supplier.toLowerCase()}`)) name = name.slice(0, -supplier.length - 1).trimEnd();
    return { index, name: normalizeDisplayName(name), supplier };
  });
  return keys.sort((a, b) => mode === 'provider'
    ? compare(a.supplier, b.supplier) || compare(a.name, b.name) || a.index - b.index
    : compare(a.name, b.name) || compare(a.supplier, b.supplier) || a.index - b.index).map(({ index }) => index);
}

/**
 * 用户手动排过序时，全量同步保留原有顺序：已在清单中的模型按原位置排列，
 * 新出现的模型按模型名称排序后接在末尾。返回 rows 下标的新顺序。
 */
export function keepOrderIndexes(rows, previousIds, providers = PROVIDER_NAMES) {
  const position = new Map();
  previousIds.forEach((id, index) => { if (typeof id === 'string' && !position.has(id.trim())) position.set(id.trim(), index); });
  const indexes = rows.map((_row, index) => index);
  const known = indexes.filter((i) => position.has(rows[i].id)).sort((a, b) => position.get(rows[a].id) - position.get(rows[b].id));
  const fresh = indexes.filter((i) => !position.has(rows[i].id));
  return [...known, ...sortModelIndexes(fresh.map((i) => rows[i]), 'model', providers).map((j) => fresh[j])];
}
