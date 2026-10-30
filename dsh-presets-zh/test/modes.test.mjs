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

test('PTC 两种 SDK 前缀汉化且动态工具声明逐字保留，普通模式不误改 SDK', () => {
  const declarations = '```typescript\n/** Keep DSH user descriptions */\ndeclare const tools: { example(args: {path: string}): Promise<string> };\n```'
  for (const variant of data('translations/ptc-sdk.json')) {
    const input = { sections: [{ name: 'tools:sdk', text: variant.original + declarations }] }
    assert.equal(transformAssembly(input, { ptc: true }).sections[0].text, variant.translated + declarations)
    assert.equal(transformAssembly(input).sections[0].text, input.sections[0].text)
  }
  const unknown = { sections: [{ name: 'tools:sdk', text: 'new format ' + declarations }] }
  assert.deepEqual(transformAssembly(unknown, { ptc: true }), unknown)
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
