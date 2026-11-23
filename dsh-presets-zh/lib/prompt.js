import { readFileSync } from 'node:fs'
import { installSubagentIdentity } from './context.js'

const standard = JSON.parse(readFileSync(new URL('./translations/standard.json', import.meta.url), 'utf8'))
const sdkVariants = JSON.parse(readFileSync(new URL('./translations/ptc-sdk.json', import.meta.url), 'utf8'))
const cuaDictionary = JSON.parse(readFileSync(new URL('./translations/cua.json', import.meta.url), 'utf8'))
const translations = Map.groupBy(standard.entries, entry => entry.name)
const omitted = new Set(standard.omitted)
const PTC_ONLY = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
const SDK_PROGRAM_INTRO = '\n\nInside the program:'

// 宿主依据运行语法（0.2.3 起为 inspect(...)，旧版为 return / console.log）和 Bash schema 是否要求 description 生成示例。
const sdkBashExamples = ['', "description: 'Show current directory', "].flatMap(description => {
  const call = `await tools.bash({ ${description}command: 'pwd' })`
  return [`inspect(${call})`, `return ${call}`, `console.log(${call})`].map(code => {
    const example = `\`run_code({ code: "${code}", description: "Show current directory" })\``
    return {
      original: ' When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:\n\n' + example,
      translated: '\n没有单独的 bash 工具 schema 时，可在 run_code 内调用已声明的 bash 绑定。\n\n' + example,
    }
  })
})

const TIMELINE_LANG_SUFFIX = /\n\nFor Timeline task-tree content only, write titles, descriptions, progress notes, results, and discussion replies in ([^.\n]+)\. Follow the user's language instructions for all other work and conversation\.$/

// DSH 0.2.3 起在子智能体说明中动态插入当前配置的并发上限（maxActiveSubagents）。
const SUBAGENT_CONCURRENCY_PATTERN = /^Start independent delegations with (`[a-z0-9_]+`(?: or `[a-z0-9_]+`)*) together in one assistant message and continue useful work while they run\. The concurrency limit of all the subagents is (\d+)\. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn\. Collect the subagent results required to complete the task before giving the user a final answer\.\n\nBash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly\. The agent integrating the work must review the final diff and run relevant tests\.$/

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

function translateTimelinePlanning(text) {
  const match = TIMELINE_LANG_SUFFIX.exec(text)
  if (!match) return
  const base = text.slice(0, match.index)
  const entry = translations.get('timeline:planning')?.find(item => item.original === base)
  if (!entry) return
  return `${entry.translated}\n\n仅对 Timeline 任务树内容（标题、描述、进度备注、结果和讨论回复），使用 ${match[1]} 撰写。其他工作和对话遵循用户的语言要求。`
}

function translateSubagent(text) {
  const match = SUBAGENT_CONCURRENCY_PATTERN.exec(text)
  if (!match) return
  const names = match[1].replaceAll('`', '').replaceAll(' or ', ' 或 ')
  return `将互相独立的委派在同一条助手消息中通过 ${names} 一起启动。等待期间继续处理可独立开展的工作。所有子智能体的并发上限为 ${match[2]}。只剩等待结果时，结束当前轮次，下一条结果会开启新轮次。给用户最终答复前，收齐完成任务所需的子智能体结果。\n\nBash、格式化器、代码生成器和脚本可能覆盖并行修改而无法检测冲突，须事先协调。负责合并工作的智能体应审查最终差异并运行相关测试。`
}

/** 逐行精确汉化 CUA 指南：方法签名、参数类型与未知行原样保留，避免破坏 API 调用。 */
function translateCuaGuidance(text) {
  let changed = false
  const lines = text.split('\n').map(line => {
    const mapped = cuaDictionary.lines[line]
    if (mapped !== undefined) {
      changed = true
      return mapped
    }
    if (line.startsWith('- ')) {
      const sep = line.indexOf(' — ')
      if (sep > 2) {
        const desc = line.slice(sep + 3)
        const translatedDesc = cuaDictionary.descriptions[desc]
        if (translatedDesc !== undefined) {
          changed = true
          return `${line.slice(0, sep)} — ${translatedDesc}`
        }
      }
    }
    const axDefaults = /^AX read defaults: maxElements=(\d+), maxDepth=(\d+)\.$/.exec(line)
    if (axDefaults) {
      changed = true
      return `无障碍树读取默认值：maxElements=${axDefaults[1]}，maxDepth=${axDefaults[2]}。`
    }
    const maxHold = /^Maximum click holdMs: (\d+) ms\.$/.exec(line)
    if (maxHold) {
      changed = true
      return `点击按住时长（holdMs）上限：${maxHold[1]} ms。`
    }
    return line
  })
  return changed ? lines.join('\n') : undefined
}

/** 只替换命名及原文均匹配的框架说明；未知格式、用户内容和动态工具声明保留。 */
export function transformAssembly(assembly, { ptc = false } = {}) {
  return { ...assembly, sections: assembly.sections.flatMap(section => {
    if (omitted.has(section.name)) return []
    let translated = translations.get(section.name)?.find(entry => entry.original === section.text)?.translated
    if (translated === undefined && section.name === 'timeline:planning') {
      translated = translateTimelinePlanning(section.text)
    }
    if (translated === undefined && (section.name === 'tool:subagent' || section.name === 'tool:subagent_fork')) {
      translated = translateSubagent(section.text)
    }
    if (translated === undefined && section.name === 'computer-use:dsh-cua') {
      translated = translateCuaGuidance(section.text)
    }
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
