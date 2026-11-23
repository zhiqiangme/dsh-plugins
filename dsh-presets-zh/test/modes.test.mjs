import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../lib/config.js'
import { MODES, configuredModes } from '../lib/modes.js'
import { apply } from '../lib/index.js'
import { transformAssembly } from '../lib/prompt.js'

const row = (preset, id) => preset.plugins.find(plugin => plugin.id === id)
const mode = (modes, key) => modes.find(item => item.key === key)
const data = file => JSON.parse(readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8'))

test('四组设置均使用宿主可编辑引用，空配置默认全部启用且不改变内部 id', () => {
  const config = Config({})
  assert.deepEqual(MODES.map(mode => mode.key), ['standard', 'ptc', 'minimal', 'creation'])
  assert.deepEqual(configuredModes(config).map(mode => mode.definition.id), ['standard-zh', 'ptc-zh', 'minimal-zh', 'cordis-zh'])
  for (const { key } of MODES) {
    assert.equal(Config.dict[key].meta.volatile, true)
    assert.equal(config[key].get().enabled, true)
  }
})

test('预设列表按 order 排序，order 与设置页顺序一致且排在旧极简提示词之后', () => {
  // 宿主 Agent 预设页按 order 升序、再按 id 排序，注册顺序不影响显示。
  const orders = configuredModes().map(mode => mode.definition.order)
  assert.deepEqual(orders, [6, 7, 8, 9])
})

test('提示词、名称和开关独立配置，副本修改不会污染快照或其他模式', () => {
  const options = { standard: { name: '工作模式', prompt: '遵循项目规范。', enabled: false }, creation: { description: '' } }
  const modes = configuredModes(Config(options))
  const standard = mode(modes, 'standard')
  assert.equal(standard.enabled, false)
  assert.equal(standard.definition.name, '工作模式')
  assert.equal(row(standard.definition, 'persona').config.prefix, '遵循项目规范。')
  assert.equal(mode(modes, 'creation').definition.description, '')
  mode(modes, 'minimal').definition.plugins.length = 0
  assert.ok(mode(configuredModes(), 'minimal').definition.plugins.length > 0)
  assert.equal(mode(configuredModes(), 'standard').definition.name, '中文标准')
})

test('三种完整模式保留规划规则、平台判断及完整提示词，PTC 和创造能力独立', () => {
  for (const { definition } of MODES.filter(item => item.key !== 'minimal')) {
    assert.equal(row(definition, 'persona').config.complete, false)
    assert.equal(row(definition, 'persona').config.includeRuntimeContext, false)
    assert.match(row(definition, 'planning').config[0].config.section, /审批渠道不可用或中止/)
    assert.deepEqual(row(definition, 'tool-bash').disabled, { __jsExpr: "process.platform === 'win32'" })
    assert.deepEqual(row(definition, 'tool-pwsh').disabled, { __jsExpr: "process.platform !== 'win32'" })
    assert.equal(JSON.stringify(definition).includes('file:///'), false)
    assert.equal(JSON.stringify(definition).includes('C:/Users/'), false)
  }
  const ptc = mode(MODES, 'ptc').definition
  assert.ok(ptc.plugins.some(plugin => plugin.name === '@deepseek-ai/dsh-agent-tool-presentation' && plugin.config.mode === 'ptc'))
  for (const id of ['workflow-ptc', 'tool-workflow']) assert.equal(row(ptc, 'delegation').config.find(plugin => plugin.id === id).disabled, true)
  const creation = mode(MODES, 'creation').definition
  assert.equal(row(creation, 'tool-cordis').name, '@deepseek-ai/dsh-tool-cordis')
  assert.match(row(creation, 'skill-filesystem').config.customSkillDirs[0].__jsExpr, /resolve\('@deepseek-ai\/dsh-agent-preset\/package.json'\)/)
  for (const id of ['tool-plugin-manager', 'tool-plugin-market']) assert.deepEqual(row(creation, id).disabled, { __jsExpr: "!ctx.get('profileContext')" })
})

test('完整模式适配 DSH 0.2.2 的子代理控制入口与模型发现配置', () => {
  for (const { definition } of MODES.filter(item => item.key !== 'minimal')) {
    const delegation = row(definition, 'delegation').config
    // list_agents 已由控制插件统一注册；旧子路径不再导出，会导致整个预设加载失败。
    assert.deepEqual(delegation.filter(plugin => plugin.name.startsWith('@deepseek-ai/dsh-tool-subagent-control')).map(plugin => plugin.name), ['@deepseek-ai/dsh-tool-subagent-control'])
    assert.equal(delegation.find(plugin => plugin.id === 'tool-subagent-control').config.interrupt, false)
    assert.deepEqual(delegation.find(plugin => plugin.id === 'tool-subagent').config, {
      provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true,
    })
    assert.deepEqual(delegation.find(plugin => plugin.id === 'tool-subagent-fork').config, {
      provider: 'fork', toolName: 'subagent_fork',
    })
  }
})

test('新版宿主加载原生 PTC 和 Office 工具，旧宿主沿用兼容配置', async () => {
  const fake = host()
  const packages = new Set(['@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-tool-office'])
  fake.ctx.baseUrl = 'file:///profile/'
  fake.ctx.get = name => name === 'pluginPackages' ? {
    packageOf: (pkg, base) => {
      assert.equal(base, fake.ctx.baseUrl)
      return packages.has(pkg) ? {} : undefined
    },
  } : undefined
  await apply(fake.ctx)
  for (const id of ['standard-zh', 'ptc-zh', 'cordis-zh', 'minimal-zh']) {
    assert.equal(Boolean(row(fake.records.get(id), 'tool-office')), ['standard-zh', 'ptc-zh'].includes(id))
  }
  const ptc = fake.records.get('ptc-zh')
  assert.equal(row(ptc, 'tool-executor-ptc').name, '@deepseek-ai/dsh-tool-executor-ptc')
  assert.equal(row(ptc, 'tool-presentation'), undefined)
  await fake.cleanup()

  const legacyPtc = mode(configuredModes(), 'ptc').definition
  assert.equal(row(legacyPtc, 'tool-presentation').config.mode, 'ptc')
  assert.equal(row(legacyPtc, 'tool-office'), undefined)
  assert.equal(row(legacyPtc, 'tool-executor-ptc'), undefined)
})

test('汉化命中精确原文；省略指定宿主段落，未知说明、属性及其他内容原样保留', () => {
  const dictionary = data('translations/standard.json')
  const sections = dictionary.entries.map(entry => ({ name: entry.name, text: entry.original, priority: 37, interpolate: true }))
  const unknown = { name: sections[0].name, text: 'upstream changed; keep DSH and original text', extra: { kept: true } }
  const assembly = { tools: [{ name: 'original-tool' }], sections: [...sections, unknown, ...dictionary.omitted.map(name => ({ name, text: 'optional host information' }))] }
  const translated = transformAssembly(assembly)
  assert.equal(translated.tools, assembly.tools)
  assert.equal(translated.sections.length, sections.length + 1)
  for (const [index, entry] of dictionary.entries.entries()) {
    assert.equal(translated.sections[index].text, entry.translated)
    assert.equal(translated.sections[index].priority, 37)
    assert.equal(translated.sections[index].interpolate, false)
  }
  assert.deepEqual(translated.sections.at(-1), unknown)
  assert.deepEqual(transformAssembly(translated), translated)
  assert.equal(assembly.sections[0].text, dictionary.entries[0].original)
})

test('PTC 的 TypeScript 和 Python SDK 说明汉化，动态工具声明逐字保留', () => {
  const declarations = '```typescript\n/** Keep DSH user descriptions */\ndeclare const tools: { example(args: {path: string}): Promise<string> };\n```'
  for (const variant of data('translations/ptc-sdk.json')) {
    const input = { sections: [{ name: 'tools:sdk', text: variant.original + declarations }] }
    assert.equal(transformAssembly(input, { ptc: true }).sections[0].text, variant.translated + declarations)
    assert.equal(transformAssembly(input).sections[0].text, input.sections[0].text)
  }
  const unknown = { sections: [{ name: 'tools:sdk', text: 'new format ' + declarations }] }
  assert.deepEqual(transformAssembly(unknown, { ptc: true }), unknown)
})

test('PTC 汉化 Bash 示例的说明并保留调用代码及 SDK 声明', () => {
  const variant = data('translations/ptc-sdk.json')[0]
  const intro = ' When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:\n\n'
  const declarations = '```ts\ndeclare const tools: { bash(args: unknown): Promise<unknown> };\n```'
  const translate = section => transformAssembly({ sections: [section] }, { ptc: true }).sections[0]
  for (const code of [
    "inspect(await tools.bash({ description: 'Show current directory', command: 'pwd' }))",
    "inspect(await tools.bash({ command: 'pwd' }))",
    "return await tools.bash({ description: 'Show current directory', command: 'pwd' })",
  ]) {
    const example = `\`run_code({ code: "${code}", description: "Show current directory" })\``
    const text = variant.original.replace('\n\nInside the program:', intro + example + '\n\nInside the program:') + declarations
    const section = { name: 'tools:sdk', text }
    const localized = translate(section)
    assert.match(localized.text, /没有单独的 bash 工具 schema/)
    assert.ok(localized.text.includes(example))
    assert.ok(localized.text.endsWith(declarations))
    const unknown = { ...section, text: text.replace('pwd', 'ls') }
    assert.deepEqual(translate(unknown), unknown)
  }
})

test('同步 DSH 0.2.3 的 Timeline 语言规则、子智能体并发上限、CUA 指引与预设配置', () => {
  const timelineBase = data('translations/standard.json').entries.find(entry => entry.name === 'timeline:planning' && entry.original.startsWith('## Task planning with Timeline')).original
  const timelineText = `${timelineBase}\n\nFor Timeline task-tree content only, write titles, descriptions, progress notes, results, and discussion replies in 简体中文. Follow the user's language instructions for all other work and conversation.`
  const subagentText = 'Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. The concurrency limit of all the subagents is 8. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.\n\nBash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.'
  const cuaText = [
    'Windows: accessibility tree operations are available only at window level. Simulated mouse and keyboard input are available at window level. Supported modifiers: ctrl, alt, shift, win. control is an alias for ctrl. Key and mouse holds use desktop input. Keep the target in front while holding inputs. Release through the same window. After focus changes, an up releases desktop input without restoring focus; the original window may not receive that event.',
    '',
    'Use cua to observe and operate native applications. Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions. All methods are async. Actions report dispatch evidence, not verified completion. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI actions and ask the user to unlock the desktop session; null or unknown means verify a usable unlocked desktop session first. cua.getApp requests user consent; if access is denied or revoked, stop using that application until the user explicitly permits another request, and never bypass a refusal or switch tools to avoid it. Never replay uncertain input without a fresh observation.',
    '',
    '- click(target: string | [number, number], options?: { mouseButton?: \'left\' | \'right\' | \'middle\', clickCount?: 1 | 2, modifiers?: Modifier[], holdMs?: number, relative?: boolean, useSystemInput?: boolean }) -> ActionResult — click an element id or point, or perform a left-button double-click; holdMs controls the press duration of each press.',
    '- unknownFutureMethod() -> void — keep unknown descriptions verbatim.',
    '',
    'AX read defaults: maxElements=500, maxDepth=12.',
    '',
    'Maximum click holdMs: 5000 ms.',
  ].join('\n')

  const result = transformAssembly({
    sections: [
      { name: 'timeline:planning', text: timelineText },
      { name: 'tool:subagent', text: subagentText },
      { name: 'computer-use:dsh-cua', text: cuaText },
    ],
  })
  assert.match(result.sections[0].text, /## 使用 Timeline 规划任务/)
  assert.match(result.sections[0].text, /使用 简体中文 撰写/)
  assert.match(result.sections[1].text, /通过 subagent 或 subagent_fork 一起启动/)
  assert.match(result.sections[1].text, /所有子智能体的并发上限为 8/)
  assert.match(result.sections[2].text, /Windows：无障碍树操作/)
  assert.match(result.sections[2].text, /useSystemInput\?: boolean \}\) -> ActionResult — 点击元素 ID 或坐标点/)
  assert.match(result.sections[2].text, /- unknownFutureMethod\(\) -> void — keep unknown descriptions verbatim\./)
  assert.match(result.sections[2].text, /无障碍树读取默认值：maxElements=500，maxDepth=12。/)
  assert.match(result.sections[2].text, /点击按住时长（holdMs）上限：5000 ms。/)
  assert.deepEqual(transformAssembly(result), result)

  for (const key of ['standard', 'ptc', 'creation']) {
    const preset = mode(MODES, key).definition
    assert.deepEqual(row(preset, 'tool-fs').config, { applyPatch: false })
    assert.match(row(preset, 'skill-filesystem').config.customSkillDirs[0].__jsExpr, /resolve\('@deepseek-ai\/dsh-agent-preset\/package.json'\)/)
    assert.deepEqual(row(preset, 'tool-plugin-manager').disabled, { __jsExpr: "!ctx.get('profileContext')" })
  }
  assert.equal(row(mode(MODES, 'standard').definition, 'tool-cordis').name, '@deepseek-ai/dsh-tool-cordis')
  assert.deepEqual(row(mode(MODES, 'creation').definition, 'tool-skill').config.excludedSkills, ['official-plugins', 'personalized-pages'])
})

function host() {
  const records = new Map()
  const registered = []
  const disposed = []
  const hooks = new Map()
  let cleanup
  return {
    records, registered, disposed, hooks,
    cleanup: () => cleanup(),
    ctx: {
      loader: { entries: () => [] },
      effect: callback => { cleanup = callback() },
      on: (event, callback) => hooks.set(event, callback),
      agentPresets: {
        list: async () => [...records.values()],
        register: async definition => {
          assert.equal(records.has(definition.id), false, '每次注册必须先释放旧定义')
          records.set(definition.id, definition)
          registered.push(definition.id)
          return async () => { records.delete(definition.id); disposed.push(definition.id) }
        },
      },
    },
  }
}

test('保存开关和提示词只更新对应模式，其他模式不重注册，卸载时全部释放', async () => {
  const fake = host()
  const config = Config({})
  await apply(fake.ctx, config)
  const updated = Config({ standard: { enabled: false }, ptc: { name: '批量处理', prompt: '请完成批量任务。' } })
  updateVolatile(config.standard, updated.standard)
  updateVolatile(config.ptc, updated.ptc)
  await fake.hooks.get('loader/volatile-update')()
  assert.equal(fake.records.has('standard-zh'), false)
  assert.equal(fake.records.get('ptc-zh').name, '批量处理')
  assert.equal(row(fake.records.get('ptc-zh'), 'persona').config.prefix, '请完成批量任务。')
  assert.deepEqual(fake.registered, ['standard-zh', 'ptc-zh', 'minimal-zh', 'cordis-zh', 'ptc-zh'])
  updateVolatile(config.standard, Config({}).standard)
  await fake.hooks.get('loader/volatile-update')()
  assert.equal(fake.records.has('standard-zh'), true)
  await fake.cleanup()
  assert.equal(fake.records.size, 0)
})

test('同 id 外部声明只占用该模式，不阻止其他三个模式注册', async () => {
  const fake = host()
  fake.ctx.loader.entries = () => [{ options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'ptc-zh' } } }]
  await apply(fake.ctx)
  assert.deepEqual(fake.registered, ['standard-zh', 'minimal-zh', 'cordis-zh'])
  await fake.cleanup()
})
