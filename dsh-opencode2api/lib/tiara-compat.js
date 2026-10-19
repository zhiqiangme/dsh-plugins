import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 上游 2.5 的流式分支遗漏 collected.error，会把上游拒绝误报为无内容的成功完成。 */
export function adaptTiaraSource(source) {
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
    "res.status(transformed.statusCode).set('Content-Type', 'application/json').json({ error: transformed.error });");
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
