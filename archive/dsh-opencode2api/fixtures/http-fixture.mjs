import { createServer } from 'node:http';
export async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
export const catalog = [
  { id: 'vision-free', name: 'Vision', context_window: 200000, max_output: 32000,
    supports_reasoning: true, reasoning_efforts: ['low', 'high'], cost: { input: 0, output: 0 },
    native_protocol: 'responses', metadata: { input_modalities: ['text', 'image'] } },
  { id: 'text-model', cost: { input: 0.2, output: 0.8 }, metadata: { context_window: 100000, max_output: 8192, reasoning: false } },
  { id: 'decision-only', native_protocol: 'systemone', supported_endpoints: ['/v1/systemone'] },
];
export function memoryCredentials() {
  const values = new Map();
  // 与 DSH 宿主凭据服务同形：resolve 返回 { value, source }，未配置时为 undefined。
  const writes = [];
  return { values, writes, resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
    describe: async () => ({ writable: true }),
    set: async (ref, value) => { writes.push(ref); values.set(ref, value); } };
}
