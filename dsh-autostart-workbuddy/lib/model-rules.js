/** 缺失或未知价格不能当作免费，避免规则把尚未定价的模型自动加入。 */
export function creditValue(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'free') return 0;
  if (typeof value === 'string' && /^x?\d+(?:\.\d+)?$/i.test(value.trim())) value = Number(value.trim().replace(/^x/i, ''));
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeModelRules(raw) {
  const rules = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    freeOnly: rules.freeOnly === true,
    visionOnly: rules.visionOnly === true,
    maxCredits: creditValue(rules.maxCredits),
    sort: ['name', 'credits'].includes(rules.sort) ? rules.sort : 'upstream',
  };
}

export function hasModelRules(raw) {
  const rules = normalizeModelRules(raw);
  return rules.freeOnly || rules.visionOnly || rules.maxCredits !== null;
}

export function applyModelRules(models, raw) {
  const rules = normalizeModelRules(raw);
  const list = models.filter((model) => {
    const price = creditValue(model.credits);
    return (!rules.freeOnly || price === 0) && (!rules.visionOnly || model.supports_images === true) &&
      (rules.maxCredits === null || (price !== null && price <= rules.maxCredits));
  });
  if (rules.sort === 'name') list.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  if (rules.sort === 'credits') list.sort((a, b) => (creditValue(a.credits) ?? Infinity) - (creditValue(b.credits) ?? Infinity));
  return list;
}
