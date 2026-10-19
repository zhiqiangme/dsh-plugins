/** 诊断只做探测，不改配置、不发送对话；报告在离开宿主前统一脱敏。 */
import { homedir } from 'node:os';
import { gatewayDriver } from './gateway.js';
import { fetchModels, resolveModelApiKey, providerKeyRef, findConfigEntry, LLM_PI_AI_PACKAGE } from './models.js';
import { isFile, probeTcp } from './services.js';
import { healthTarget } from './resync.js';

export function redactReport(value, secrets = [], home = homedir()) {
  const redact = (text) => {
    let out = text;
    for (const secret of secrets.filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length)) out = out.replaceAll(secret, '[redacted]');
    if (home) for (const path of new Set([home, home.replaceAll('\\', '/')])) out = out.replaceAll(path, '<home>');
    return out.replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
      .replace(/(["']?(?:api[_-]?key|password|access_token|refresh_token|token|secret|cookie|uid|account)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]');
  };
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactReport(item, secrets, home));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:apiKey|token|password|secret|authorization|cookie)$/i.test(key) ? '[redacted]' : redactReport(item, secrets, home)]));
  return value;
}

export async function diagnose({ resolved, service, recovery, editor, credentials, env = process.env, driver = gatewayDriver(resolved), tcp = probeTcp }) {
  const models = resolved.models;
  const apiKey = await resolveModelApiKey(models, env, credentials);
  const secrets = [apiKey, ...Object.entries({ ...env, ...resolved.spec.env }).filter(([key]) => /key|token|password|secret|cookie/i.test(key)).map(([, value]) => value)];
  const checks = [{ id: 'executable', ok: isFile(resolved.spec.exe), detail: resolved.spec.exe }];
  const target = healthTarget(models.baseURL, resolved.spec);
  const [listening, health, catalog] = await Promise.all([
    tcp(target.port, target.host),
    driver.probe({ ...target, timeoutMs: 5000 }),
    fetchModels({ baseURL: models.baseURL, apiKey, timeoutMs: 5000 }),
  ]);
  checks.push({ id: 'port', ok: listening, detail: `${target.host}:${target.port}` });
  checks.push({ id: 'gateway', ok: health.ok, detail: health.ok ? driver.title : health.reason });
  checks.push({ id: 'accounts', ok: health.servable === true, detail: { ready: health.healthy ?? null, total: health.total ?? null } });
  checks.push({ id: 'models', ok: catalog.ok, detail: catalog.ok ? { count: catalog.models.length, realm: catalog.realm } : catalog.reason });
  const entry = findConfigEntry(editor, { name: LLM_PI_AI_PACKAGE });
  const ref = providerKeyRef(entry?.options?.config, models.provider);
  if (ref && typeof credentials?.resolve === 'function') {
    try {
      const value = await credentials.resolve(ref);
      const stored = typeof value === 'string' ? value : value?.value;
      secrets.push(stored);
      checks.push({ id: 'credential', ok: Boolean(stored) && (!apiKey || stored === apiKey), detail: ref });
    } catch { checks.push({ id: 'credential', ok: false, detail: ref }); }
  }
  const errors = service?.recentStderr?.slice(-20) ?? [];
  const suggestions = [];
  if (!listening) suggestions.push('后端端口未监听，请检查程序路径，或点击重试启动');
  if (listening && !health.ok) suggestions.push('端口上的服务身份或健康状态不正确，请检查端口占用');
  if (health.ok && !health.servable) suggestions.push('没有可用账号，请到后端面板登录、导入或检查账号状态');
  if (!catalog.ok && /401|403/.test(catalog.reason)) suggestions.push('模型接口鉴权失败，请核对网关密钥和 DSH 凭据');
  if (checks.some((row) => row.id === 'credential' && !row.ok)) suggestions.push('DSH 凭据与插件使用的网关密钥不一致，请核对凭据库');
  if (/TLS|EOF|certificate|ECONNRESET/i.test(errors.join('\n'))) suggestions.push('日志包含网络或 TLS 错误，请检查代理出口与国内上游地址');
  return redactReport({ at: new Date().toISOString(), gateway: resolved.gateway, checks, recovery: recovery?.status, recentErrors: errors, suggestions }, secrets, env.USERPROFILE || env.HOME || homedir());
}
