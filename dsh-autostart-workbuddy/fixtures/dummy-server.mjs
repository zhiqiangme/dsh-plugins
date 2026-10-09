/**
 * 测试用假服务：读环境变量决定行为，便于验证"就绪 / 提前退出 / 不监听 / 提供模型列表"。
 *
 *   TEST_MODE   listen（默认，只监听 TCP）| exit（立刻退出，模拟启动失败）
 *               | http-models（HTTP 服务，GET /v1/models 返回模型列表）
 *               | http-empty（返回空列表，模拟上游故障时面板的降级行为）
 *               | http-error（返回 500）
 *   TEST_PORT   监听端口（缺省 0 = 随机端口，用于"永远不会就绪"的失败用例）
 *   TEST_MODELS_JSON  自定义 /v1/models 响应体（原始 JSON 文本）
 *   TEST_TOKEN  需要校验的 Bearer 令牌；给了就校验 Authorization 头
 *
 * 注意：本文件放在 fixtures/ 而不是 test/ 下。Node 的测试运行器会把 test 目录下的
 * 所有 .mjs 全部当成测试文件收集，若放在 test/ 里，它会被当作一个用例执行，
 * 而一个正在 listen 的服务器会永远保持事件循环，导致整轮测试挂死。
 */
const mode = process.env.TEST_MODE || 'listen';
const port = Number(process.env.TEST_PORT || 0);

if (mode === 'exit') {
  process.stderr.write('dummy: 故意启动失败\n');
  process.exit(3);
}

/** 默认模型清单：两个域各一条，字段与 wb2api 真实返回对齐。 */
const DEFAULT_MODELS = {
  object: 'list',
  data: [
    {
      id: 'cn:alpha',
      name: 'Alpha',
      credits: 'x0.11',
      context_length: 1000000,
      max_output_tokens: 393216,
      supports_images: true,
      supports_reasoning: true,
      reasoning_supported_efforts: ['low', 'high', 'max'],
    },
    {
      id: 'global:beta',
      name: 'Beta',
      credits: 'x0.00',
      context_length: 200000,
      max_output_tokens: 64000,
      supports_images: false,
      supports_reasoning: true,
      reasoning_supported_efforts: ['high'],
    },
  ],
};

if (mode.startsWith('http-')) {
  const { createServer } = await import('node:http');
  const body = process.env.TEST_MODELS_JSON ?? JSON.stringify(DEFAULT_MODELS);

  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/v1/models')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (mode === 'http-error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    if (process.env.TEST_TOKEN && req.headers.authorization !== `Bearer ${process.env.TEST_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(mode === 'http-empty' ? '{"object":"list","data":[]}' : body);
  });

  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`dummy http listening ${server.address().port}\n`);
  });
} else {
  const { createServer } = await import('node:net');
  const server = createServer(() => {});
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`dummy listening ${server.address().port}\n`);
  });
}
