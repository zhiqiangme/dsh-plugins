import { readFileSync } from 'node:fs'

const snapshot = (file) => JSON.parse(readFileSync(new URL(`./presets/${file}.json`, import.meta.url), 'utf8'))

// id 为内置模式 id 加 -zh 后缀；已发布后不可再改，否则已有对话找不到对应预设。
export const MODES = [
  { key: 'standard', definition: snapshot('standard') },
  { key: 'ptc', definition: snapshot('ptc') },
  { key: 'minimal', definition: snapshot('minimal') },
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
