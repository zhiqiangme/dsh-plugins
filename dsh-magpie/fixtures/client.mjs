import { readFileSync } from 'node:fs';

export function clientHarness(initial, fetchImpl = async () => { throw new Error('unexpected fetch'); }, { sessionStorage } = {}) {
  let registration, index = 0;
  const styleTags = [], states = [initial, false, false, null, '', ''], cards = [], dictionaries = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (fallback) => { const i = index++; if (!(i in states)) states[i] = fallback; return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: (fallback) => { const i = index++; if (!(i in states)) states[i] = { current: fallback }; return states[i]; },
    useEffect() {},
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
    slots: { inject: (_name, run) => run(), register: (meta, component) => { cards.push({ meta, component }); } },
  };
  module.apply(ctx);
  return { module, registration, states, get styles() { return styleTags.map((node) => node.textContent); }, cards, dictionaries, render: () => { index = 0; return module.ModelsCard({ t }); } };
}

export function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) for (const node of tree) nodes(node, predicate, found);
  else if (tree && typeof tree === 'object') { if (predicate(tree)) found.push(tree); nodes(tree.children, predicate, found); }
  return found;
}
export const button = (tree, label) => nodes(tree, (node) => node.type === 'button' && node.children.includes(label))[0];
export const field = (tree, label) => nodes(tree, (node) => node.type === 'label' && node.children[0] === label)[0]?.children[1];
