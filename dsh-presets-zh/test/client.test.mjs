import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { MODES, modeDefaults } from '../lib/modes.js'

/** 与 lib/client.js 的「插件更新」页签搭配的更新器替身；snapshot 字段直接覆盖默认值。 */
function fakeUpdater(snapshot = {}) {
  const value = { version: { phase: 'ready', currentVersion: '26.11.4', latestVersion: '26.11.4', updateAvailable: false }, manager: { phase: 'ready' }, market: { phase: 'idle' }, busy: false, ...snapshot }
  return { subscribe: () => () => {}, getSnapshot: () => value }
}

/** 宿主预设名单：四种中文模式加内置 standard；overrides 按 id 追加字段。 */
function roster(currentId, overrides = {}) {
  return [...MODES.map(mode => mode.definition.id), 'standard'].map(id => ({ id, isDefault: id === currentId, ...overrides[id] }))
}

function harness({ accepted = true, updater, presets, registryAccepted = true } = {}) {
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
    // 贴底保存栏依赖真实布局，这里只占位；定位逻辑靠浏览器验证。
    useLayoutEffect: () => { cursor++ },
    useRef: current => { cursor++; return { current } },
    useCallback: callback => { cursor++; return callback },
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
  // presets 留空表示宿主没有预设名单：动态 inject 的回调不会触发。
  let rows = presets
  const writes = [], events = {}
  let selectedDefault
  const registry = {
    getSnapshot: () => ({ value: { selectedDefault } }),
    set: async (field, value) => {
      writes.push([field, value])
      if (registryAccepted) {
        selectedDefault = value
        rows = rows.map(row => ({ ...row, isDefault: row.id === value }))
      }
      return registryAccepted
    },
  }
  const scoped = {
    effect: callback => callback(),
    remote: {
      agentPresets: { list: async () => { if (rows instanceof Error) throw rows; return { ok: true, value: { presets: rows } } } },
      $on: (event, listener) => { events[event] = listener; return () => {} },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    structuredClone,
    window: { __ModuleLoader__: { load(spec) { registration = spec; module = spec.factory(name => { assert.equal(name, 'react'); return React }) } } },
  })
  module.apply({
    effect: () => {},
    inject: (names, callback) => { if (presets && names[0] === 'remote.agentPresets') callback(scoped) },
    remote: {},
    configForms: { get: id => ({ 'dsh-presets-zh': form, 'agent-preset-registry': registry })[id] },
    slots: { inject: (_slot, callback) => callback(), register: (meta, component) => { slots.push({ meta, component }); return () => {} } },
  })
  const { defaults } = slots[0].meta.inject()
  return {
    calls, slots, registration, writes,
    changeSnapshot: value => { snapshot = { ...snapshot, ...value } },
    changeRoster: value => { rows = value },
    changeSelectedDefault: value => { selectedDefault = value },
    emit: (event, ...args) => events[event](...args),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    render() {
      let tree
      for (let i = 0; i < 4; i++) {
        cursor = 0; effects = []; changed = false
        tree = module.ModeSettings({ form, view: 'page', updater, defaults })
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

const tab = (tree, key) => nodes(tree, node => node.type === 'button' && node.props['data-mode'] === key)[0]
const prompt = tree => nodes(tree, node => node.type === 'textarea')[0]
const switches = tree => nodes(tree, node => node.type === 'input' && node.props.role === 'switch')
const setDefault = tree => button(tree, '设为新任务默认')

/** 挂载面板并等首次名单读取结束。 */
async function opened(options) {
  const client = harness(options)
  client.render()
  await client.settle()
  return client
}

test('插件包页和行设置页均挂载同一表单，四种模式按注册顺序切换编辑', () => {
  const client = harness()
  assert.equal(client.registration.id, '@zhiqiangme/dsh-presets-zh')
  assert.deepEqual(client.slots.map(slot => [slot.meta.name, slot.meta.key]), [
    ['plugins.bundle.config', '@zhiqiangme/dsh-presets-zh'],
    ['plugins.row.config', '@zhiqiangme/dsh-presets-zh#dsh-presets-zh'],
  ])
  let tree = client.render()
  assert.deepEqual(nodes(tree, node => node.props?.role === 'tab').map(node => node.props['data-mode']), MODES.map(mode => mode.key))
  // 每个页签只渲染当前模式：一个启用开关、一个提示词框。
  assert.equal(switches(tree).length, 1)
  assert.equal(nodes(tree, node => node.type === 'textarea').length, 1)
  for (const { key, definition } of MODES) {
    tab(tree, key).props.onClick()
    tree = client.render()
    assert.equal(prompt(tree).props.value, modeDefaults(definition).prompt)
  }
})

test('模式开关独立，停用后显示状态并在保存时写入对应模式', async () => {
  const client = harness()
  tab(client.render(), 'minimal').props.onClick()
  let tree = client.render()
  switches(tree)[0].props.onChange({ target: { checked: false } })
  tree = client.render()
  assert.equal(tab(tree, 'minimal').props['data-enabled'], 'false')
  assert.equal(tab(tree, 'standard').props['data-enabled'], 'true')
  assert.match(text(tab(tree, 'minimal')), /已停用/)
  assert.deepEqual([...nodes(tree, node => node.type === 'b')[0].children], ['3'])
  await button(tree, '保存设置').props.onClick()
  const ops = client.calls[0].ops
  // 客户端在 vm 上下文中运行，数组需复制到当前上下文再比较。
  assert.deepEqual([...ops.map(op => op.path[0])], MODES.map(mode => mode.key))
  assert.equal(ops.find(op => op.path[0] === 'minimal').value.enabled, false)
  assert.equal(ops.filter(op => op.value.enabled === false).length, 1)
})

test('模式输入独立，保存带编辑版本号，成功后重新读取宿主返回值', async () => {
  const client = harness()
  let tree = client.render()
  prompt(tree).props.onChange({ target: { value: '自定义标准提示词' } })
  tree = client.render()
  assert.match(text(tree), /有未保存的更改/)
  tab(tree, 'minimal').props.onClick()
  tree = client.render()
  assert.equal(prompt(tree).props.value, '你是一名乐于助人的软件工程助手。')
  await button(tree, '保存设置').props.onClick()
  assert.equal(client.calls[0].revision, 5)
  assert.equal(client.calls[0].ops.find(op => op.path[0] === 'standard').value.prompt, '自定义标准提示词')
  assert.match(text(client.render()), /已保存/)
})

test('恢复默认只回填当前模式，与默认一致时按钮不可用', () => {
  const client = harness()
  let tree = client.render()
  assert.equal(button(tree, '恢复此模式默认设置').props.disabled, true)
  prompt(tree).props.onChange({ target: { value: '临时内容' } })
  tree = client.render()
  assert.match(text(tree), /已自定义/)
  button(tree, '恢复此模式默认设置').props.onClick()
  tree = client.render()
  assert.equal(prompt(tree).props.value, '你是一名乐于助人的软件工程助手。')
  assert.match(text(tree), /默认内容已填入/)
})

test('后台变更不覆盖草稿，冲突保存保留草稿，重新载入后采用新版本', async () => {
  const client = harness({ accepted: false })
  tab(client.render(), 'ptc').props.onClick()
  prompt(client.render()).props.onChange({ target: { value: '保留 PTC 草稿' } })
  client.changeSnapshot({ revision: 6 })
  await button(client.render(), '保存设置').props.onClick()
  let tree = client.render()
  assert.equal(client.calls[0].revision, 5)
  assert.equal(prompt(tree).props.value, '保留 PTC 草稿')
  assert.match(text(tree), /未保存，配置可能已在其他页面更新/)
  button(tree, '重新载入').props.onClick()
  tree = client.render()
  assert.notEqual(prompt(tree).props.value, '保留 PTC 草稿')
})

test('未保存的模式在页签上标记，保存后清除', async () => {
  const client = harness()
  const marks = tree => nodes(tree, node => node.props?.['aria-label'] === '未保存').length
  let tree = client.render()
  assert.equal(marks(tree), 0)
  prompt(tree).props.onChange({ target: { value: '改过' } })
  tab(client.render(), 'ptc').props.onClick()
  tree = client.render()
  assert.equal(marks(tab(tree, 'standard')), 1, '切到其他模式后，改过的页签仍有标记')
  assert.equal(marks(tab(tree, 'ptc')), 0)
  await button(tree, '保存设置').props.onClick()
  assert.equal(marks(client.render()), 0)
})

test('「插件更新」是最后一个页签：面板常驻以便检查版本，只切 hidden，没有未保存内容时不显示保存栏', () => {
  const client = harness({ updater: fakeUpdater() })
  const panel = tree => nodes(tree, node => node.props?.id === 'dpz-panel-update')[0]
  let tree = client.render()
  assert.deepEqual(nodes(tree, node => node.props?.role === 'tab').map(node => node.props['data-mode']), [...MODES.map(mode => mode.key), 'update'])
  assert.equal(panel(tree).props.hidden, true)
  assert.ok(button(tree, '保存设置'))
  tab(tree, 'update').props.onClick()
  tree = client.render()
  assert.equal(panel(tree).props.hidden, false)
  assert.equal(nodes(tree, node => node.type === 'textarea').length, 0)
  assert.equal(button(tree, '保存设置'), undefined)
})

test('切到「插件更新」时有未保存的更改仍保留保存栏', () => {
  const client = harness({ updater: fakeUpdater() })
  prompt(client.render()).props.onChange({ target: { value: '改过' } })
  tab(client.render(), 'update').props.onClick()
  assert.ok(button(client.render(), '保存设置'))
})

test('头部显示当前版本；有新版本时提醒并可跳到「插件更新」，刚更新成功后不再提醒', () => {
  const available = { phase: 'ready', currentVersion: '26.11.4', latestVersion: '26.11.9', updateAvailable: true }
  const client = harness({ updater: fakeUpdater({ version: available }) })
  const chip = tree => nodes(tree, node => node.type === 'button' && node.props.className === 'dpz-chip')[0]
  let tree = client.render()
  assert.match(text(chip(tree)), /v26\.11\.4/)
  assert.match(text(chip(tree)), /有新版本/)
  assert.equal(nodes(tab(tree, 'update'), node => node.props?.['aria-label'] === '有新版本').length, 1)
  chip(tree).props.onClick()
  tree = client.render()
  assert.equal(tab(tree, 'update').props['aria-selected'], true)
  const finished = harness({ updater: fakeUpdater({ version: available, operation: { state: 'succeeded', installedVersion: '26.11.9' } }) })
  assert.doesNotMatch(text(chip(finished.render())), /有新版本/)
})

test('没有更新器时不显示版本入口与「插件更新」页签', () => {
  const tree = harness().render()
  assert.equal(nodes(tree, node => node.props?.id === 'dpz-panel-update').length, 0)
  assert.equal(nodes(tree, node => node.props?.className === 'dpz-chip' && node.type === 'button').length, 0)
})

test('主按钮文字不用与底色同值的 brand-primary-invert，禁用态有独立配色', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\.dpz-btn\.dpz-primary\{[^}]*color:var\(--dsw-alias-label-primary-foreground/)
  assert.match(source, /\.dpz-btn\.dpz-primary:disabled\{[^}]*background:/)
  assert.doesNotMatch(source, /color:var\(--dsw-alias-brand-primary-invert/)
})

test('只读配置禁用输入与保存，并提示原因', () => {
  const client = harness()
  client.changeSnapshot({ writable: false })
  const tree = client.render()
  assert.equal(nodes(tree, node => node.type === 'fieldset')[0].props.disabled, true)
  assert.ok(switches(tree).every(node => node.props.disabled))
  assert.equal(button(tree, '保存设置').props.disabled, true)
  assert.match(text(tree), /只读/)
})

test('详情页把面板提到 README 上方，规则只作用于本插件', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('[data-plugin-detail="@zhiqiangme/dsh-presets-zh"] section[data-plugin-config]{order:-1}'))
})

test('详情页首次挂载面板时回到顶部，同页重新挂载不打断滚动', () => {
  const attach = harness().render().props.ref
  const scroller = { scrollTop: 900, parentElement: null }
  const page = { parentElement: scroller }
  const card = { closest: (selector) => (selector === '[data-plugin-config]' ? page : null) }
  attach(card)
  assert.equal(scroller.scrollTop, 0)
  scroller.scrollTop = 300
  attach(card)
  assert.equal(scroller.scrollTop, 300, '同一页内重新挂载不动滚动位置')
  attach(null)
  attach({ closest: () => null })
  assert.equal(scroller.scrollTop, 300, '卸载和配置页以外的挂载都不动滚动位置')
})

test('当前默认的模式有徽标和页签标记，开关锁定，不再显示设为默认按钮', async () => {
  const client = await opened({ presets: roster('standard-zh') })
  let tree = client.render()
  assert.match(text(tab(tree, 'standard')), /默认/)
  assert.doesNotMatch(text(tab(tree, 'ptc')), /默认/)
  assert.match(text(tree), /停用前先把其他模式设为默认/)
  assert.equal(setDefault(tree), undefined)
  assert.equal(switches(tree)[0].props.disabled, true)
  tab(tree, 'ptc').props.onClick()
  tree = client.render()
  assert.equal(switches(tree)[0].props.disabled, false)
  assert.equal(setDefault(tree).props.disabled, false)
})

test('默认是内置预设时四个模式都没有标记', async () => {
  const tree = (await opened({ presets: roster('standard') })).render()
  for (const { key } of MODES) assert.doesNotMatch(text(tab(tree, key)), /默认/)
  assert.ok(setDefault(tree))
})

test('设为默认只写宿主的 selectedDefault，成功后标记跟到新模式', async () => {
  const client = await opened({ presets: roster('standard') })
  tab(client.render(), 'ptc').props.onClick()
  await setDefault(client.render()).props.onClick()
  assert.deepEqual(client.writes, [['selectedDefault', 'ptc-zh']])
  assert.equal(client.calls.length, 0, '默认写在宿主配置项里，不碰本插件的模式设置')
  const tree = client.render()
  assert.match(text(tab(tree, 'ptc')), /默认/)
  assert.equal(setDefault(tree), undefined)
  assert.match(text(tree), /已打开的空白任务保持原模式/)
})

test('写入前按最新名单确认：未注册或加载失败的模式不写入', async () => {
  const client = await opened({ presets: roster('standard') })
  tab(client.render(), 'ptc').props.onClick()
  const stale = setDefault(client.render())
  client.changeRoster(roster('standard').filter(row => row.id !== 'ptc-zh'))
  await stale.props.onClick()
  assert.match(text(client.render()), /尚未加载/)
  client.changeRoster(roster('standard', { 'ptc-zh': { broken: { message: '依赖缺失' } } }))
  await setDefault(client.render()).props.onClick()
  const tree = client.render()
  assert.match(text(tree), /加载失败，不能设为默认/)
  assert.equal(setDefault(tree).props.disabled, true)
  assert.deepEqual(client.writes, [])
})

test('宿主拒绝写入或读不到名单时给出提示，默认不变', async () => {
  const refused = await opened({ presets: roster('standard'), registryAccepted: false })
  await setDefault(refused.render()).props.onClick()
  let tree = refused.render()
  assert.match(text(tree), /未设置，配置可能已在其他页面更新/)
  assert.ok(setDefault(tree), '仍是原来的默认，按钮保留')
  const offline = await opened({ presets: roster('standard') })
  offline.changeRoster(new Error('连接断开'))
  await setDefault(offline.render()).props.onClick()
  tree = offline.render()
  assert.match(text(tree), /设置失败/)
  assert.deepEqual(offline.writes, [])
  assert.ok(setDefault(tree), '读失败时保留上一次的状态，不收起入口')
})

test('已停用或只在草稿里启用的模式不能设为默认', async () => {
  const client = await opened({ presets: roster('standard') })
  tab(client.render(), 'minimal').props.onClick()
  switches(client.render())[0].props.onChange({ target: { checked: false } })
  assert.equal(setDefault(client.render()).props.disabled, true)
  await button(client.render(), '保存设置').props.onClick()
  assert.equal(setDefault(client.render()).props.disabled, true)
  switches(client.render())[0].props.onChange({ target: { checked: true } })
  assert.equal(setDefault(client.render()).props.disabled, true, '草稿打开但还没保存，预设尚未注册')
})

test('保存前按最新名单拦下停用当前默认的修改，草稿保留', async () => {
  const client = await opened({ presets: roster('standard') })
  tab(client.render(), 'ptc').props.onClick()
  switches(client.render())[0].props.onChange({ target: { checked: false } })
  // 面板上的名单还是旧的，其他页面刚把默认改成这个模式。
  client.changeRoster(roster('ptc-zh'))
  await button(client.render(), '保存设置').props.onClick()
  const tree = client.render()
  assert.equal(client.calls.length, 0)
  assert.match(text(tree), /是新任务默认，请先把其他模式设为默认再停用/)
  assert.equal(switches(tree)[0].props.checked, false)
})

test('已停用却仍是默认的模式：提示新任务会失败，不挡其他修改的保存', async () => {
  const client = await opened({ presets: roster('standard') })
  tab(client.render(), 'ptc').props.onClick()
  switches(client.render())[0].props.onChange({ target: { checked: false } })
  await button(client.render(), '保存设置').props.onClick()
  // 停用的模式不注册：宿主名单里没有这一行，也就没有 isDefault，只有配置里还写着它。
  client.changeRoster(roster('ptc-zh').filter(row => row.id !== 'ptc-zh'))
  client.changeSelectedDefault('ptc-zh')
  client.emit('settings/document-updated', 'agent-preset-registry')
  await client.settle()
  const tree = client.render()
  assert.match(text(tab(tree, 'ptc')), /默认/)
  assert.match(text(tree), /新任务会创建失败/)
  assert.equal(switches(tree)[0].props.disabled, false, '要能把它重新启用')
  prompt(tree).props.onChange({ target: { value: '改过' } })
  await button(client.render(), '保存设置').props.onClick()
  assert.equal(client.calls.length, 2)
})

test('只响应宿主预设配置的更新事件', async () => {
  const client = await opened({ presets: roster('standard') })
  client.changeRoster(roster('ptc-zh'))
  client.emit('settings/document-updated', 'dsh-presets-zh')
  await client.settle()
  assert.doesNotMatch(text(tab(client.render(), 'ptc')), /默认/)
  client.emit('settings/document-updated', 'agent-preset-registry')
  await client.settle()
  assert.match(text(tab(client.render(), 'ptc')), /默认/)
})

test('宿主没有预设名单时不显示默认入口，模式设置照常保存', async () => {
  const client = await opened()
  const tree = client.render()
  assert.equal(setDefault(tree), undefined)
  assert.doesNotMatch(text(tree), /新任务默认/)
  assert.equal(switches(tree)[0].props.disabled, false)
  prompt(tree).props.onChange({ target: { value: '改过' } })
  await button(client.render(), '保存设置').props.onClick()
  assert.equal(client.calls.length, 1)
})

test('真实 cordis：预设名单走动态 inject，命名空间晚于插件挂载也能接上，撤下后入口消失', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const registered = []
  class Remote extends Service {
    constructor(ctx) { super(ctx, 'remote'); this.owner = ctx }
    $on() { return () => {} }
  }
  class Slots extends Service {
    constructor(ctx) { super(ctx, 'slots') }
    inject(_slot, callback) { callback() }
    register(meta) { registered.push(meta); return () => {} }
  }
  class ConfigForms extends Service {
    constructor(ctx) { super(ctx, 'configForms') }
    get() { return { getSnapshot: () => ({}) } }
  }
  // 宿主把每个 Remote 命名空间挂成 remote 的子 fiber，与插件不在同一分支；读未声明的服务时 cordis 会抛错。
  class AgentPresets extends Service {
    constructor(ctx) { super(ctx, 'remote.agentPresets') }
    list() { return { ok: true, value: { presets: roster('standard-zh') } } }
  }
  let module
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    structuredClone,
    window: { __ModuleLoader__: { load(spec) { module = spec.factory(() => ({})) } } },
  })
  const until = async condition => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(condition())
  }
  const root = new Context()
  await root.plugin({ name: 'host', apply(ctx) { new Remote(ctx); new Slots(ctx); new ConfigForms(ctx) } })
  await root.plugin({ name: 'presets-zh-client', inject: [...module.inject], apply: ctx => module.apply(ctx) })
  const { defaults } = registered[0].inject()
  assert.equal(defaults.getSnapshot().ready, false)
  const namespace = root.get('remote').owner.plugin({ name: 'remote.agentPresets', apply(ctx) { new AgentPresets(ctx) } })
  await namespace
  await until(() => defaults.getSnapshot().ready)
  assert.equal(defaults.getSnapshot().currentId, 'standard-zh')
  await namespace.dispose()
  await until(() => !defaults.getSnapshot().ready)
  await root.dispose?.()
})
