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
  return name.replace(/^deepseek[\s_-]+(?:v4\.1[\s_-]+)?flash(?=$|[\s(_-])/i, 'DeepSeek V4.1 Flash');
}

/** 只派生展示名称，手工名称和完整路由 ID 仍原样保存；未知供应商及路由组不乱加标签。 */
export function displayModelName(row, providers = PROVIDER_NAMES) {
  const name = normalizeDisplayName(row.name || row.id || '');
  const provider = row.id?.includes('/') ? row.id.split('/')[0] : '';
  const supplier = Object.hasOwn(providers, provider) ? providers[provider] : undefined;
  return !supplier || name.toLowerCase() === supplier.toLowerCase() || name.toLowerCase().endsWith(` ${supplier.toLowerCase()}`)
    ? name : `${name} ${supplier}`;
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
