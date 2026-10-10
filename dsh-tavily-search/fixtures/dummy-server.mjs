/**
 * 测试用假服务：读环境变量决定行为，便于验证"就绪 / 提前退出 / 不监听"三种情况。
 *
 *   TEST_PORT  监听端口（缺省 0 = 随机端口，用于"永远不会就绪"的失败用例）
 *   TEST_MODE  listen（默认）| exit（立刻退出，模拟启动失败）
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

const { createServer } = await import('node:net');
const server = createServer(() => {});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`dummy listening ${server.address().port}\n`);
});
