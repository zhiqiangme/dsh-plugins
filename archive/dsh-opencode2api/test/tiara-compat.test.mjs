import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTiaraUpstreamError } from '../lib/tiara-compat.js';

test('上游出口限制保持真实原因，原始状态放响应元数据，DSH 不再误判本地认证失败', () => {
  const result = normalizeTiaraUpstreamError({ statusCode: 403, error: { type: 'permission_denied',
    message: "403: OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address." } });
  assert.equal(result.statusCode, 502);
  assert.equal(result.upstreamStatus, 403);
  assert.equal(result.error.code, 'upstream_network_blocked');
  assert.match(result.error.message, /本地 API 密钥有效/);
  assert.match(result.error.message, /abusive traffic from this IP/);
  assert.doesNotMatch(`${result.statusCode} ${result.error.message}`, /\b(?:401|403)\b/);
});

test('上游账号拒绝有独立分类；限流、超时和其他错误不受影响', () => {
  const auth = normalizeTiaraUpstreamError({ statusCode: 401, error: { type: 'invalid_api_key', message: '401 invalid upstream token' } });
  assert.equal(auth.statusCode, 502); assert.equal(auth.error.code, 'upstream_access_denied');
  for (const statusCode of [400, 402, 429, 500, 504]) {
    const result = { statusCode, error: { message: 'fixture' } };
    assert.equal(normalizeTiaraUpstreamError(result), result);
  }
});
