/**
 * hub 首次启动前，将 wb2api 的授权转换为独立的 hub 账号文件。
 * 只迁移一次、只创建缺失账号；完成标记留在 data/，更新程序不会丢失，删除账号后也不会自动复活。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REALM_MARKERS = {
  cn: ['copilot.tencent.com', 'codebuddy.cn', 'workbuddy.cn'],
  intl: ['workbuddy.ai', 'codebuddy.ai'],
};
const DEFAULT_DOMAINS = { cn: 'copilot.tencent.com', intl: 'www.workbuddy.ai' };
const NON_ACCOUNT_FILES = new Set(['settings.json', 'active_realm.json', 'model.json', 'model_windows.json', 'quota_scan.json']);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uidOf = (value) => ['string', 'number'].includes(typeof value)
  ? String(value).trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') : '';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function claimsOf(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return object(claims) ? claims : {};
  } catch { return {}; }
}

function realmOf(value) {
  const lower = text(value).toLowerCase();
  return Object.keys(REALM_MARKERS).find((realm) => REALM_MARKERS[realm].some((marker) => lower.includes(marker)));
}

/** 与 hub 的 normalise_import_row 对齐：issuer 优先于旧 domain，global 转为 intl，毫秒转秒。 */
function convertAccount(row) {
  if (!object(row?.account) || !object(row?.auth)) return null;
  const { account, auth } = row;
  const accessToken = text(auth.accessToken);
  if (accessToken.split('.').length !== 3) return null;
  const claims = claimsOf(accessToken);
  const uid = uidOf(account.uid || claims.sub);
  // 防止凭证文件冒充 hub 设置文件，或使用 Windows 设备名；文件名不能来自原始 uid。
  if (!uid || NON_ACCOUNT_FILES.has(`${uid.toLowerCase()}.json`) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(uid)) return null;
  const hint = text(auth.realm).toLowerCase();
  const realm = realmOf(claims.iss) || realmOf(auth.domain) || (hint === 'cn' ? 'cn' : 'intl');
  const domain = text(auth.domain);
  const other = realm === 'cn' ? 'intl' : 'cn';
  const rawExpiry = Number(auth.expiresAt);
  const expiresAt = Number.isFinite(rawExpiry) ? Math.trunc(rawExpiry > 1e11 ? rawExpiry / 1000 : rawExpiry) : 0;
  return {
    uid, nickname: text(account.nickname), enterpriseId: text(account.enterpriseId),
    realm, domain: domain && !REALM_MARKERS[other].some((marker) => domain.toLowerCase().includes(marker)) ? domain : DEFAULT_DOMAINS[realm],
    accessToken, refreshToken: text(auth.refreshToken),
    // 过期 accessToken 仍可随 refreshToken 导入，由 hub 自己刷新；迁移不访问上游。
    expiresAt: expiresAt || Number(claims.exp) || 0,
    platform: 'CLI', source: 'wb2api-import', enabled: true,
  };
}

/** 先完整写临时文件，再用不覆盖目标的硬链接发布，避免半截 JSON 或并发覆盖已有凭证。 */
function createJson(path, value) {
  const temp = join(dirname(path), `.wb2api-import-${randomBytes(12).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, path); }
    catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    return true;
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* 临时文件不是 .json，hub 不会加载。 */ }
  }
}

function sourceDirectory(paths) {
  try {
    const config = readJson(paths.plugin.config);
    if (text(config?.auth_dir)) return resolve(paths.plugin.current, config.auth_dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return join(paths.plugin.data, 'auths');
}

/** 仅返回计数及固定错误码；JSON 解析错误的 message 可能包含令牌，不能写进日志。 */
export function importWb2apiAccounts(paths) {
  const counts = { imported: 0, skipped: 0, invalid: 0 };
  if (existsSync(paths.accountsImportFile)) return { state: 'already-imported', ...counts };
  try {
    let sourceFiles;
    const source = sourceDirectory(paths);
    try { sourceFiles = readdirSync(source, { withFileTypes: true }); }
    catch (error) {
      // 没装过 wb2api 时不提前记完成，之后首次有授权时仍可导入。
      if (error?.code === 'ENOENT') return { state: 'no-source', ...counts };
      throw error;
    }
    mkdirSync(paths.accounts, { recursive: true });
    const existing = new Set();
    for (const file of readdirSync(paths.accounts, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json') || NON_ACCOUNT_FILES.has(file.name.toLowerCase())) continue;
      const row = readJson(join(paths.accounts, file.name));
      const uid = uidOf(row?.uid || claimsOf(text(row?.accessToken)).sub);
      if (uid) existing.add(uid);
    }
    for (const file of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      let row;
      try { row = convertAccount(readJson(join(source, file.name))); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (!row) { counts.invalid++; continue; }
      if (existing.has(row.uid)) { counts.skipped++; continue; }
      const created = createJson(join(paths.accounts, `${row.uid}.json`), row);
      if (created) counts.imported++;
      else counts.skipped++;
      existing.add(row.uid);
    }
    mkdirSync(paths.data, { recursive: true });
    createJson(paths.accountsImportFile, { version: 1, completedAt: new Date().toISOString(), ...counts });
    return { state: 'completed', ...counts };
  } catch (error) {
    return { state: 'error', ...counts, reason: error instanceof SyntaxError ? 'INVALID_JSON' : error?.code || 'IMPORT_FAILED' };
  }
}
