/** 首次安装只创建自己的配置；更新、回滚和用户已有配置均不覆盖。 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readBackendConfig(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function initialAdminPath(paths) {
  return join(paths.data, 'initial-admin.json');
}

export function ensureBackendConfig(paths, spec) {
  if (existsSync(paths.config)) return { created: false };
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  const adminFile = initialAdminPath(paths);
  let admin = readBackendConfig(adminFile);
  if (!admin?.password || !admin?.username) {
    admin = { username: 'admin', password: randomBytes(24).toString('base64url') };
    writeFileSync(adminFile, JSON.stringify(admin, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const config = {
    listen: `${spec?.host ?? '127.0.0.1'}:${spec?.port ?? 8080}`,
    server_keys: [`dsh-${randomBytes(32).toString('base64url')}`],
    zen_keys: [], go_keys: [], anonymous: true, proxies: ['direct'],
    models: { refresh_seconds: 300 },
    logging: { level: 'info', dump_request_bodies: false },
    webui: { enabled: true, listen: '127.0.0.1:8081', ...admin },
  };
  writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { created: true };
}

export function backendApiKey(path) {
  const keys = readBackendConfig(path)?.server_keys;
  if (!Array.isArray(keys)) return '';
  for (const entry of keys) {
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
    if (entry?.enabled !== false && typeof entry?.key === 'string' && entry.key.trim()) return entry.key.trim();
  }
  return '';
}

/** 后端首次启动会把明文密码迁移成哈希，卡片只能提供保存的初始密码。 */
export function initialAdmin(paths) {
  return readBackendConfig(initialAdminPath(paths));
}
