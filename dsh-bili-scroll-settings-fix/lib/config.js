/**
 * DSH exposes volatile fields as live references. Upstream 0.1.7 rejects these
 * objects during normalization and replaces explicitly saved settings with
 * defaults. Read each reference on access, so native settings updates remain
 * visible without restarting the plugin or taking a stale startup snapshot.
 */
export function liveConfigValues(config = {}) {
  const source = config ?? {};
  // An empty target also supports frozen host properties: a Proxy may not
  // substitute values for non-configurable, non-writable target properties.
  return new Proxy({}, {
    get(_target, key) {
      const value = Reflect.get(source, key, source);
      return value !== null && typeof value === 'object' && typeof value.get === 'function'
        ? value.get()
        : value;
    },
    ownKeys: () => Reflect.ownKeys(source),
    getOwnPropertyDescriptor: (_target, key) => Reflect.has(source, key)
      ? { enumerable: true, configurable: true }
      : undefined,
  });
}
