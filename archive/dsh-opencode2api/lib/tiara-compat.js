import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 本地鉴权与上游拒绝分开：DSH 将所有 401/403 都显示为“本地 API 密钥无效”并丢弃详情。 */
export function normalizeTiaraUpstreamError(transformed) {
  if (![401, 403].includes(transformed.statusCode)) return transformed;
  const message = String(transformed.error?.message || 'Upstream access denied');
  const networkBlocked = /free models aren't available from your current network|abusive traffic from this IP/i.test(message);
  const hint = networkBlocked
    ? 'OpenCode 上游限制了当前网络出口，免费模型暂不可用。本地 API 密钥有效。'
    : 'OpenCode 上游拒绝访问，请检查上游账号、凭据或网络限制。本地网关认证已通过。';
  return {
    statusCode: 502,
    upstreamStatus: transformed.statusCode,
    error: { ...transformed.error, type: 'upstream_error', code: networkBlocked ? 'upstream_network_blocked' : 'upstream_access_denied',
      // 宿主还会在整段错误文字里匹配数字状态码；原始状态保留在响应头，避免详情再次被隐藏。
      message: `${hint} ${message.replace(/\b(?:401|403)\b/g, 'access denied')}` },
  };
}

/** 上游 2.5 的流式分支遗漏 collected.error，会把上游拒绝误报为无内容的成功完成。 */
export function adaptTiaraSource(source) {
  source = `import { normalizeTiaraUpstreamError as dshUpstreamError } from ${JSON.stringify(import.meta.url)};\n${source}`;
  const anchor = '                        if (collected && collected.__error) {\n';
  if (!source.includes(anchor)) throw new Error('Tiara 流式兼容补丁不适用于此源码版本，请更新插件');
  source = source.replace(anchor, `                        if (collected?.error) {
                            const failure = new Error(collected.error.data?.message || collected.error.message || 'OpenCode upstream request failed');
                            failure.name = collected.error.name || 'UpstreamError';
                            failure.statusCode = collected.error.data?.statusCode || collected.error.statusCode || 502;
                            throw failure;
                        }
${anchor}`);
  const finalAnchor = '                        if (affinitySignal && !streamToolCallsSeen) {';
  if (!source.includes(finalAnchor)) throw new Error('Tiara 流式结束检查不适用于此源码版本，请更新插件');
  source = source.replace(finalAnchor, `                        if (!streamedContent.trim() && finalStreamedToolCalls.length === 0) {
                            throw new Error('OpenCode returned no answer content or tool calls. Check upstream connectivity and model availability.');
                        }
${finalAnchor}`);
  source = source.replaceAll("sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);",
    "throw Object.assign(new Error(error.data?.message || error.message || 'OpenCode upstream request failed'), { statusCode: error.data?.statusCode || error.statusCode || 502 });");
  source = source.replace('res.status(transformed.statusCode).json(transformed.error);',
    `const normalized = dshUpstreamError(transformed);
                        if (normalized.upstreamStatus) res.set('X-OpenCode-Upstream-Status', String(normalized.upstreamStatus));
                        res.status(normalized.statusCode).set('Content-Type', 'application/json').json({ error: normalized.error });`);
  source = source.replace('res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\\n\\n`);',
    'res.write(`data: ${JSON.stringify({ error: dshUpstreamError(transformUpstreamError(error)).error })}\\n\\n`);');
  return source;
}

export async function loadTiaraProxy(current) {
  const source = readFileSync(join(current, 'src', 'proxy.js'), 'utf8').replace(/\r\n/g, '\n');
  // 测试替身与未来已经修复的上游可直接加载；适配文件保留在同一目录以复用上游相对导入。
  if (!source.includes('const attemptError = collected?.error')) return import(pathToFileURL(join(current, 'src', 'proxy.js')).href);
  const file = join(current, 'src', 'dsh-proxy.js');
  writeFileSync(file, adaptTiaraSource(source));
  return import(pathToFileURL(file).href);
}
