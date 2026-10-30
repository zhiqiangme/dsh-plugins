import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { MODES, modeDefaults } from '../lib/modes.js'

function harness({ accepted = true } = {}) {
  const initial = Object.fromEntries(MODES.map(mode => [mode.key, modeDefaults(mode.definition)]))
  let snapshot = { value: structuredClone(initial), base: structuredClone(initial), revision: 5, writable: true }
  const calls = [], slots = [], states = [], dependencies = []
  let module, registration, cursor, effects, changed
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useSyncExternalStore: (_subscribe, get) => { cursor++; return get() },
    useState: initialValue => {
      const index = cursor++
      if (!(index in states)) states[index] = initialValue
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; changed = true }]
    },
    useEffect: (callback, deps) => {
      const index = cursor++
      if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) effects.push(callback)
      dependencies[index] = deps
    },
  }
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    mutate: async (ops, revision) => {
      calls.push({ ops, revision })
      if (accepted) {
        snapshot = { ...snapshot, value: Object.fromEntries(ops.map(op => [op.path[0], op.value])), revision: snapshot.revision + 1 }
      }
      return accepted
    },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    structuredClone,
    window: { __ModuleLoader__: { load(spec) { registration = spec; module = spec.factory(name => { assert.equal(name, 'react'); return React }) } } },
  })
  module.apply({
    configForms: { get: id => { assert.equal(id, 'dsh-presets-zh'); return form } },
    slots: { inject: (_slot, callback) => callback(), register: (meta, component) => { slots.push({ meta, component }); return () => {} } },
  })
  return {
    calls, slots, registration,
    changeSnapshot: value => { snapshot = { ...snapshot, ...value } },
    render() {
      let tree
      for (let i = 0; i < 4; i++) {
        cursor = 0; effects = []; changed = false
        tree = module.ModeSettings({ form, view: 'page' })
        for (const effect of effects) effect()
        if (!changed) break
      }
      return tree
    },
  }
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))]
}
const button = (tree, label) => nodes(tree, node => node.type === 'button' && node.children.includes(label))[0]
const text = tree => JSON.stringify(tree)

test('插件包页和行设置页均挂载同一表单，四种模式分别提供输入项', () => {
  const client = harness()
  assert.equal(client.registration.id, '@zhiqiangme/dsh-presets-zh')
  assert.deepEqual(client.slots.map(slot => [slot.meta.name, slot.meta.key]), [
    ['plugins.bundle.config', '@zhiqiangme/dsh-presets-zh'],
    ['plugins.row.config', '@zhiqiangme/dsh-presets-zh#dsh-presets-zh'],
  ])
  const tree = client.render()
  assert.equal(nodes(tree, node => node.type === 'details').length, 4)
  assert.equal(nodes(tree, node => node.type === 'input' && node.props.type === 'checkbox').length, 4)
  assert.equal(nodes(tree, node => node.type === 'textarea').length, 4)
})

test('模式输入独立，保存带编辑版本号，成功后重新读取宿主返回值', async () => {
  const client = harness()
  let tree = client.render()
  const controls = nodes(tree, node => node.type === 'textarea')
  controls[1].props.onChange({ target: { value: '自定义标准提示词' } })
  tree = client.render()
  assert.equal(nodes(tree, node => node.type === 'textarea')[0].props.value, '你是一名乐于助人的软件工程助手。')
  await button(tree, '保存设置').props.onClick()
  assert.equal(client.calls[0].revision, 5)
  assert.equal(client.calls[0].ops[1].value.prompt, '自定义标准提示词')
  assert.match(text(client.render()), /已保存/)
})

test('后台变更不覆盖草稿，冲突保存保留草稿，重新载入后采用新版本', async () => {
  const client = harness({ accepted: false })
  nodes(client.render(), node => node.type === 'textarea')[2].props.onChange({ target: { value: '保留 PTC 草稿' } })
  client.changeSnapshot({ revision: 6 })
  await button(client.render(), '保存设置').props.onClick()
  let tree = client.render()
  assert.equal(client.calls[0].revision, 5)
  assert.equal(nodes(tree, node => node.type === 'textarea')[2].props.value, '保留 PTC 草稿')
  assert.match(text(tree), /未保存，配置可能已在其他页面更新/)
  button(tree, '重新载入').props.onClick()
  tree = client.render()
  assert.notEqual(nodes(tree, node => node.type === 'textarea')[2].props.value, '保留 PTC 草稿')
})
