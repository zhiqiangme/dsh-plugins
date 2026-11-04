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
  return models.filter((model) => {
    const price = creditValue(model.credits);
    return (!rules.freeOnly || price === 0) && (!rules.visionOnly || model.supports_images === true) &&
      (rules.maxCredits === null || (price !== null && price <= rules.maxCredits));
  });
}

/**
 * 按「DSH 中的顺序」规则排序，`upstream` 保持传入顺序。
 *
 * 键必须与面板的 filterRows（client.js）相同：名称比展示名而不是上游原名，倍率比价格且未知价格排最后。
 * 面板是这个顺序的预览，任一边换键，DSH 的顺序就和用户看到的对不上。
 *
 * @param {object[]} list 待排序的模型或条目
 * @param {unknown} raw 规则
 * @param {{ label: (item: object) => string, credits: (item: object) => unknown }} keys
 */
export function sortByRule(list, raw, { label, credits }) {
  const { sort } = normalizeModelRules(raw);
  const sorted = [...list];
  if (sort === 'name') sorted.sort((a, b) => label(a).localeCompare(label(b)));
  if (sort === 'credits') sorted.sort((a, b) => (creditValue(credits(a)) ?? Infinity) - (creditValue(credits(b)) ?? Infinity));
  return sorted;
}
