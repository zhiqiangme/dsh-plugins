import z from '@deepseek-ai/schemastery'
import { MODES, modeDefaults } from './modes.js'

export const Config = z.object(Object.fromEntries(MODES.map(({ key, definition }) => {
  const defaults = modeDefaults(definition)
  return [key, z.object({
    enabled: z.boolean().default(true).description('启用此模式'),
    name: z.string().default(defaults.name).description('显示名称'),
    description: z.string().default(defaults.description).description('模式描述'),
    prompt: z.string().role('textarea').default(defaults.prompt).description('系统提示词；留空使用默认内容'),
  }).description(definition.name).default({}).volatile()]
})))
