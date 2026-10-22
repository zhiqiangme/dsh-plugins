import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const PLUGIN_ID = 'dsh-magpie';
export const PACKAGE_NAME = '@zhiqiangme/dsh-magpie';
// Magpie 原生只维护 magpie、magpie-responses、magpie-anthropic；独立 ID 避免白名单被它回写。
export const PROVIDER_ID = 'dsh-magpie';
export const KEY_REF = 'DSH_MAGPIE_API_KEY';
export const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
export const DEFAULT_URL = 'http://127.0.0.1:3425';
export const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function gatewayURL(value = DEFAULT_URL) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('网关地址必须是 HTTP(S) 地址，不能包含账号、查询参数或片段');
  }
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function isLocal(url) {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

function text(value, label, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${label}必须是 1–${max} 个字符的文本`);
  }
  return value.trim();
}

function positive(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label}必须是正整数`);
  return n;
}

export function normalizeModel(raw) {
  const row = object(raw);
  const id = text(row.id, '模型 ID', 512);
  const name = text(row.name === '' ? undefined : row.name, '模型名称', 200, id);
  const contextWindow = positive(row.contextWindow, '上下文窗口');
  const maxTokens = positive(row.maxTokens, '最大输出');
  if (contextWindow && maxTokens && maxTokens >= contextWindow) throw new Error(`${id} 的最大输出必须小于上下文窗口`);
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error('模型勾选状态必须是布尔值');
  const input = row.input ?? ['text'];
  if (!Array.isArray(input) || !input.includes('text') || input.some((x) => !['text', 'image'].includes(x))) {
    throw new Error('输入能力必须包含 text，可选 image');
  }
  const efforts = row.reasoningEfforts ?? [];
  if (!Array.isArray(efforts) || efforts.some((x) => typeof x !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(x))) {
    throw new Error('思考档位必须是英文名称列表，例如 low、high、max');
  }
  return {
    id, name, enabled: row.enabled !== false,
    ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
    input: [...new Set(input)], reasoningEfforts: [...new Set(efforts)],
  };
}

/** 只在显式保存时校验，不从上游模型名猜能力；空清单和全部取消勾选都是合法状态。 */
export function resolveConfig(raw = {}) {
  const value = object(raw);
  const api = value.api ?? APIS[0];
  if (!APIS.includes(api)) throw new Error('不支持的 API 协议');
  if (value.syncEnabled !== undefined && typeof value.syncEnabled !== 'boolean') throw new Error('同步开关必须是布尔值');
  if (value.closeOnExit !== undefined && typeof value.closeOnExit !== 'boolean') throw new Error('退出时关闭 Magpie 开关必须是布尔值');
  if (!Array.isArray(value.models ?? []) || (value.models ?? []).length > 512) throw new Error('模型清单必须是数组，最多 512 项');
  const models = (value.models ?? []).map(normalizeModel);
  if (new Set(models.map((x) => x.id)).size !== models.length) throw new Error('模型 ID 不能重复');
  const magpiePath = value.magpiePath === undefined || value.magpiePath === '' ? '' : text(value.magpiePath, 'Magpie 程序路径', 1024);
  if (magpiePath && (!isAbsolute(magpiePath) || !/\.exe$/i.test(magpiePath))) throw new Error('Magpie 程序路径必须是 exe 文件的绝对路径');
  return { enabled: value.enabled !== false, baseURL: gatewayURL(value.baseURL), api, syncEnabled: value.syncEnabled === true, closeOnExit: value.closeOnExit === true, models, ...(magpiePath ? { magpiePath } : {}) };
}

export function revision(config) {
  return createHash('sha256').update(JSON.stringify(resolveConfig(config))).digest('hex');
}
