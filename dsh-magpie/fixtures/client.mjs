import { readFileSync } from 'node:fs';

export function clientHarness(initial, fetchImpl = async () => { throw new Error('unexpected fetch'); }, { sessionStorage, sidebar = false, layout } = {}) {
  let registration, index = 0;
  const styleTags = [], states = [initial, false, false, null, '', ''], cards = [], dictionaries = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (fallback) => { const i = index++; if (!(i in states)) states[i] = fallback; return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: (fallback) => { const i = index++; if (!(i in states)) states[i] = { current: fallback }; return states[i]; },
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (callback) => callback,
  };
  const window = { sessionStorage, __ModuleLoader__: { load: (value) => { registration = value; } } };
  const document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: (node) => styleTags.push(node) } };
  new Function('window', 'document', 'fetch', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window, document, fetchImpl);
  const module = registration.factory((id) => { if (id === 'react') return React; throw new Error(`Unexpected dependency ${id}`); });
  const t = (key, values) => module.zh[key].replace(/\{(\w+)\}/g, (m, k) => values?.[k] ?? m);
  const ctx = {
    effect: (run) => run(),
    locale: { register: (_ns, dicts) => { dictionaries.push(dicts); }, bind: () => t },
    // 默认模拟没有侧栏页面的旧宿主；sidebar 为 true 时声明 sidebar.panellist 槽位。
    slots: { inject: (name, run) => { if (name !== 'sidebar.panellist' || sidebar) run(); }, register: (meta, component) => { const card = { meta, component, disposed: false }; cards.push(card); return () => { card.disposed = true; }; } },
    ...(layout ? { inject: (_names, run) => run({ layout, effect: (run) => run() }) } : {}),
  };
  module.apply(ctx);
  const render = () => { index = 0; return module.ModelsCard({ t }); };
  // 切换卡片标签页：标签状态保存在 states 中，之后的 render 都停留在该页。
  const tab = (label) => nodes(render(), (node) => node.props.role === 'tab' && node.children.includes(label))[0].props.onClick();
  return { module, registration, states, get styles() { return styleTags.map((node) => node.textContent); }, cards, dictionaries, render, tab };
}

export function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) for (const node of tree) nodes(node, predicate, found);
  else if (tree && typeof tree === 'object') { if (predicate(tree)) found.push(tree); nodes(tree.children, predicate, found); }
  return found;
}
export const button = (tree, label) => nodes(tree, (node) => node.type === 'button' && node.children.includes(label))[0];
export const field = (tree, label) => nodes(tree, (node) => node.type === 'label' && node.children[0] === label)[0]?.children[1];
// 设置行里的开关或分段选择按 aria-label 查找；choose 返回分段里指定选项的按钮。
export const control = (tree, label) => nodes(tree, (node) => node.props?.['aria-label'] === label)[0];
export const choose = (tree, label, option) => nodes(control(tree, label), (node) => node.type === 'button' && node.children.includes(option))[0];
