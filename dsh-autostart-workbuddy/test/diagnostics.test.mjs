import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diagnose, redactReport } from '../lib/diagnostics.js';
import { resolvePluginConfig } from '../lib/config.js';

test('诊断报告递归脱敏令牌、账号、邮箱、用户目录与已知密钥', () => {
  const report = redactReport({ token: 'secret', errors: ['Bearer abc123 token="private" account=u123 a@b.com C:\\Users\\Name\\log sk-value'] }, ['sk-value'], 'C:\\Users\\Name');
  const text = JSON.stringify(report);
  for (const secret of ['abc123', 'private', 'u123', 'a@b.com', 'C:\\\\Users\\\\Name', 'sk-value']) assert.ok(!text.includes(secret), secret);
  assert.equal(report.token, '[redacted]');
  assert.match(text, /<home>/);
});

test('一键诊断只读探测并区分网络、账号、密钥问题，报告不泄露环境与 stderr 的密钥', async (t) => {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.writeHead(401); res.end('invalid key'); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const key = 'private-gateway-key';
  const resolved = resolvePluginConfig({ models: { baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: key } }, {});
  const report = await diagnose({
    resolved, env: { GH_TOKEN: 'private-github-token' }, service: { recentStderr: [`TLS EOF ${key} private-github-token`] },
    driver: { title: 'fixture', probe: async () => ({ ok: true, servable: false, healthy: 0, total: 2 }) },
  });
  assert.deepEqual(hits, ['/v1/models']);
  assert.ok(report.suggestions.some((text) => text.includes('没有可用账号')));
  assert.ok(report.suggestions.some((text) => text.includes('鉴权失败')));
  assert.ok(report.suggestions.some((text) => text.includes('TLS')));
  assert.ok(!JSON.stringify(report).includes(key));
  assert.ok(!JSON.stringify(report).includes('private-github-token'));
});
