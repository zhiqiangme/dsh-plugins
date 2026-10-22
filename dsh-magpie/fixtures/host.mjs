import { KEY_REF, PACKAGE_NAME, PLUGIN_ID } from '../lib/config.js';

export function fakeHost(config = {}, llmConfig = { providers: { magpie: { models: [{ id: 'native' }] }, unrelated: { models: [{ id: 'keep' }] } } }) {
  const own = { options: { id: PLUGIN_ID, name: PACKAGE_NAME, config: structuredClone(config) } };
  const llm = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: structuredClone(llmConfig) } };
  const edits = [], hooks = [], effects = [], routes = [], keys = new Map();
  const credentials = {
    resolve: async (ref) => keys.has(ref) ? { value: keys.get(ref), source: 'file' } : undefined,
    describe: async () => ({ writable: true }),
    set: async (ref, value) => { keys.set(ref, value); },
  };
  const editor = {
    entries: () => [own, llm],
    async edit(entry, change) {
      const next = change(structuredClone(entry.options.config), {});
      entry.options.config = structuredClone(next);
      edits.push(entry.options.id);
      if (entry === own) for (const hook of hooks) hook(next, false, () => { throw new Error('不应重启插件'); });
    },
  };
  const services = { configEditor: editor, credentials, webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } };
  const ctx = {
    get: (name) => services[name],
    on: (_event, hook) => { hooks.push(hook); return () => hooks.splice(hooks.indexOf(hook), 1); },
    effect: (run) => { const off = run(); if (typeof off === 'function') effects.push(off); },
    logger: { info() {}, warn() {}, error() {} },
    async dispose() { for (const off of effects.reverse()) await off(); },
  };
  return { ctx, services, editor, own, llm, keys, edits, hooks, routes, KEY_REF };
}
