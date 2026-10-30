import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { MODES } from '../lib/modes.js'
import { apply, inject, name } from '../lib/index.js'

const minimal = MODES.find(mode => mode.key === 'minimal').definition
const row = id => minimal.plugins.find(plugin => plugin.id === id)

test('中文极简使用独立 id，保留内置极简的完整能力边界', () => {
  assert.equal(minimal.id, 'minimal-zh')
  assert.equal(minimal.name, '中文极简')
  assert.equal(row('persona').config.complete, true)
  assert.equal(row('persona').config.includeRuntimeContext, false)
  assert.equal(row('persona').config.prefix, '你是一名乐于助人的软件工程助手。')
  assert.deepEqual(minimal.plugins.map(plugin => plugin.id), ['persona', 'presets-zh-context', 'tool-fs', 'compaction', 'persistent-shell'])
  assert.deepEqual(row('tool-fs').config, { read: false, readImage: true, write: false, edit: false })
  assert.deepEqual(row('compaction').config.map(plugin => plugin.id), ['compaction-basic', 'command-compact'])
  assert.equal(row('compaction').isolate.compaction, true)
})

test('中文极简仅按平台启用对应终端，保留持久状态与超时', () => {
  const shell = row('persistent-shell')
  assert.equal(shell.isolate.terminals, true)
  assert.deepEqual(shell.config.map(plugin => plugin.id), ['pty', 'terminal-bash', 'persistent-bash', 'terminal-pwsh', 'persistent-pwsh'])
  for (const plugin of shell.config.slice(1)) {
    const windows = plugin.id.includes('pwsh')
    assert.deepEqual(plugin.disabled, { __jsExpr: windows ? "process.platform !== 'win32'" : "process.platform === 'win32'" })
    assert.equal(plugin.config.timeoutMs, 300000)
  }
  assert.equal(shell.config.find(plugin => plugin.id === 'terminal-pwsh').config.shellDialect, 'pwsh')
  for (const id of ['persistent-bash', 'persistent-pwsh']) assert.match(shell.config.find(plugin => plugin.id === id).config.description, /Shell 状态会在多次命令调用/)
})

test('新插件不注册旧极简提示词，旧插件已安装不妨碍四种中文模式注册', async () => {
  const registered = [], effects = []
  await apply({
    effect: callback => effects.push(callback), loader: { entries: () => [] },
    agentPresets: { list: async () => [{ id: 'minimal-prompt' }], register: async definition => { registered.push(definition.id); return async () => {} } },
  })
  assert.deepEqual(registered, ['standard-zh-test', 'ptc-zh-test', 'minimal-zh', 'cordis-zh-test'])
  await effects[0]()()
})

test('新包独立入口、设置页和 bundle 标识完整，不依赖旧插件或本机附件', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@zhiqiangme/dsh-presets-zh')
  assert.equal(manifest.repository.directory, 'dsh-presets-zh')
  assert.equal(name, 'dsh-presets-zh')
  assert.deepEqual(inject, ['agentPresets', 'loader'])
  assert.equal(existsSync(new URL('../' + manifest.icon, import.meta.url)), true)
  assert.match(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), /id: dsh-presets-zh/)
  for (const { definition } of MODES) {
    assert.equal(JSON.stringify(definition).includes('@zhiqiangme/dsh-preset-minimal-prompt'), false)
    assert.equal(JSON.stringify(definition).includes('file:///'), false)
  }
})
