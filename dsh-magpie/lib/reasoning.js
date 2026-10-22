import { PROVIDER_ID } from './config.js';
import { hostService } from './runtime.js';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function highestEffort(efforts = []) {
  const offered = new Set(efforts);
  return [...LEVELS].reverse().find((level) => offered.has(level)) ?? efforts.at(-1);
}

export function highestDefault(info) {
  if (info.provider !== PROVIDER_ID) return info;
  const level = highestEffort(info.reasoning?.efforts?.map((effort) => effort.id) ?? []);
  return level === undefined ? info : { ...info, reasoning: { ...info.reasoning, defaultEffort: level } };
}

function defaultOptions(options, info) {
  const level = info.reasoning?.defaultEffort;
  return options.provider !== PROVIDER_ID || options.reasoningEffort !== undefined || level === undefined
    ? options : { ...options, reasoningEffort: level };
}

/**
 * 当前 llm-pi-ai 的 schema 只有 provider.reasoning，没有逐模型默认值。
 * 沿用宿主已注册适配器的 resolveModel / prepareCall / stream 契约，在本插件路由上补默认值：
 * 不更换路由或模型 ID，不复制协议实现，也不修改宿主安装文件。其它路由及显式档位原样透传。
 * prepared 调用用该次快照的能力选择默认值，避免配置热更新后把新档位塞给旧调用。
 */
export function decorateAdapter(adapter) {
  const original = Object.fromEntries(['resolveModel', 'prepareCall', 'stream'].map((name) => [name, adapter[name]]));
  if (Object.values(original).some((value) => typeof value !== 'function')) throw new Error('宿主适配器缺少逐模型默认档位所需的接口');
  const descriptors = Object.fromEntries(Object.keys(original).map((name) => [name, Object.getOwnPropertyDescriptor(adapter, name)]));
  let active = true;
  const wrapped = {
    async resolveModel(...args) { const info = await original.resolveModel.apply(this, args); return active ? highestDefault(info) : info; },
    async prepareCall(provider, ...args) {
      const prepared = await original.prepareCall.call(this, provider, ...args);
      if (!active || provider !== PROVIDER_ID) return prepared;
      const model = highestDefault(prepared.model);
      return { ...prepared, model, stream: (options) => prepared.stream(active ? defaultOptions(options, model) : options) };
    },
    async *stream(options) {
      const selected = active && options.provider === PROVIDER_ID && options.reasoningEffort === undefined
        ? defaultOptions(options, await this.resolveModel(options.provider, options.model, options.signal)) : options;
      yield* original.stream.call(this, selected);
    },
  };
  const restore = () => {
    active = false;
    // 其它插件若在之后包裹了接口，不能把它的包裹层一并覆盖掉。
    for (const name of Object.keys(original)) if (adapter[name] === wrapped[name]) {
      if (descriptors[name]) Object.defineProperty(adapter, name, descriptors[name]);
      else delete adapter[name];
    }
  };
  try { for (const [name, method] of Object.entries(wrapped)) adapter[name] = method; }
  catch (error) { restore(); throw error; }
  return restore;
}

/** 跟随 llm-pi-ai 的注册/重载，卸载时恢复接口；不向用户其它 provider 注入默认值。 */
export function registerHighestReasoning(ctx) {
  const mount = (scope = ctx) => {
    const llm = hostService(scope, 'llm', (value) => typeof value?.registration === 'function');
    if (!llm) return;
    const restorers = new Map();
    const attach = () => {
      let adapter;
      try { adapter = llm.registration(PROVIDER_ID).adapter; }
      catch { return; } // 空清单或关闭同步时，路由还不存在。
      if (restorers.has(adapter)) return;
      try { restorers.set(adapter, decorateAdapter(adapter)); }
      catch (error) { (ctx.logger ?? console).warn(`[dsh-magpie] ${error.message}`); }
    };
    const off = scope.on?.('llm/adapters-updated', attach);
    scope.effect(() => {
      attach();
      if (restorers.size) llm.emitAdaptersUpdated?.();
      return () => { if (typeof off === 'function') off(); for (const restore of [...restorers.values()].reverse()) restore(); llm.emitAdaptersUpdated?.(); };
    }, 'dsh-magpie: per-model reasoning defaults');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['llm'], mount);
  else mount(ctx);
}
