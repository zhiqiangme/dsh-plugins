/**
 * 测试用假服务：读环境变量决定行为，便于验证"就绪 / 提前退出 / 不监听 / 提供模型列表 /
 * 健康探针 / 假 GitHub Release"。
 *
 *   TEST_MODE   listen（默认，只监听 TCP）| exit（立刻退出，模拟启动失败）
 *               | panic（以 code 2 退出，但继承了 stderr 的孙进程在退出后还会再写一段）
 *               | http-models（HTTP 服务，GET /v1/models 返回模型列表）
 *               | http-empty（返回空列表，模拟上游故障时面板的降级行为）
 *               | http-error（返回 500）
 *               | http-health（后端健康探针：GET /healthz）
 *               | http-release（假 GitHub Release：releases/latest、commits/<tag>、资产下载）
 *   TEST_PORT   监听端口（缺省 0 = 随机端口，用于"永远不会就绪"的失败用例）
 *   TEST_MODELS_JSON  自定义 /v1/models 响应体（原始 JSON 文本）
 *   TEST_TOKEN  需要校验的 Bearer 令牌；给了就校验 Authorization 头
 *
 * http-release 专用：
 *   TEST_RELEASE_TAG           默认 v9.9.9
 *   TEST_RELEASE_COMMIT        默认 40 位假 sha（全 f）
 *   TEST_RELEASE_EXE_REVISION  包内 exe 自称的 revision（默认 = COMMIT；
 *                              设成别的值可模拟"资产与 tag 对不上"）
 *   TEST_RELEASE_BAD_CHECKSUM=1  故意给错的 sha256
 *   TEST_RELEASE_NO_CHECKSUMS=1  不提供 checksums.txt
 *   TEST_RELEASE_FAIL_DOWNLOAD=1 资产下载返回 500
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

if (mode === 'panic') {
  // 孙进程继承 stderr，在本进程退出后才写：父进程先收到 'exit'，stderr 却还开着、之后还有数据。
  // 只靠本进程多写一些测不出来——Windows 下管道写是同步的，退出前数据已被读走，时序不可控；
  // 孙进程持有句柄则稳定复现（后端派生辅助进程时就是这种形态）。
  // detached 必须开：Windows 下 libuv 把子进程放进"父进程退出即全杀"的 Job，不脱离就跟着本进程一起死。
  // 输出不带换行：-e 的代码经命令行传递，转义序列容易被改写。
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, ['-e', "setTimeout(() => process.stderr.write('late stderr END!!'), 300)"], {
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
    windowsHide: true,
  });
  process.stderr.write('panic: boom\n');
  process.exit(2);
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

/** 假 GitHub Release：release 元数据、commit 解析、资产下载都塞进一个服务器。 */
async function startFakeRelease() {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { buildZip } = await import('./zip-builder.mjs');

  const tag = process.env.TEST_RELEASE_TAG || 'v9.9.9';
  const commit = process.env.TEST_RELEASE_COMMIT || 'f'.repeat(40);
  const exeRevision = process.env.TEST_RELEASE_EXE_REVISION || commit;
  const assetName = `wb2api-panel-${tag}-windows-amd64.zip`;

  const exe = Buffer.from(
    `MZ fake wb2api\nvcs.revision=${exeRevision}\nvcs.time=2026-10-09T00:00:00Z\nvcs.modified=false\n`,
    'utf8',
  );
  const zip = buildZip([
    { name: 'wb2api.exe', data: exe, method: 8 },
    { name: 'config.example.json', data: Buffer.from('{}'), method: 8 },
    { name: 'README.md', data: Buffer.from('# fake panel'), method: 8 },
  ]);
  const realSha = createHash('sha256').update(zip).digest('hex');
  const servedSha = process.env.TEST_RELEASE_BAD_CHECKSUM === '1' ? 'a'.repeat(64) : realSha;
  const checksums = `${servedSha}  ${assetName}\n`;

  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = req.url ?? '/';
    const json = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    if (url.endsWith('/releases/latest')) {
      const assets = [
        { name: assetName, size: zip.length, browser_download_url: `${origin}/assets/${assetName}` },
        { name: `wb2api-panel-${tag}-linux-amd64.tar.gz`, size: 11, browser_download_url: `${origin}/assets/linux` },
      ];
      if (process.env.TEST_RELEASE_NO_CHECKSUMS !== '1') {
        assets.push({
          name: 'checksums.txt',
          size: checksums.length,
          browser_download_url: `${origin}/assets/checksums.txt`,
        });
      }
      json(200, {
        tag_name: tag,
        published_at: '2026-10-09T00:00:00Z',
        target_commitish: 'main',
        body: '假 release',
        assets,
      });
      return;
    }

    if (url.includes('/commits/')) {
      json(200, { sha: commit });
      return;
    }

    if (url === `/assets/${assetName}`) {
      if (process.env.TEST_RELEASE_FAIL_DOWNLOAD === '1') {
        json(500, { error: 'boom' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
      res.end(zip);
      return;
    }

    if (url === '/assets/checksums.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(checksums),
      });
      res.end(checksums);
      return;
    }

    json(404, { error: 'not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`dummy http listening ${server.address().port}\n`);
  });
}

/** 后端健康探针：/healthz 返回 workbuddy2api 的固定形状。 */
async function startFakeHealth() {
  const { createServer } = await import('node:http');
  const healthy = Number(process.env.TEST_HEALTHY ?? 3);
  // 上游在账号池无可用账号时回 503（刚装好、还没登录账号就是这样）；TEST_HEALTH_SERVICE 可换掉身份字段。
  const status = healthy > 0 ? 200 : 503;
  const service = process.env.TEST_HEALTH_SERVICE ?? 'workbuddy2api';
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/healthz')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const body = JSON.stringify({ healthy, total: healthy, service });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`dummy http listening ${server.address().port}\n`);
  });
}

if (mode === 'http-release') {
  await startFakeRelease();
} else if (mode === 'http-health') {
  await startFakeHealth();
} else if (mode.startsWith('http-')) {
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
} else if (mode !== 'panic') {
  // panic 不监听：它只等 stderr 写完就退出，监听了反而会被当成"启动成功"。
  const { createServer } = await import('node:net');
  const server = createServer(() => {});
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`dummy listening ${server.address().port}\n`);
  });
}
