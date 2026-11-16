// Magpie 可以先返回 200 / SSE 心跳，再长时间等待上游。看到响应头或空的 role 帧不代表模型已开始回答。
// 先保留少量前导帧，等到真正的文本、推理、工具调用或完整结束帧再交给 DSH，失败时才还能安全换出口。
const MAX_PREFIX_BYTES = 1024 * 1024;
const ERROR_STATUS = new Map([
  ['invalid_request_error', 400], ['invalid_request', 400], ['authentication_error', 401], ['invalid_api_key', 401],
  ['permission_error', 403], ['permission_denied', 403], ['not_found_error', 404], ['insufficient_quota', 402],
  ['rate_limit_error', 429], ['rate_limit_exceeded', 429], ['overloaded_error', 503], ['server_error', 500],
  ['api_error', 500], ['timeout_error', 408],
]);

const BALANCE_CODES = new Set(['insufficient_balance', 'insufficient_funds', 'insufficient_credit', 'insufficient_credits',
  'insufficient_quota', 'balance_insufficient', 'balance_not_enough', 'not_enough_credits', 'credits_exhausted', 'out_of_credits']);

/** 只检查错误字段，不搜索正常回答内容；不同渠道可能用 400、403 或 200 承载余额不足。 */
export function isInsufficientBalance(value) {
  if (value && typeof value === 'object') {
    if ([value.code, value.type, value.error_code, value.errorCode].some((code) => typeof code === 'string' && BALANCE_CODES.has(code.toLowerCase()))) return true;
    return [value.message, value.msg, value.detail, value.description, value.error_description, value.reason, value.error]
      .some(isInsufficientBalance);
  }
  if (typeof value !== 'string') return false;
  return BALANCE_CODES.has(value.trim().toLowerCase())
    || /(?:余额|餘額|积分|積分|额度|額度|点数|點數)\s*(?:不足|不够|不夠|已用完|已耗尽|已耗盡|已用尽|已用盡)/.test(value)
    || /\b(?:insufficient|not enough|out of|no remaining|no available)\s+(?:account\s+)?(?:balance|funds|credits?)\b/i.test(value)
    || /\b(?:balance|funds|credits?)\b[^\n.]{0,48}\b(?:insufficient|exhausted|depleted|too low)\b/i.test(value);
}

export function errorStatus(event, value) {
  const explicit = event === 'error' || value?.type === 'error' || value?.type === 'response.failed' || Boolean(value?.error);
  const error = value?.error ?? value?.response?.error ?? value;
  // 402 仅作为内部选路分类；转发给 DSH 时仍保留上游状态码和错误正文。
  if ((explicit || (!value?.choices && !value?.output && !value?.content)) && isInsufficientBalance(error)) return 402;
  if (!explicit) return undefined;
  for (const raw of [error?.status, error?.status_code, error?.code, value?.status, value?.status_code]) {
    const status = Number(raw);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  for (const key of [error?.type, error?.code, value?.code]) if (ERROR_STATUS.has(key)) return ERROR_STATUS.get(key);
  return 502;
}

/** HTTP 200 的 JSON 也可能装着上游错误；完整读取后仍按原字节转发，不让失败被当作成功。 */
export async function prepareJSON(upstream) {
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const value = JSON.parse(new TextDecoder().decode(bytes));
  return { body: [bytes], status: errorStatus('', value), cancel: async () => {} };
}

/** HTTP 错误也需要读正文：普通 400 原样返回，只有明确余额不足才允许换出口。 */
export async function prepareErrorResponse(upstream) {
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const raw = new TextDecoder().decode(bytes);
  let value;
  try { value = JSON.parse(raw); }
  catch { value = raw; }
  return { body: [bytes], status: isInsufficientBalance(value) ? 402 : upstream.status, cancel: async () => {} };
}

const text = (value) => typeof value === 'string' && value.length > 0;
function useful(value) {
  for (const choice of value?.choices ?? []) {
    const delta = choice?.delta ?? choice?.message ?? {};
    if ([choice?.text, delta.content, delta.reasoning_content, delta.reasoning, delta.thinking, delta.refusal].some(text)
      || delta.tool_calls?.length || delta.function_call?.name || text(delta.function_call?.arguments)
      || choice?.finish_reason != null) return true;
  }
  const type = value?.type ?? '';
  if (/^response\.(?:output_text|reasoning_text|reasoning_summary_text|function_call_arguments|refusal)\.delta$/.test(type) && text(value.delta)) return true;
  if (type === 'response.output_item.added' && value.item?.type === 'function_call') return true;
  if (type === 'content_block_start') {
    const block = value.content_block;
    if (block?.type === 'tool_use' || text(block?.text) || text(block?.thinking)) return true;
  }
  if (type === 'content_block_delta' && [value.delta?.text, value.delta?.thinking, value.delta?.partial_json].some(text)) return true;
  // 合法的空回答也可能通过结束原因完成；单独的 [DONE] 和心跳不算一次有效回答。
  return ['response.completed', 'response.incomplete', 'message_stop'].includes(type)
    || (type === 'message_delta' && value.delta?.stop_reason != null);
}

class SSEState {
  decoder = new TextDecoder();
  pending = '';
  data = [];
  event = '';
  ready = false;
  status;
  ended = false;
  dataLength = 0;
  push(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    // 转发开始后仍需观察错误帧，单个异常事件也不能无限占用内存。
    if (this.pending.length + this.dataLength > MAX_PREFIX_BYTES) throw new Error('Magpie stream event is too large');
    let newline;
    // 保留块末尾的 CR，以免跨网络块的 CRLF 被当成两个换行。
    while ((newline = /\r\n|\n|\r(?!$)/.exec(this.pending))) {
      const line = this.pending.slice(0, newline.index);
      this.pending = this.pending.slice(newline.index + newline[0].length);
      if (!line) {
        const data = this.data.join('\n');
        if (data === '[DONE]') this.ended = true;
        else if (data || this.event === 'error') {
          let value;
          try { value = JSON.parse(data); }
          catch { if (this.event === 'error') value = data; /* 未知心跳不代表模型输出。 */ }
          this.status ??= errorStatus(this.event, value);
          if (!this.status && useful(value)) this.ready = true;
        }
        this.data = []; this.event = ''; this.dataLength = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') { this.data.push(value); this.dataLength += value.length; }
        else if (field === 'event') this.event = value;
      }
    }
  }
}

/** 只在尚未交付任何输出时缓冲；返回后仍原样流式转发，并识别后续错误以便下一次请求避开失败出口。 */
export async function prepareSSE(upstream, { onError } = {}) {
  if (!upstream.body) throw new Error('Magpie returned an empty stream');
  const reader = upstream.body.getReader(), state = new SSEState(), prefix = [];
  let size = 0, closed = false;
  const cancel = async () => {
    if (closed) return;
    closed = true;
    try { await reader.cancel(); } catch { /* 上游可能已因取消或断连而关闭。 */ }
    finally { reader.releaseLock(); }
  };
  try {
    while (!state.ready && !state.status) {
      const next = await reader.read();
      if (next.done) throw new Error('Magpie stream ended before any model output');
      size += next.value.byteLength;
      // 限制未产生输出的前导帧内存占用；正常心跳和角色帧远小于 1 MiB。
      if (size > MAX_PREFIX_BYTES) throw new Error('Magpie stream prelude is too large');
      prefix.push(next.value); state.push(next.value);
      if (state.ended && !state.ready && !state.status) throw new Error('Magpie stream completed without model output');
    }
  } catch (error) { await cancel(); throw error; }
  const status = state.status;
  async function* body() {
    try {
      for (const chunk of prefix) yield chunk;
      if (status) return;
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        const previous = state.status;
        state.push(next.value);
        if (!previous && state.status) onError?.(state.status);
        yield next.value;
        if (state.status) return;
      }
    } catch (error) {
      // 在 pipeline 因上游断连销毁下游之前记录失败；下游关闭随后也会触发取消信号。
      onError?.(502);
      throw error;
    } finally { await cancel(); }
  }
  return { body: body(), status, cancel };
}
