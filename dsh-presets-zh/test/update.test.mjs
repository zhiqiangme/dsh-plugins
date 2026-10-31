import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { checkLatestVersion, compareVersions, createVersionChecker, PACKAGE_NAME, RUNNING_VERSION } from '../lib/update.js'
import { registerVersionRoute, requestRejection, VERSION_PATH } from '../lib/web.js'

const MARKET = '/dsh-market/api/v1'
const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)) }

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate))
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))]
}
const text = tree => Array.isArray(tree) ? tree.map(text).join('|') : typeof tree === 'string' ? tree : tree?.children ? text(tree.children) : ''
const updateButton = tree => nodes(tree, node => node.type === 'button' && String(node.children[0]).startsWith('更新到'))[0]
const pinned = tree => nodes(tree, node => node.type === 'details')[0]

/** 在 vm 里加载浏览器半侧，拿到它导出的更新器与渲染函数；fetch 由各测试按路径应答。 */
function loadClient({ respond, storage = new Map() } = {}) {
  const calls = []
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }) }
  let module
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    setTimeout: callback => setImmediate(callback),
    clearTimeout: () => {},
    fetch: async (path, options = {}) => {
      const body = options.body === undefined ? undefined : JSON.parse(options.body)
      calls.push([options.method ?? 'GET', path, body])
      const [status, payload] = respond?.(options.method ?? 'GET', path, body) ?? [404, undefined]
      return { status, ok: status >= 200 && status < 300, json: async () => { if (payload === undefined) throw new Error('not json'); return payload } }
    },
    window: {
      crypto: webcrypto,
      sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      __ModuleLoader__: { load(spec) { module = spec.factory(() => React) } },
    },
  })
  return { module, calls, storage }
}

const versionPayload = { ok: true, currentVersion: '26.10.30', latestVersion: '26.10.31', updateAvailable: true }
const bundle = { name: '@zhiqiangme/dsh-presets-zh', version: '26.10.30', source: '@zhiqiangme/dsh-presets-zh@26.10.30', availability: 'profile', updatable: true }

/** 有官方接口的宿主；setBundleEnabled 记录调用，用来核对卸载被拒后的补回。 */
function officialRemote({ result, enabled = true, setBundleEnabled } = {}) {
  const calls = []
  const events = new Map()
  const remote = {
    $on: (event, listener) => { events.set(event, listener); return () => events.delete(event) },
    pluginManager: {
      listBundles: async () => ({ ok: true, value: [{ ...bundle, enabled }] }),
      listVersions: async name => ({ ok: true, value: { status: 'listed', installed: '26.10.30', registry: 'https://registry.example/', versions: [
        { version: '26.10.32-rc.1', bundle: true, prerelease: true },
        { version: '26.10.31', bundle: true, prerelease: false },
      ] } }),
      updateBundle: async (...args) => { calls.push(['updateBundle', ...args]); return { ok: true, value: result } },
      ...(setBundleEnabled === null ? {} : {
        setBundleEnabled: async (...args) => { calls.push(['setBundleEnabled', ...args]); return { ok: true, value: setBundleEnabled ?? { application: 'applied' } } },
      }),
    },
  }
  return { remote, calls, events }
}

const versionOnly = (method, path) => path.startsWith(VERSION_PATH) ? [200, versionPayload] : undefined

test('compareVersions：日期版本号、预发布与非法输入', () => {
  assert.ok(compareVersions('26.10.31', '26.10.30') > 0)
  assert.ok(compareVersions('26.10.31-rc.1', '26.10.31') < 0)
  assert.equal(compareVersions('v26.10.31', '26.10.31'), 0)
  assert.ok(Number.isNaN(compareVersions('latest', '26.10.31')))
  assert.equal(PACKAGE_NAME, '@zhiqiangme/dsh-presets-zh')
  assert.equal(RUNNING_VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
})

test('checkLatestVersion：编码作用域包名，取各注册表最高版本；全部失败时逐个列出原因', async () => {
  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    if (url.startsWith('https://b')) return { ok: false, status: 404 }
    return { ok: true, json: async () => ({ latest: url.startsWith('https://a') ? '26.10.31' : '26.10.29' }) }
  }
  const result = await checkLatestVersion({ current: '26.10.30', registries: ['https://a/', 'https://b', 'https://c'], fetchImpl })
  assert.equal(urls[0], 'https://a/-/package/@zhiqiangme%2Fdsh-presets-zh/dist-tags')
  assert.deepEqual([result.ok, result.latestVersion, result.updateAvailable, result.registry], [true, '26.10.31', true, 'https://a/'])
  const failed = await checkLatestVersion({ registries: ['https://b'], fetchImpl })
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /https:\/\/b：HTTP 404/)
})

test('createVersionChecker：成功结果按 TTL 缓存，force 绕过；失败不缓存', async () => {
  let clock = 0, hits = 0, fail = true
  const check = createVersionChecker({ registries: ['https://a'], now: () => clock, ttlMs: 1000,
    fetchImpl: async () => { hits++; return fail ? { ok: false, status: 500 } : { ok: true, json: async () => ({ latest: '26.10.31' }) } } })
  assert.equal((await check()).ok, false)
  fail = false
  await check()
  await check()
  assert.equal(hits, 2)
  await check({ force: true })
  clock = 2000
  await check()
  assert.equal(hits, 4)
})

test('版本路由：等 webServer 就绪后注册，校验来源与方法，卸载时释放；没有 webServer 只记 warn', async () => {
  const effects = [], warnings = []
  let route, disposed = false
  const ctx = {
    effect: callback => effects.push(callback()),
    inject: (deps, callback) => { assert.deepEqual(deps, ['webServer']); callback(ctx) },
    webServer: { register: value => { route = value; return () => { disposed = true } } },
  }
  registerVersionRoute(ctx, { checkVersion: async ({ force }) => ({ ok: true, force }) })
  assert.deepEqual([route.kind, route.path], ['exact', VERSION_PATH])
  const call = async req => {
    const res = { headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = JSON.parse(body) } }
    await route.handler({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:1' }, method: 'GET', ...req }, res)
    return res
  }
  assert.deepEqual((await call({ url: `${VERSION_PATH}?force=1` })).body, { ok: true, force: true })
  assert.equal((await call({ method: 'POST' })).statusCode, 405)
  assert.equal((await call({ headers: { host: 'localhost:1', origin: 'https://evil.example' } })).statusCode, 403)
  effects[0]()
  assert.equal(disposed, true)
  assert.equal(requestRejection({}, { requestRejection: () => 401 }), 401)
  assert.equal(requestRejection({ socket: { remoteAddress: '10.0.0.2' }, headers: {} }), 403)

  registerVersionRoute({ effect: () => assert.fail('不该注册') }, { logger: { warn: message => warnings.push(message) } })
  assert.match(warnings[0], /webServer/)
})

test('设置页把同一个更新器交给两处挂载，宿主不认识插件变更事件也不影响注册', () => {
  const { module } = loadClient()
  const slots = []
  const effects = []
  module.apply({
    effect: callback => effects.push(callback()),
    remote: { $on: () => { throw new Error('unknown event') } },
    configForms: { get: () => ({}) },
    slots: { inject: (_slot, callback) => callback(), register: meta => slots.push(meta) },
  })
  const [first, second] = slots.map(meta => meta.inject().updater)
  assert.equal(first, second)
  assert.equal(typeof first.check, 'function')
  assert.deepEqual([...module.inject], ['slots', 'configForms', 'remote'])
  assert.equal(effects.length, 2)
})

test('官方更新：把宿主兼容正式版与注册表交给 updateBundle，进度按 requestId 隔离', async () => {
  const { module } = loadClient({ respond: versionOnly })
  const host = officialRemote()
  const updater = module.createPluginUpdater(host.remote)
  await updater.check()
  assert.equal(updater.getSnapshot().manager.candidate, '26.10.31')
  const tree = module.renderUpdateSection(updater.getSnapshot(), {})
  assert.ok(updateButton(tree))
  assert.equal(pinned(tree), undefined, '官方接口已给出结论时不建议手动重装')
  let finish
  host.remote.pluginManager.updateBundle = async (...args) => {
    host.calls.push(['updateBundle', ...args])
    return new Promise(resolve => { finish = resolve })
  }
  const running = updater.startUpdate()
  assert.equal(updater.startUpdate(), running, '重复点击只提交一次')
  await flush(1)
  const [, name, target, options] = host.calls[0]
  assert.deepEqual([name, target, options.registry], ['@zhiqiangme/dsh-presets-zh', '26.10.31', 'https://registry.example/'])
  host.events.get('plugin-manager/update-state')({ requestId: 'other', step: 'restoring' })
  assert.equal(updater.getSnapshot().operation.step, 'checking')
  host.events.get('plugin-manager/update-state')({ requestId: options.requestId, step: 'installing' })
  assert.match(text(module.renderUpdateSection(updater.getSnapshot(), {})), /正在安装新版本/)
  finish({ ok: true, value: { from: '26.10.30', to: '26.10.31', step: 'install', result: { application: 'restart-required', version: '26.10.31' } } })
  await running
  assert.equal(host.calls.length, 1)
  assert.equal(updater.getSnapshot().operation.state, 'succeeded')
  assert.match(text(module.renderUpdateSection(updater.getSnapshot(), {})), /已更新到 v26\.10\.31。 重启 DSH 后生效/)
  assert.equal(host.events.has('plugin-manager/update-state'), false)
})

test('官方更新：宿主卸不下运行中的本插件时说明原因、补回启用状态，并展开指定版本重装', async () => {
  const refusal = { from: '26.10.30', to: '26.10.31', step: 'remove', result: { application: 'failed', error: { code: 'bundle-in-use' } } }
  for (const [variant, expected] of [['applied', undefined], ['failed', 'lock-timeout'], ['missing', 'setBundleEnabled unavailable'], ['enabled', undefined]]) {
    const { module } = loadClient({ respond: versionOnly })
    const host = officialRemote({
      result: refusal,
      enabled: variant === 'enabled',
      setBundleEnabled: variant === 'missing' ? null : variant === 'failed' ? { application: 'failed', error: { code: 'lock-timeout' } } : undefined,
    })
    const updater = module.createPluginUpdater(host.remote)
    await updater.check()
    await updater.startUpdate()
    const { operation } = updater.getSnapshot()
    assert.equal(operation.inUse, true)
    assert.equal(operation.reselectFailure, expected)
    const reselected = host.calls.filter(call => call[0] === 'setBundleEnabled')
    assert.equal(reselected.length, ['applied', 'failed'].includes(variant) ? 1 : 0, variant)
    if (reselected.length) assert.deepEqual(reselected[0].slice(1), ['@zhiqiangme/dsh-presets-zh', true])
    const tree = module.renderUpdateSection(updater.getSnapshot(), {})
    assert.match(text(tree), /bundle-in-use/)
    assert.equal(/自动补回失败/.test(text(tree)), Boolean(expected))
    assert.equal(pinned(tree).props.open, true)
    assert.match(text(pinned(tree)), /先关闭「中文预设」组件/)
    assert.equal(nodes(pinned(tree), node => node.type === 'input')[0].props.value, '@zhiqiangme/dsh-presets-zh@26.10.31')
  }
})

test('dshmarket 兜底：宿主没有官方接口时探测市场，提交纯包名并轮询到成功，带重启按钮', async () => {
  const operations = [{ state: 'running', progress: { percent: 40 } }, { state: 'succeeded', installedVersion: '26.10.31', outcome: { restartRequired: true } }]
  const { module, calls, storage } = loadClient({
    respond: (method, path) => {
      if (path.startsWith(VERSION_PATH)) return [200, versionPayload]
      if (path === `${MARKET}/capabilities`) return [200, { schema: 'dsh-market/update-api/v1', bootId: 'boot', features: { update: true }, restart: { supported: true } }]
      if (path.startsWith(`${MARKET}/updates?name=`)) return [200, { package: { source: 'npm' } }]
      if (method === 'POST' && path === `${MARKET}/updates`) return [202, { operation: { operationId: 'boot-1', state: 'queued' } }]
      if (path.startsWith(`${MARKET}/operations?operationId=boot-1`)) return [200, { operation: operations.shift() }]
      if (method === 'POST' && path === `${MARKET}/restart`) return [202, {}]
    },
  })
  const updater = module.createPluginUpdater({ pluginManager: { listBundles: async () => ({ ok: true, value: [bundle] }) } })
  await updater.check()
  assert.deepEqual([updater.getSnapshot().manager.phase, updater.getSnapshot().market.phase], ['unsupported', 'ready'])
  assert.ok(updateButton(module.renderUpdateSection(updater.getSnapshot(), {})))
  await updater.startUpdate()
  assert.deepEqual(calls.find(call => call[0] === 'POST')[2], { packageName: '@zhiqiangme/dsh-presets-zh' })
  assert.match(storage.get('dsh-presets-zh:update-operation'), /boot-1/)
  await flush()
  assert.equal(updater.getSnapshot().operation.state, 'succeeded')
  assert.equal(storage.has('dsh-presets-zh:update-operation'), false)
  const tree = module.renderUpdateSection(updater.getSnapshot(), {})
  assert.match(text(tree), /已更新到 v26\.10\.31/)
  assert.ok(nodes(tree, node => node.type === 'button' && node.children[0] === '立即重启 DSH').length)
  await updater.restart()
  assert.equal(updater.getSnapshot().restart.phase, 'done')
})

test('dshmarket 兜底：市场报 bundle-in-use 时说明原因并展开手动重装；冷却期给强制更新', async () => {
  for (const failure of [{ message: 'exit=1 err=这个插件正在使用中 (bundle-in-use)' }, { code: 'RELEASE_TOO_FRESH', message: 'too fresh' }]) {
    const { module, calls } = loadClient({
      respond: (method, path) => {
        if (path.startsWith(VERSION_PATH)) return [200, versionPayload]
        if (path === `${MARKET}/capabilities`) return [200, { schema: 'dsh-market/update-api/v1', bootId: 'boot', features: { update: true } }]
        if (method === 'POST' && path === `${MARKET}/updates`) return [202, { operation: { operationId: 'boot-2', state: 'queued' } }]
        if (path.startsWith(`${MARKET}/operations`)) return [200, { operation: { state: 'failed', failure } }]
      },
    })
    const updater = module.createPluginUpdater(undefined)
    await updater.check()
    await updater.startUpdate()
    await flush()
    const tree = module.renderUpdateSection(updater.getSnapshot(), { startUpdate: force => updater.startUpdate(force) })
    assert.equal(pinned(tree).props.open, true)
    const force = nodes(tree, node => node.type === 'button' && node.children[0] === '强制更新')[0]
    if (failure.code) {
      assert.match(text(tree), /发布冷却期/)
      await force.props.onClick()
      assert.equal(calls.filter(call => call[0] === 'POST').at(-1)[2].force, true)
    } else {
      assert.equal(updater.getSnapshot().operation.inUse, true)
      assert.match(text(tree), /无法在本插件运行时卸下它/)
      assert.equal(force, undefined)
    }
  }
})

test('两条更新路都没有：说明可装 dshmarket，并给指定版本；本地安装只提示重跑安装脚本', async () => {
  const { module } = loadClient({ respond: versionOnly })
  const updater = module.createPluginUpdater({})
  await updater.check()
  assert.equal(updater.getSnapshot().market.phase, 'absent')
  let tree = module.renderUpdateSection(updater.getSnapshot(), {})
  assert.equal(updateButton(tree), undefined)
  assert.match(text(tree), /dshmarket/)
  assert.equal(pinned(tree).props.open, true)
  await updater.startUpdate()
  assert.equal(updater.getSnapshot().operation, undefined)

  const local = module.createPluginUpdater({ pluginManager: { listBundles: async () => ({ ok: true, value: [{ ...bundle, source: 'file:D:/dsh-presets-zh' }] }) } })
  await local.check()
  tree = module.renderUpdateSection(local.getSnapshot(), {})
  assert.match(text(tree), /重新运行安装脚本/)
  assert.equal(pinned(tree), undefined)
  assert.equal(module.pinnedInstallSpec('latest'), undefined)
})
