import { readFileSync } from 'node:fs'

const standard = JSON.parse(readFileSync(new URL('./translations/standard.json', import.meta.url), 'utf8'))
const sdkVariants = JSON.parse(readFileSync(new URL('./translations/ptc-sdk.json', import.meta.url), 'utf8'))
const translations = new Map(standard.entries.map(entry => [entry.name, entry]))
const omitted = new Set(standard.omitted)
const PTC_ONLY = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'

export const name = 'presets-zh-translation'

/** 只替换命名及原文均匹配的框架说明；未知格式、用户内容和动态工具声明保留。 */
export function transformAssembly(assembly, { ptc = false } = {}) {
  return { ...assembly, sections: assembly.sections.flatMap(section => {
    if (omitted.has(section.name)) return []
    const entry = translations.get(section.name)
    let translated
    if (entry && section.text === entry.original) translated = entry.translated
    if (ptc && section.name === 'tools:ptc-only' && section.text === PTC_ONLY) {
      translated = 'run_code 是唯一可以直接调用的工具；直接调用其他工具会失败。请在程序内部通过下方 SDK 调用已声明的工具。'
    }
    if (ptc && section.name === 'tools:sdk') {
      const variant = sdkVariants.find(item => section.text.startsWith(item.original))
      // SDK 声明随当前工具集动态生成，只替换已知说明前缀，保留完整类型及注释。
      if (variant) translated = variant.translated + section.text.slice(variant.original.length)
    }
    return [{ ...section, ...(translated === undefined ? {} : { text: translated, interpolate: false }) }]
  }) }
}

export function apply(ctx, config = {}) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => transformAssembly(await next(), config))
}
