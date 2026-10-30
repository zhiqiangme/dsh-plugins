import { readFileSync } from 'node:fs'
import { PRESET } from './preset.js'

const snapshot = (file) => JSON.parse(readFileSync(new URL(`./presets/${file}.json`, import.meta.url), 'utf8'))

// 沿用本机测试预设的 id，已有对话仍能找到同一个组合；显示名称不再带“测试”。
export const MODES = [
  { key: 'minimalPrompt', definition: PRESET },
  { key: 'standard', definition: snapshot('standard') },
  { key: 'ptc', definition: snapshot('ptc') },
  { key: 'creation', definition: snapshot('creation') },
]

export function modeDefaults(definition) {
  return {
    enabled: true,
    name: definition.name,
    description: definition.description,
    prompt: definition.plugins.find(row => row.id === 'persona').config.prefix,
  }
}

/** 每次注册使用独立副本，配置与运行时不能改写其他预设或后续重载的快照。 */
export function configuredModes(config = {}) {
  return MODES.map(({ key, definition }) => {
    const defaults = modeDefaults(definition)
    const value = config[key]
    const raw = (typeof value?.get === 'function' ? value.get() : value) ?? {}
    const options = { ...defaults, ...raw }
    const preset = structuredClone(definition)
    preset.name = options.name?.trim() || defaults.name
    preset.description = typeof options.description === 'string' ? options.description : defaults.description
    preset.plugins.find(row => row.id === 'persona').config.prefix = options.prompt?.trim() || defaults.prompt
    return { key, enabled: options.enabled !== false, definition: preset }
  })
}
