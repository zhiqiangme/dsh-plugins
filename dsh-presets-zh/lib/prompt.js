import { readFileSync } from 'node:fs'
import { installSubagentIdentity } from './context.js'

const standard = JSON.parse(readFileSync(new URL('./translations/standard.json', import.meta.url), 'utf8'))
const sdkVariants = JSON.parse(readFileSync(new URL('./translations/ptc-sdk.json', import.meta.url), 'utf8'))
const translations = Map.groupBy(standard.entries, entry => entry.name)
const omitted = new Set(standard.omitted)
const PTC_ONLY = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
const SDK_PROGRAM_INTRO = '\n\nInside the program:'

// 宿主依据运行语法和 Bash schema 是否要求 description 生成示例。
const sdkBashExamples = ['', "description: 'Show current directory', "].flatMap(description => {
  const call = `await tools.bash({ ${description}command: 'pwd' })`
  return [`return ${call}`, `console.log(${call})`].map(code => {
    const example = `\`run_code({ code: "${code}", description: "Show current directory" })\``
    return {
      original: ' When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:\n\n' + example,
      translated: '\n没有单独的 bash 工具 schema 时，可在 run_code 内调用已声明的 bash 绑定。\n\n' + example,
    }
  })
})

export const name = 'presets-zh-translation'

function translateSdk(text) {
  const introEnd = text.indexOf(SDK_PROGRAM_INTRO)
  const example = introEnd < 0 ? undefined : sdkBashExamples.find(({ original }) => text.slice(0, introEnd).endsWith(original))
  const original = example ? text.slice(0, introEnd - example.original.length) + text.slice(introEnd) : text
  const variant = sdkVariants.find(item => original.startsWith(item.original))
  if (!variant) return
  const explanation = example
    ? variant.translated.replace('\n\n在程序内部：', example.translated + '\n\n在程序内部：')
    : variant.translated
  return explanation + original.slice(variant.original.length)
}

/** 只替换命名及原文均匹配的框架说明；未知格式、用户内容和动态工具声明保留。 */
export function transformAssembly(assembly, { ptc = false } = {}) {
  return { ...assembly, sections: assembly.sections.flatMap(section => {
    if (omitted.has(section.name)) return []
    let translated = translations.get(section.name)?.find(entry => entry.original === section.text)?.translated
    if (ptc && section.name === 'tools:ptc-only' && section.text === PTC_ONLY) {
      translated = 'run_code 是唯一可以直接调用的工具；直接调用其他工具会失败。请在程序内部通过下方 SDK 调用已声明的工具。'
    }
    if (ptc && section.name === 'tools:sdk') {
      // SDK 声明随当前工具集动态生成，只替换已知说明前缀，保留完整类型及注释。
      translated = translateSdk(section.text)
    }
    return [{ ...section, ...(translated === undefined ? {} : { text: translated, interpolate: false }) }]
  }) }
}

export function apply(ctx, config = {}) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => transformAssembly(await next(), config))
  installSubagentIdentity(ctx)
}
