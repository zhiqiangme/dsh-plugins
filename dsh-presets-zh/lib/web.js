/**
 * 设置页“插件更新”区块的宿主半侧：一条版本路由（经宿主浏览器会话鉴权）。
 *
 *   GET /plugins/dsh-presets-zh/version  当前运行版本 vs npm latest（?force=1 绕过缓存，见 lib/update.js）
 *
 * 挂在 ctx.webServer 而不是自己 listen：宿主 webserver 占着客户端的同源地址，挂在它下面才拿得到
 * 同源 fetch。webServer 也是软取：拿不到只少了版本检查，四种预设照常注册。
 */
import { createVersionChecker } from './update.js'

export const VERSION_PATH = '/plugins/dsh-presets-zh/version'

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 宿主 connection 服务负责浏览器会话鉴权；旧宿主没有时只放行同源的本机请求。 */
export function requestRejection(req, connection) {
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  const address = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  if (address !== '::1' && !address.startsWith('127.')) return 403
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return 403
  const origin = req.headers?.origin
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === req.headers?.host ? undefined : 403
  } catch {
    return 403
  }
}

/** 读属性与 ctx.get 两种方式都试；服务未就绪时读属性可能抛。 */
function service(ctx, name, method) {
  for (const read of [() => ctx?.[name], () => ctx?.get?.(name)]) {
    try {
      const value = read()
      if (typeof value?.[method] === 'function') return value
    } catch {}
  }
}

function forceFrom(req) {
  try {
    const value = new URL(req.url ?? '', 'http://localhost').searchParams.get('force')
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

/**
 * 注册版本路由；宿主没有 webServer 时只记一条 warn。
 *
 * @param {{ logger?: object, checkVersion?: (options: { force: boolean }) => Promise<object> }} [options]
 *   checkVersion 只给测试注入，缺省用 lib/update.js 的带缓存检查器
 */
export function registerVersionRoute(ctx, { logger, checkVersion = createVersionChecker() } = {}) {
  const mount = scoped => {
    const webServer = service(scoped, 'webServer', 'register') ?? service(ctx, 'webServer', 'register')
    if (!webServer) {
      logger?.warn?.('宿主没有可用的 webServer 服务，设置页无法检查插件更新（预设不受影响）')
      return
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: VERSION_PATH,
      handler: async (req, res) => {
        // connection 每次现取：它与 webServer 谁先挂上不确定。
        const rejection = requestRejection(req, service(ctx, 'connection', 'requestRejection'))
        if (rejection !== undefined) return json(res, rejection, { ok: false, reason: rejection === 401 ? 'unauthorized' : 'origin-not-trusted' })
        if (req.method !== 'GET') return json(res, 405, { ok: false, reason: 'method not allowed' })
        try {
          // 注册表都连不上也回 200：失败原因是给用户看的检查结果，不是路由出错。
          json(res, 200, await checkVersion({ force: forceFrom(req) }))
        } catch (error) {
          json(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-presets-zh: version route')
  }
  // webServer 通常比插件树晚挂上，直接读属性会拿到 undefined 而静默丢掉路由。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], mount)
      return
    } catch {}
  }
  mount(ctx)
}
