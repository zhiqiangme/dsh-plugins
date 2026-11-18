import { credential } from './models.js';

export const SEARCH_PROVIDER_ID = 'dsh-magpie-search';
const SEARCH_PATH = '/mcp/magpie/web-search';
const SEARCH_TIMEOUT_MS = 120_000;
// Magpie 的搜索 API 最多支持 20 条。DSH 未给数量时使用 Magpie 自己的设置。
const MAX_RESULTS = 20;

function searchResult(text, count) {
  // Magpie 的搜索 API 将结果排成「序号. 标题 — URL」，摘要紧跟在标题下面。
  const headings = [...text.matchAll(/^[ \t]*\d+\.[ \t]+([^\r\n]*) — (https?:\/\/\S+)[ \t]*$/gim)];
  if (!headings.length) {
    // 代搜模型也可能直接返回带引用的回答，交给 DSH 的自由文本结果字段。
    return { ...(text ? { content: text } : {}), sources: [], truncated: false };
  }
  const sources = [], seen = new Set();
  for (const [index, heading] of headings.entries()) {
    const url = URL.parse(heading[2]);
    if (!url || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    const title = heading[1].trim();
    const snippet = text.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim();
    sources.push({ url: url.href, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return { sources: sources.slice(0, count), truncated: sources.length > count };
}

export function createMagpieSearchProvider(manager) {
  return {
    id: SEARCH_PROVIDER_ID,
    title: 'Magpie',
    description: {
      zh: '使用 Magpie 网关中配置的搜索 API 或代搜供应商。',
      en: 'Use the search APIs or search providers configured in your Magpie gateway.',
    },
    available: () => !manager.disposed && manager.current().enabled,
    async search(request, signal) {
      const query = typeof request?.query === 'string' ? request.query.trim() : '';
      if (!query) throw new Error('请输入搜索关键词');
      const { baseURL, enabled } = manager.current();
      if (!enabled || manager.disposed) throw new Error('Magpie 插件已停用');
      const cancel = AbortSignal.any([manager.searchAbort.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      cancel.throwIfAborted();
      const key = await credential(manager.credentials, manager.env, baseURL);
      if (!key) throw new Error('请先在 Magpie 插件「连接」中保存远程网关 Key');
      cancel.throwIfAborted();
      const { maxResults } = request;
      const count = Number.isSafeInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, MAX_RESULTS) : undefined;
      let response;
      try {
        // Magpie 内置搜索 MCP 是无状态 JSON 接口，每次搜索只需要一次 tools/call。
        response = await manager.fetch(baseURL + SEARCH_PATH, {
          method: 'POST', redirect: 'error', signal: cancel,
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'deepseek-harness/dsh-magpie-search' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query, count } } }),
        });
      } catch {
        if (signal?.aborted || manager.searchAbort.signal.aborted) cancel.throwIfAborted();
        throw new Error(cancel.aborted ? '等待 Magpie 联网搜索超时' : '无法连接 Magpie 搜索接口，请检查网关是否运行');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404) throw new Error('Magpie 网关未提供搜索 MCP 接口，请检查网关地址和版本');
        if ([401, 403].includes(response.status)) throw new Error('Magpie 网关拒绝搜索请求，请检查网关 Key 和 MCP 权限');
        throw new Error('Magpie 搜索接口返回 HTTP ' + response.status);
      }
      let payload;
      try { payload = await response.json(); }
      catch {
        if (signal?.aborted || manager.searchAbort.signal.aborted) cancel.throwIfAborted();
        throw new Error(cancel.aborted ? '等待 Magpie 联网搜索超时' : 'Magpie 搜索接口返回了无效的 JSON');
      }
      const result = payload?.result;
      if (payload?.jsonrpc !== '2.0' || payload.id !== 1 || (payload.error == null && !Array.isArray(result?.content))) {
        throw new Error('Magpie 搜索接口返回了无效的 MCP 结果');
      }
      const blocks = Array.isArray(result?.content) ? result.content : [];
      const text = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n\n').trim();
      if (payload.error || result?.isError) {
        // Magpie 把搜索 API 未找到结果也作为工具错误返回。只在所有原因都是空结果时当作正常空结果。
        const causes = text.replace(/^magpie couldn't search the web: /, '').split(/\r?\n/);
        if (!payload.error && causes.every((cause) => /^.+ found nothing$/.test(cause))) return { sources: [], truncated: false };
        throw new Error('Magpie 搜索失败，请检查 Magpie「设置 → 模型 → 联网搜索」中的搜索来源、权限和额度');
      }
      return searchResult(text, count ?? MAX_RESULTS);
    },
  };
}
