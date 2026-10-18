/**
 * 维护 wb2api 自己的 config.json 里本插件负责的那一项：`cn.chat_base`。
 *
 * 背景：wb2api 内置的国内版上游 copilot.tencent.com 对海外出口（Clash 全局 + TUN）
 * 的 TLS 握手直接复位，CN 模型目录与对话全部 EOF，网关只剩 global 模型且不报错。
 * 官方 WorkBuddy 桌面端已改用 https://www.workbuddy.cn，该域海外出口可达、接口同构。
 * 打过 cn.chat_base 补丁的 wb2api 读这一项覆盖内置 CN base；不认识这一项的老版本
 * 会直接忽略（Go 的 json.Unmarshal 跳过未知键），写进去不影响它启动。
 *
 * 只改这一项，其余内容原样保留；用户手填的非空值一律不覆盖。wb2api 生成默认配置时
 * 会把它写成空串（空 = 回落内置默认），所以"空串"按未设置处理。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 插件默认写入的国内版 chat base（与官方桌面端当前使用的域一致）。 */
export const DEFAULT_CN_CHAT_BASE = 'https://www.workbuddy.cn';

/**
 * 确保 config.json 的 `cn.chat_base` 为期望值。
 *
 * @param {string} path wb2api 的 config.json
 * @param {string} base 期望值；空串 = 插件不管这一项
 * @returns {{ state: 'disabled' | 'missing' | 'unchanged' | 'kept-user' | 'patched' | 'error', value?: string, reason?: string }}
 */
export function ensureCnChatBase(path, base) {
  if (!base) return { state: 'disabled' };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // 首次启动前 wb2api 还没生成 config.json：交给它先生成，启动后再补。
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  let config;
  try {
    // 记事本另存可能带 BOM，JSON.parse 不认。
    config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { state: 'error', reason: `config.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { state: 'error', reason: 'config.json 顶层不是对象' };
  }

  const cn = typeof config.cn === 'object' && config.cn !== null && !Array.isArray(config.cn) ? config.cn : undefined;
  const current = typeof cn?.chat_base === 'string' ? cn.chat_base.trim() : '';
  if (current === base) return { state: 'unchanged', value: current };
  if (current) return { state: 'kept-user', value: current };

  config.cn = { ...(cn ?? {}), chat_base: base };
  try {
    // 原子替换：写半截的 config.json 会让 wb2api 下次启动直接解析失败。
    // 0o600 与 wb2api 自己落盘的权限一致（里面有 api_key）。
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    return { state: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  return { state: 'patched', value: base };
}

/**
 * 给 ManagedService 的启动钩子：wb2api 只在启动时读 cn.chat_base，所以放在 spawn 之前写；
 * 首次启动前 config.json 还不存在（由 wb2api 自己生成），就在本次拉起成功后补上，
 * 下次启动后端时生效。
 *
 * @param {{ spec?: { cwd?: string }, cnChatBase: string }} resolved resolvePluginConfig 的结果
 * @param {{ info: Function, warn: Function }} logger
 * @param {string} [name] 日志前缀
 */
export function cnChatBaseHooks(resolved, logger, name = 'dsh-autostart-workbuddy') {
  const path = resolved.spec?.cwd ? join(resolved.spec.cwd, 'config.json') : '';
  let pendingFirstRun = false;
  const report = (result, afterStart) => {
    if (result.state === 'patched') {
      logger.info(
        `[${name}] 已把后端 config.json 的 cn.chat_base 设为 ${result.value}` +
          (afterStart ? '（下次启动后端时生效）' : ''),
      );
    } else if (result.state === 'kept-user') {
      logger.info(`[${name}] 后端 config.json 已手动设置 cn.chat_base=${result.value}，保持不变`);
    } else if (result.state === 'error') {
      logger.warn(`[${name}] 补写后端 cn.chat_base 失败：${result.reason}`);
    }
  };
  return {
    beforeSpawn() {
      if (!path) return;
      const result = ensureCnChatBase(path, resolved.cnChatBase);
      pendingFirstRun = result.state === 'missing';
      report(result, false);
    },
    afterStart() {
      if (!path || !pendingFirstRun) return;
      pendingFirstRun = false;
      report(ensureCnChatBase(path, resolved.cnChatBase), true);
    },
  };
}
