/**
 * 测试共用：本地 mock Tavily、DSH 形状的请求体、随机空闲端口。
 *
 * 文件名不带 .test：`node --test test/*.test.mjs` 不会把它当用例执行。
 */
import { createServer } from 'node:http';

/** DSH 搜索提供方实际发出的请求体（结构取自 dsh-web-search-deepseek）。 */
export const dshBody = {
  model: 'deepseek-v4-flash',
  max_tokens: 4096,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: DeepSeek V4 发布时间' }] }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
};

/** 起一个 mock Tavily，按 scenario.handler 决定返回内容，收到的请求记在 scenario.requests。 */
export function startMockTavily(scenario) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      scenario.requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      scenario.handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export function okTavily(results) {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ query: 'q', results, response_time: 1.2 }));
  };
}

/** 拿一个当前空闲的端口（listen 0 再关掉）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function post(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'dummy', authorization: 'Bearer dummy', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** 收集日志而不是打到控制台，便于断言。 */
export function memoryLogger() {
  const lines = [];
  const push = (level) => (text) => lines.push({ level, text: String(text) });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}
