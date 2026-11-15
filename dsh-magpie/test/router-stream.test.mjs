import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSSE } from '../lib/router-stream.js';

function upstream(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
}
async function collect(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('跨字节分块的中文、CRLF 和多行 data 能识别，并逐字节保留原始事件', async () => {
  const raw = ': heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(raw);
  const prepared = await prepareSSE(upstream([...bytes].map((byte) => Uint8Array.of(byte))));
  assert.equal(prepared.status, undefined);
  assert.equal(await collect(prepared.body), raw);
});

test('错误和输出在同一网络块内时仍可以在交付前识别，返回结构化状态', async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\nevent: error\ndata: {"error":{"status_code":429}}\n\n';
  const prepared = await prepareSSE(upstream([Buffer.from(raw)]));
  assert.equal(prepared.status, 429);
  await prepared.cancel();
});

for (const value of [
  { type: 'response.output_item.added', item: { type: 'function_call', name: 'run' } },
  { type: 'content_block_start', content_block: { type: 'tool_use', name: 'run' } },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]) test(`工具调用或合法空回答结束帧 ${value.type ?? 'finish_reason'} 算有效输出`, async () => {
  const raw = `data: ${JSON.stringify(value)}\n\n`;
  const prepared = await prepareSSE(upstream([Buffer.from(raw)]));
  assert.equal(prepared.status, undefined);
  assert.equal(await collect(prepared.body), raw);
});

test('异常前导帧有内存上限，超过上限就失败并取消读取', async () => {
  await assert.rejects(prepareSSE(upstream([Buffer.alloc(1024 * 1024 + 1, 32)])), /prelude is too large/);
});
