/**
 * 测试用 configEditor 替身，契约对齐 @deepseek-ai/dsh-config-editor：
 *
 *   - entries()：profile 顶层可编辑的 Loader 条目，形如 { options: { id, name, config } }；
 *   - edit(entry, change)：把 change(当前 config, 继承层 config) 的结果作为该条目的新 config，
 *     并像真实 Loader 一样把新 config 交给该条目插件的 internal/update（通过 onUpdate 挂钩）；
 *   - documentPath：写入的 profile 文件路径（只用于展示）。
 *
 * 放在 fixtures/ 而不是 test/ 下：node --test 会把 test/ 下的 .mjs 都当测试文件执行。
 */
export function createFakeConfigEditor(rows, { documentPath = 'C:\\fake\\profile\\cordis.patch.yml' } = {}) {
  const entries = rows.map((row) => ({
    options: { id: row.id, name: row.name ?? row.id, config: structuredClone(row.config ?? {}) },
    updateHooks: [],
  }));
  const edits = [];

  return {
    documentPath,
    edits,
    entries: () => entries,
    entry: (id) => entries.find((entry) => entry.options.id === id),
    /** 真实宿主里，配置变更经 Loader → fiber.update → internal/update 送到插件。 */
    onUpdate(id, hook) {
      this.entry(id).updateHooks.push(hook);
    },
    /** 设成 Error 时 edit 直接抛（模拟校验失败 / 条目被替换）。 */
    failWith: undefined,
    async edit(entry, change) {
      if (this.failWith) throw this.failWith;
      if (!entries.includes(entry)) throw new Error('Configuration entry is no longer available');
      const next = change(structuredClone(entry.options.config), {});
      entry.options.config = structuredClone(next);
      edits.push({ id: entry.options.id, config: structuredClone(next) });
      for (const hook of entry.updateHooks) hook(structuredClone(next));
    },
  };
}

/** 与真实 profile 同构的 llm-pi-ai 配置：openrouter 一个、opencode2api 一个过期条目。 */
export function llmPiAiConfig({ withProvider = true } = {}) {
  const providers = {
    openrouter: {
      displayName: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1/',
      models: [{ id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' }],
    },
  };
  if (withProvider) {
    providers.opencode2api = {
      displayName: 'OpenCode',
      apiKeyEnv: 'OPENCODE2API_PROXY_KEY',
      baseURL: 'http://127.0.0.1:8080/v1/',
      api: 'openai-completions',
      models: [{ id: 'cn:stale', name: '过期条目' }],
    };
  }
  return { providers };
}

/** 一份最小 profile：llm-pi-ai + 本插件两行。 */
export function profileRows({ withProvider = true, models = { enabled: true } } = {}) {
  return [
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: llmPiAiConfig({ withProvider }) },
    { id: 'dsh-autostart-opencode2api', name: 'dsh-autostart-opencode2api', config: { models } },
  ];
}
