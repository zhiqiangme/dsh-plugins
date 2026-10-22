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
