import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRESET } from '../lib/preset.js'
import { apply, inject, name } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const row = (id) => PRESET.plugins.find((plugin) => plugin.id === id)

test('预设元数据与极简模式系统提示词', () => {
  assert.equal(PRESET.id, 'minimal-prompt')
  assert.equal(PRESET.name, '极简提示词')
  assert.equal(PRESET.order, 5)
  assert.equal(PRESET.description.includes('AGENTS.md'), true)
  assert.equal(PRESET.description.includes('Skills'), true)

  const persona = row('persona')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.prefix, 'You are a helpful software engineer assistant.')
  assert.equal(persona.config.complete, true)
  // 不写 includeRuntimeContext，沿用默认 true：时间与运行上下文和标准模式一致。
  assert.equal('includeRuntimeContext' in persona.config, false)
})

test('保留标准模式的工具、AGENTS.md、Skills 和上下文插件行', () => {
  const ids = PRESET.plugins.map((plugin) => plugin.id)
  assert.deepEqual(ids, [
    'persona',
    'agent-instructions',
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'tool-schedule',
    'skill-filesystem',
    'tool-skill',
    'command-goal',
    'tool-goal',
    'planning',
    'compaction',
    'delegation',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
    'tool-plugin-manager',
    'tool-plugin-market',
  ])

  for (const id of ['agent-instructions', 'time-context', 'skill-filesystem', 'tool-skill']) {
    assert.ok(ids.includes(id), `缺少 ${id}`)
  }
  assert.equal(row('agent-instructions').config.maxBytes, 65536)
  assert.equal(row('tool-fs-search').config.sampleOverCapGlobResults, false)
  assert.equal(row('tool-web').config.fetch, true)
  assert.equal(row('tool-todo').config.allowParallelInProgress, true)
})

test('平台相关的 shell 行在加载时求值，插件管理工具保持禁用', () => {
  assert.equal(row('tool-bash').disabled, process.platform === 'win32')
  assert.equal(row('tool-pwsh').disabled, process.platform !== 'win32')
  assert.equal(row('tool-plugin-manager').disabled, true)
  assert.equal(row('tool-plugin-market').disabled, true)
})

test('planning / compaction / delegation 分组配置完整', () => {
  const planning = row('planning')
  assert.equal(planning.name, 'cordis:group')
  assert.equal(planning.group, true)
  assert.equal(planning.isolate.planMode, true)
  assert.equal(planning.config[0].id, 'plan-mode')
  assert.match(planning.config[0].config.section, /You are in plan mode/)

  const compaction = row('compaction')
  assert.equal(compaction.isolate.compaction, true)
  assert.equal(compaction.isolate.toolResultPruner, true)
  assert.deepEqual(compaction.config.map((plugin) => plugin.id), [
    'compaction-basic',
    'command-compact',
    'tool-result-pruner',
  ])

  const delegation = row('delegation')
  assert.equal(delegation.isolate.workflowEngine, true)
  assert.ok(delegation.config.some((plugin) => plugin.id === 'tool-workflow'))
  assert.ok(delegation.config.some((plugin) => plugin.id === 'tool-subagent-fork'))
})

test('bundle patch 只挂载插件自身，预设由代码注册', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: dsh-preset-minimal-prompt\n\s+name: '@zhiqiangme\/dsh-preset-minimal-prompt'/)
  assert.doesNotMatch(patch, /^\s+name:\s*['"]@deepseek-ai\/dsh-agent-preset/m)
})

test('package.json 声明 bundle patch 与发布所需入口', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@zhiqiangme/dsh-preset-minimal-prompt')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(existsSync(join(root, manifest.main)), true)
  assert.equal(existsSync(join(root, manifest.icon)), true)
})

test('插件导出名与注入服务', () => {
  assert.equal(name, 'dsh-preset-minimal-prompt')
  assert.deepEqual(inject, ['agentPresets', 'loader'])
})

function fakeContext({ entries = [], presets = [], loader = true } = {}) {
  const registered = []
  const disposers = []
  const effects = []
  return {
    registered,
    disposers,
    effects,
    ctx: {
      logger: { info() {} },
      effect(callback) {
        effects.push(callback)
      },
      ...(loader ? { loader: { entries: () => entries } } : {}),
      agentPresets: {
        list: async () => presets,
        register: async (definition) => {
          registered.push(definition)
          return async () => disposers.push(definition.id)
        },
      },
    },
  }
}

test('没有现成声明时自动注册，并在卸载时释放', async () => {
  const fake = fakeContext()
  await apply(fake.ctx)
  assert.deepEqual(fake.registered, [PRESET])
  assert.equal(fake.effects.length, 1)
  const disposer = fake.effects[0]()
  await disposer()
  assert.deepEqual(fake.disposers, ['minimal-prompt'])
})

test('profile 已有同名声明时跳过注册', async () => {
  const fake = fakeContext({
    entries: [{ disabled: false, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'minimal-prompt' } } }],
  })
  await apply(fake.ctx)
  assert.deepEqual(fake.registered, [])
  assert.equal(fake.effects.length, 0)
})

test('声明行被禁用时仍由插件注册', async () => {
  const fake = fakeContext({
    entries: [{ disabled: true, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'minimal-prompt' } } }],
  })
  await apply(fake.ctx)
  assert.deepEqual(fake.registered, [PRESET])
})

test('注册表里已有同 id 时跳过注册', async () => {
  const fake = fakeContext({ presets: [{ id: 'minimal-prompt' }] })
  await apply(fake.ctx)
  assert.deepEqual(fake.registered, [])
})

test('loader entries 不可用时退回注册表检查并注册', async () => {
  const fake = fakeContext({ loader: false })
  await apply(fake.ctx)
  assert.deepEqual(fake.registered, [PRESET])
})
