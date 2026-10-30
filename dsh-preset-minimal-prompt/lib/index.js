import { configuredModes } from './modes.js'
export { Config } from './config.js'

export const name = 'dsh-preset-minimal-prompt'
export const inject = ['agentPresets', 'loader']

/**
 * 判断 profile 里是否已经有同 id 的声明式预设。
 *
 * 用户可能在安装本插件前手动往 cordis.patch.yml 加过
 * `@deepseek-ai/dsh-agent-preset` 行。agent preset 注册表按 config.id
 * 去重，重复注册会让其中一份显示为加载失败，所以先检查 Loader 树：
 * 只要有未禁用的声明行，就把预设的所有权留给它。
 */
function hasDeclaredPreset(ctx, id) {
  if (typeof ctx.loader?.entries !== 'function') return false
  for (const entry of ctx.loader.entries()) {
    if (entry.disabled) continue
    const options = entry.options
    if (options?.name === '@deepseek-ai/dsh-agent-preset' && options?.config?.id === id) return true
  }
  return false
}

/**
 * 按四组独立配置注册预设；设置更新只替换有变化的定义，旧会话保留旧组合。
 *
 * 注册本身由 agentPresets 服务完成；它返回的 disposer 交给 ctx.effect，
 * 这样停用或卸载插件时，预设会从后续新会话的选择器里消失。已经存在的
 * 会话保留启动时的组合，不受影响。
 */
export async function apply(ctx, config = {}) {
  const owned = new Map()
  let closed = false
  let pending = Promise.resolve()
  const synchronize = () => {
    const modes = configuredModes(config)
    const task = pending.catch(() => {}).then(async () => {
      if (closed) return
      // 声明式行可能在本插件之后才加载；注册表也覆盖 entries() 看不到的声明。
      const existing = await ctx.agentPresets.list()
      for (const { enabled, definition } of modes) {
        if (closed) return
        const previous = owned.get(definition.id)
        const declared = hasDeclaredPreset(ctx, definition.id)
        const signature = JSON.stringify(definition)
        if (enabled && !declared && previous?.signature === signature) continue
        if (previous) {
          await previous.dispose()
          owned.delete(definition.id)
        }
        if (!enabled || closed) continue
        if (declared || (!previous && existing.some(preset => preset.id === definition.id))) {
          ctx.logger?.info?.(`agent preset ${definition.id} 已由其他配置提供，跳过自动注册`)
          continue
        }
        const dispose = await ctx.agentPresets.register(definition)
        owned.set(definition.id, { signature, dispose })
      }
    })
    pending = task
    return task
  }
  ctx.effect(() => async () => {
    closed = true
    await pending.catch(() => {})
    for (const record of owned.values()) await record.dispose()
    owned.clear()
  })
  ctx.on?.('loader/volatile-update', () => synchronize().catch(error => {
    ctx.logger?.error?.(`更新中文预设失败：${error.message}`)
  }))
  await synchronize()
}
