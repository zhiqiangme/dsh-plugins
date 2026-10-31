import { PRESET } from './preset.js'
import { registerVersionRoute } from './web.js'

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
function hasDeclaredPreset(ctx) {
  if (typeof ctx.loader?.entries !== 'function') return false
  for (const entry of ctx.loader.entries()) {
    if (entry.disabled) continue
    const options = entry.options
    if (options?.name === '@deepseek-ai/dsh-agent-preset' && options?.config?.id === PRESET.id) return true
  }
  return false
}

/**
 * 插件加载时自动注册「极简提示词」。
 *
 * 注册本身由 agentPresets 服务完成；它返回的 disposer 交给 ctx.effect，
 * 这样停用或卸载插件时，预设会从后续新会话的选择器里消失。已经存在的
 * 会话保留启动时的组合，不受影响。
 */
export async function apply(ctx) {
  // 插件页“插件更新”卡片的版本检查；与预设注册互不影响，先于下面的提前返回挂上。
  registerVersionRoute(ctx, { logger: ctx.logger })
  if (hasDeclaredPreset(ctx)) {
    ctx.logger?.info?.(`agent preset ${PRESET.id} 已由 profile 声明，跳过自动注册`)
    return
  }

  // 声明式行可能在本插件之后才加载；再查一次注册表，覆盖 entries() 看不到的嵌套声明。
  const existing = await ctx.agentPresets.list()
  if (existing.some((preset) => preset.id === PRESET.id)) {
    ctx.logger?.info?.(`agent preset ${PRESET.id} 已存在，跳过自动注册`)
    return
  }

  const dispose = await ctx.agentPresets.register(PRESET)
  ctx.effect(() => dispose)
}
