/**
 * DSH 插件卡片的同源数据接口：后端管理、模型勾选、初始管理密码与插件版本。
 * 模型写入使用宿主 configEditor；密码只在显式 POST 时返回，不进入状态接口。
 */

import { isDeepStrictEqual } from 'node:util';

import { autoUpdateStatus } from './auto-update.js';
import { GATEWAY_IDS, gatewayDriver } from './gateway.js';
import { priceLabel, modelMetadata, fetchModels, findConfigEntry, modelDisplayName, panelApiKey, resolveCredential, syncModels } from './models.js';
import { initialAdmin } from './backend-config.js';
import { isFile } from './services.js';
import { createVersionChecker } from './update.js';
import { backendLockHolder, createBackendOperations } from './backend-operation.js';

/** 插件名：与 package.json / cordis.patch.yml 里的 name 保持一致。 */
const PLUGIN_ID = 'dsh-opencode2api';

/** 面板路由前缀：DSH 给每个插件留的命名空间，浏览器半侧用同一份常量。 */
export const PANEL_BASE = `/plugins/${PLUGIN_ID}`;

/** 模型清单与勾选结果的读写端点（GET 读 / POST 写）。 */
export const MODELS_PATH = `${PANEL_BASE}/models`;

/** 后端版本与更新端点（GET 读状态 / POST 执行 check|update|rollback|autoUpdate…）。 */
export const BACKEND_PATH = `${PANEL_BASE}/backend`;

/** 本插件自身的版本检查端点：当前运行版本 vs npm latest（?force=1 绕过缓存）。与后端 opencode2api 的版本无关。 */
export const VERSION_PATH = `${PANEL_BASE}/version`;

/** 初始管理密码只由显式 POST 返回，不放进普通状态应答。 */
export const PANEL_KEY_PATH = `${PANEL_BASE}/panel-key`;

/** 模型区的失败状态：插件自管的后端还没装。浏览器半侧据此显示"去点安装"，而不是裸的 fetch failed。 */
export const BACKEND_NOT_INSTALLED = 'backend-not-installed';

/** 请求体上限：白名单最多几十个 id，64KB 足够，防止有人往 loopback 路由灌大包。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 统一的 JSON 应答。 */
export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 面板路由的准入检查：返回拒绝用的 HTTP 状态码，放行返回 undefined。
 *
 * 宿主 webServer 本身不鉴权，插件路由默认对任何连得上端口的请求开放。有 connection 服务时
 * 沿用宿主 /api 与 open-in-app 的同一道关：Host/Origin 校验（防 DNS 重绑定与跨站）加浏览器会话
 * Cookie（桌面端由 Electron 转发请求时附上）。没有 connection 的旧组合退回本地规则：对端必须是
 * 回环地址，带 Origin 时必须与 Host 同源——只放行"任意 loopback 来源"会让本机其他端口的网页也能调。
 */
export function requestRejection(req, connection) {
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req);
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 403;
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return 403;
  const origin = req.headers?.origin;
  if (origin === undefined) return undefined;
  try {
    return new URL(origin).host === req.headers?.host ? undefined : 403;
  } catch {
    return 403;
  }
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return plain === '::1' || plain.startsWith('127.');
}

/** POST 只收 JSON：text/plain 之类的"简单请求"跨源时不触发 CORS 预检，只能在服务端拒掉。 */
export function isJsonRequest(req) {
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/** 读 POST 的 JSON 体；任何形状问题都返回 ok:false 而不是抛。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, reason: `请求体超过 ${MAX_BODY_BYTES} 字节` };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return { ok: false, reason: '请求体为空' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: '请求体不是合法 JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: '请求体不是对象' };
  }
  return { ok: true, value };
}

/** 取网关密钥：显式配置 → 环境变量 → 面板自己的 config.json。 */
function resolveApiKey(models, env) {
  if (models.apiKey) return models.apiKey;
  const ref = models.apiKeyRef || 'OPENCODE2API_PROXY_KEY';
  const fromEnv = typeof env[ref] === 'string' ? env[ref].trim() : '';
  return fromEnv || panelApiKey(models.panelConfig);
}

/** 后端把管理密码迁移为哈希后，仍可提供插件最初生成的管理密码。 */
export function readPanelKey(resolved) {
  const paths = resolved?.backend?.paths ?? resolved?.paths;
  if (resolved?.gateway === 'tiara') {
    const key = resolved.models?.apiKey || resolved.spec?.env?.DSH_TIARA_API_KEY || panelApiKey(paths?.config);
    return key ? { ok: true, gateway: 'tiara', key } : { ok: false, reason: 'Tiara 尚未安装或未配置 API_KEY' };
  }
  const admin = paths ? initialAdmin(paths) : null;
  if (!admin?.password) return { ok: false, reason: '没有插件生成的初始管理密码，请使用你为后端设置的用户名和密码。' };
  return { ok: true, key: admin.password, username: admin.username };
}

function positiveIntOrNull(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * GET 的应答体：后端全量模型 + 当前白名单。
 *
 * 返回后端**全部**模型（而不是白名单里那些）：面板要能勾上还没进列表的模型，
 * 所以这里不能用 planModelEntries（那是"按白名单过滤后写进 profile"的逻辑）。
 *
 * 白名单为空 = 同步后端全部模型（既有语义），此时所有条目都标记为已选。
 *
 * `models` 是插件手里的当前配置（随配置变更就地刷新，见 index.js），`patchPath` 只用来
 * 告诉用户写到了哪个文件。
 */
export async function describeModels({ spec, models, editor, credentials, env = process.env, managedExe }) {
  const patchPath = editor?.documentPath;
  const only = models.only ?? [];
  const enabled = models.enabled;

  const fetched = await fetchModels({
    baseURL: models.baseURL || `http://${spec.host}:${spec.port}`,
    apiKey: resolveApiKey(models, env) || await resolveCredential(credentials, models.apiKeyRef || 'OPENCODE2API_PROXY_KEY'),
    timeoutMs: models.timeoutMs,
  });
  if (!fetched.ok) {
    // 只在拉取失败后才看 exe 在不在：端口上若是用户另起的后端、拉取成功，就照常显示，不误报未安装。
    if (managedExe === true && !isFile(spec.entryPoint || spec.exe)) {
      return {
        ok: false,
        state: BACKEND_NOT_INSTALLED,
        reason: '后端还没有安装，请点下方「后端版本」里的「安装」，装好后模型列表会自动刷新。',
        patchPath, enabled, only,
      };
    }
    return { ok: false, reason: fetched.reason, patchPath, enabled, only };
  }

  const selected = new Set(only);
  const rows = fetched.models.map((model) => ({
    id: model.id,
    label: modelDisplayName(model),
    credits: priceLabel(model),
    contextWindow: modelMetadata(model).contextWindow ?? null,
    maxTokens: modelMetadata(model).maxTokens ?? null,
    vision: modelMetadata(model).vision,
    selected: only.length === 0 ? true : selected.has(model.id),
  }));

  return {
    ok: true,
    url: fetched.url,
    patchPath,
    enabled,
    provider: models.provider,
    only,
    models: rows,
  };
}

/**
 * POST 的处理：写同步开关与白名单 → 开启时立即重新同步 provider 的模型清单。
 *
 * 两步都做是刻意的：只写白名单要等下次 DSH 启动才见效，用户点完"保存"看不到变化；
 * 顺手同步一次，DSH 的模型选择器马上就是新清单（llm-pi-ai 那一行被热重载）。
 *
 * 白名单写的是本插件自己那一行：configEditor 改完会触发本插件的 internal/update，
 * index.js 的钩子只就地刷新 models，不重启插件（重启会把托管的 opencode2api 一起停掉）。
 *
 * @param {{ resolved: object, editor?: object, env?: object, only?: unknown, enabled?: boolean }} options
 *   省略 `only` 表示沿用现有白名单（装好后端后只打开同步开关时用，不能把用户勾选清空）。
 *   `resolved` 是插件手里那份配置对象；钩子会就地换掉它的 models，这里也同步刷新一次，
 *   宿主没有转发 internal/update 时（测试、旧版本）保存结果照样立即可见。
 */
export async function applySelection({ resolved, editor, credentials, env = process.env, only, enabled }) {
  const keepOnly = only === undefined && enabled !== undefined;
  if (!keepOnly && (!Array.isArray(only) || only.some((id) => typeof id !== 'string'))) {
    return { ok: false, reason: 'only 必须是字符串数组' };
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { ok: false, reason: 'enabled 必须是布尔值' };
  }
  if (typeof editor?.edit !== 'function') {
    return { ok: false, reason: '宿主没有 configEditor 服务，无法保存白名单' };
  }
  const entry = findConfigEntry(editor, { id: PLUGIN_ID });
  if (!entry) return { ok: false, reason: `DSH 里没有可编辑的 ${PLUGIN_ID} 条目` };

  const patchPath = editor.documentPath;
  const currentModels = entry.options?.config?.models;
  const keptOnly = Array.isArray(currentModels?.only) ? currentModels.only : (resolved.models?.only ?? []);
  const ids = (only ?? keptOnly).map((id) => String(id).trim()).filter(Boolean);
  // 旧客户端只发送 only；省略 enabled 时保留原开关，不能把旧请求当作开启或关闭同步。
  const enabledPatch = enabled === undefined ? {} : { enabled };
  const changed = !isDeepStrictEqual(currentModels?.only, ids) ||
    (enabled !== undefined && currentModels?.enabled !== enabled);

  if (changed) {
    try {
      await editor.edit(entry, (current) => {
        const config = plainObject(current);
        return { ...config, models: { ...plainObject(config.models), ...enabledPatch, only: ids } };
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), patchPath };
    }
  }
  resolved.models = { ...resolved.models, ...enabledPatch, only: ids };

  const synced = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env });
  return {
    ok: true,
    patchPath,
    changed,
    enabled: resolved.models.enabled,
    only: ids,
    sync: {
      state: synced.state,
      count: Array.isArray(synced.entries) ? synced.entries.length : undefined,
      reason: synced.reason,
      created: synced.created,
    },
  };
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * 后端版本端点。
 *
 * GET 默认**不联网**（首屏要快，GitHub 也可能慢甚至不通），带 `?check=1` 才真去查 release。
 * 修改动作创建后台任务并返回 202，GET 恢复进度和最终结果；同一时刻只允许一个任务，
 * 且与自动更新共用 backend-operation.js 的目录锁（后台正在自动下载时答 409 并说明原因）。
 * gateway、autoUpdate 两个动作只写配置，不进任务队列。
 */
async function handleBackend(req, res, { resolved, env, editor, operations, autoUpdater }) {
  const paths = resolved.backend?.paths ?? resolved.paths;
  const apiBase = resolved.backend?.apiBase || undefined;
  // 面板地址由服务规格推出来（端口可被 profile 覆盖），浏览器半侧拿它渲染可点击链接。
  const panelUrl = resolved.panelUrl || 'http://127.0.0.1:8081/';
  const driver = gatewayDriver(resolved);
  const snapshot = () => ({
    ...driver.describe(paths),
    gateway: driver.id,
    gateways: [...GATEWAY_IDS],
    panelUrl,
    autoUpdate: autoUpdateStatus(resolved),
  });

  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('check') !== '1' || resolved.backend?.enabled === false) {
      json(res, 200, { ok: true, backend: snapshot(), operation: operations.current, check: null });
      return;
    }
    try {
      const check = await driver.check({
        paths,
        env,
        apiBase,
        ttlMs: resolved.backend.checkTtlMs,
        force: true,
      });
      json(res, 200, { ok: true, backend: snapshot(), check });
    } catch (error) {
      // 查不到更新不是错误：面板照常显示本地版本，把原因放在 check.error 里
      json(res, 200, {
        ok: true,
        backend: snapshot(),
        check: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { ok: false, reason: 'method not allowed' });
    return;
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    json(res, 400, { ok: false, reason: body.reason });
    return;
  }
  const action = typeof body.value.action === 'string' ? body.value.action : '';

  if (action === 'gateway') {
    // 后台自动下载只写 cache/ 里的暂存文件，不碰正在跑的程序：切网关重启插件时它随旧实例中断，不必等它下完。
    const holder = backendLockHolder();
    const busy = operations.busy || (Boolean(holder) && holder !== 'auto-prepare');
    const result = await selectGateway({ resolved, editor, gateway: body.value.gateway, busy });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  if (action === 'autoUpdate') {
    const result = await setAutoUpdate({ resolved, editor, enabled: body.value.enabled });
    // 刚打开就查一轮，不用等下一次定时；下载可能要几十秒，不等它，结果从后续快照里看。
    if (result.ok && result.enabled) autoUpdater?.tick();
    json(res, result.ok ? 200 : 400, { ...result, backend: snapshot() });
    return;
  }

  if (action === 'check') {
    const check = await driver.check({
      paths,
      env,
      apiBase,
      ttlMs: resolved.backend?.checkTtlMs,
      force: true,
    });
    json(res, 200, { ok: true, check, backend: snapshot() });
    return;
  }

  // 会改动磁盘的动作都由 operations 串行执行；卸载与清除数据要求显式二次确认。
  const MUTATING_ACTIONS = new Set(['install', 'update', 'rollback', 'uninstall', 'purge', 'start']);

  if (MUTATING_ACTIONS.has(action) && resolved.managedExe === false) {
    json(res, 400, { ok: false, reason: '自定义 exe 不由插件管理版本，请在外部维护该后端。' });
    return;
  }

  if (!MUTATING_ACTIONS.has(action)) {
    json(res, 400, { ok: false, reason: `不认识的动作：${action || '(空)'}` });
    return;
  }

  if ((action === 'uninstall' || action === 'purge') && body.value.confirm !== true) {
    json(res, 400, { ok: false, reason: `${action === 'purge' ? '彻底卸载' : '卸载'}需要二次确认（confirm: true）` });
    return;
  }

  const result = operations.start(action);
  json(res, result.ok ? 202 : 409, { ...result, backend: snapshot() });
}

/**
 * 面板的「自动更新」开关：写本插件那一行的 `config.backend.autoUpdate`（保留 backend 的其它字段）。
 *
 * 写完宿主会触发 internal/update，index.js 的钩子把它当就地生效的字段处理，不重启插件；
 * 这里也同步改一次手里的 resolved，宿主没转发 internal/update 时（测试、旧版本）同样立即生效。
 */
export async function setAutoUpdate({ resolved, editor, enabled }) {
  if (typeof enabled !== 'boolean') return { ok: false, reason: 'enabled 必须是布尔值' };
  if (typeof editor?.edit !== 'function') return { ok: false, reason: '宿主没有 configEditor 服务，无法保存自动更新设置' };
  const entry = findConfigEntry(editor, { id: PLUGIN_ID });
  if (!entry) return { ok: false, reason: `DSH 里没有可编辑的 ${PLUGIN_ID} 条目` };
  try {
    await editor.edit(entry, (current) => {
      const config = plainObject(current);
      return { ...config, backend: { ...plainObject(config.backend), autoUpdate: enabled } };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (resolved.backend) resolved.backend.autoUpdate = enabled;
  return { ok: true, enabled };
}

/** gateway 变更交给宿主重启；旧后端先停止，两套后端不同时占用同一 API 端口。 */
export async function selectGateway({ resolved, editor, gateway, busy = false }) {
  if (!GATEWAY_IDS.includes(gateway)) {
    return { ok: false, reason: `gateway 只能是 ${GATEWAY_IDS.join(' / ')}` };
  }
  if (gateway === resolved.gateway) return { ok: true, state: 'unchanged', gateway };
  if (busy) return { ok: false, reason: '后端正在安装或更新，完成后再切换' };
  if (typeof editor?.edit !== 'function') return { ok: false, reason: '宿主没有 configEditor 服务，无法保存网关选择' };
  const entry = findConfigEntry(editor, { id: PLUGIN_ID });
  if (!entry) return { ok: false, reason: `DSH 里没有可编辑的 ${PLUGIN_ID} 条目` };
  try {
    await editor.edit(entry, (current) => ({ ...plainObject(current), gateway }));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, state: 'switched', gateway, previous: resolved.gateway, restarting: true };
}

/**
 * 取宿主 webserver 服务。
 *
 * 不写进 `inject`：本插件的核心职责（拉起后端）不依赖任何 Host Service，
 * 不该因为 webServer / configEditor 缺席而整个插件不激活——只影响面板与模型同步。
 *
 * @param {string} name 服务名
 * @param {(candidate: unknown) => boolean} usable 判断拿到的东西能不能用
 */
export function hostService(ctx, name, usable) {
  const candidates = [];
  try {
    candidates.push(ctx?.[name]);
  } catch {
    /* 服务未就绪时读属性可能抛，忽略 */
  }
  try {
    if (typeof ctx?.get === 'function') candidates.push(ctx.get(name));
  } catch {
    /* 同上 */
  }
  return candidates.find(usable);
}

/** 宿主的 configEditor（DSH 设置页用的同一个写配置入口）；每次用时现取，拿不到返回 undefined。 */
export function configEditorOf(ctx) {
  return hostService(ctx, 'configEditor', (candidate) => typeof candidate?.edit === 'function');
}

/** 宿主的 connection 服务（浏览器会话鉴权）；拿不到时 guard 退回本地规则。 */
export function connectionOf(ctx) {
  return hostService(ctx, 'connection', (candidate) => typeof candidate?.requestRejection === 'function');
}

export function credentialsOf(ctx) {
  return hostService(ctx, 'credentials', (candidate) => typeof candidate?.resolve === 'function');
}

/** `?force=1` / `?force=true` 视为强制刷新；其它值（含缺省）走缓存。 */
function forceFrom(req) {
  try {
    const value = new URL(req.url ?? '', 'http://localhost').searchParams.get('force');
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/**
 * 注册面板路由；宿主没有 webServer 时只记一条 warn。
 *
 * checkVersion 只给测试注入，缺省用 lib/update.js 的带缓存检查器。
 * autoUpdater 与入口处的定时检查共用：面板打开「自动更新」时立即查一轮。
 */
export function registerPanelRoutes(ctx, { logger, resolved, env = process.env, service, autoUpdater, checkVersion = createVersionChecker() }) {
  const paths = resolved.backend?.paths ?? resolved.paths;
  const driver = gatewayDriver(resolved);
  const operations = createBackendOperations({ paths, gateway: driver.id, logger, run: async (action, control) => {
    const options = { paths, env, apiBase: resolved.backend?.apiBase || undefined, service, logger,
      keepVersions: resolved.backend?.keepVersions, ...control };
    let result;
    if (action === 'start') {
      control.onProgress({ stage: 'startup', detail: '正在启动后端并初始化模型目录' });
      const started = await service.ensureRunning(control.signal);
      result = { ok: started.state !== 'failed', ...started };
    } else result = await driver[action](options);
    if (result.ok && (action === 'install' || action === 'start')) {
      control.onProgress({ stage: 'sync', detail: '后端已启动，正在同步 DSH 模型列表' });
      const selection = await applySelection({ resolved, editor: configEditorOf(ctx), credentials: credentialsOf(ctx), env, enabled: true });
      result = { ...result, sync: selection.sync ?? { state: 'failed', reason: selection.reason } };
    }
    return result;
  } });
  const mount = (scoped) => {
    const holder = scoped ?? ctx;
    const webServer =
      holder?.webServer ?? hostService(holder, 'webServer', (candidate) => typeof candidate?.register === 'function');
    if (typeof webServer?.register !== 'function') {
      logger.warn(`[${PLUGIN_ID}] 宿主没有可用的 webServer 服务，Web 面板路由未注册（插件其余功能不受影响）`);
      return;
    }

    /** 准入校验与异常兜底：各路由共用，避免各写一遍。 */
    const guard = (handler) => async (req, res) => {
      // connection 每次现取：它与 webServer 谁先挂上不确定。
      const rejection = requestRejection(req, connectionOf(ctx));
      if (rejection !== undefined) {
        json(res, rejection, { ok: false, reason: rejection === 401 ? 'unauthorized' : 'origin-not-trusted' });
        return;
      }
      if (req.method === 'POST' && !isJsonRequest(req)) {
        json(res, 415, { ok: false, reason: 'content-type 必须是 application/json' });
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        logger.warn(`[${PLUGIN_ID}] 面板请求处理失败：${error instanceof Error ? error.message : String(error)}`);
        json(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    };

    ctx.effect(() => {
      const disposeModels = webServer.register({
        kind: 'exact',
        path: MODELS_PATH,
        handler: guard(async (req, res) => {
          if (req.method === 'GET') {
            if (operations.busy) {
              json(res, 200, { ok: false, state: 'backend-installing', reason: '后端操作进行中，请查看下方进度。',
                patchPath: configEditorOf(ctx)?.documentPath, enabled: resolved.models.enabled, only: resolved.models.only });
              return;
            }
            json(
              res,
              200,
              await describeModels({
                spec: resolved.spec, models: resolved.models, managedExe: resolved.managedExe,
                editor: configEditorOf(ctx), credentials: credentialsOf(ctx), env,
              }),
            );
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            if (!body.ok) {
              json(res, 400, { ok: false, reason: body.reason });
              return;
            }
            // 等待期间可能又发生切换或安装；旧页面不能保存到另一实例或半安装的后端。
            if (body.value.gateway !== undefined && body.value.gateway !== resolved.gateway) {
              json(res, 409, { ok: false, reason: '后端已再次切换，请刷新后重试同步' });
              return;
            }
            if (operations.busy) {
              json(res, 409, { ok: false, reason: '后端操作进行中，请完成后重试同步' });
              return;
            }
            const result = await applySelection({
              resolved, editor: configEditorOf(ctx), credentials: credentialsOf(ctx), env, only: body.value.only, enabled: body.value.enabled,
            });
            json(res, result.ok ? 200 : 400, result);
            return;
          }
          json(res, 405, { ok: false, reason: 'method not allowed' });
        }),
      });

      const disposeBackend = webServer.register({
        kind: 'exact',
        path: BACKEND_PATH,
        handler: guard((req, res) => handleBackend(req, res, { resolved, env, operations, autoUpdater, editor: configEditorOf(ctx) })),
      });

      const disposeVersion = webServer.register({
        kind: 'exact',
        path: VERSION_PATH,
        handler: guard(async (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { ok: false, reason: 'method not allowed' });
            return;
          }
          // 注册表都连不上也回 200：失败原因是给用户看的结果，不是路由本身出错
          json(res, 200, await checkVersion({ force: forceFrom(req) }));
        }),
      });

      const disposePanelKey = webServer.register({
        kind: 'exact',
        path: PANEL_KEY_PATH,
        handler: guard(async (req, res) => {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, reason: 'method not allowed' });
            return;
          }
          const result = readPanelKey(resolved);
          json(res, result.ok ? 200 : 404, result);
        }),
      });

      return () => {
        const pending = operations.dispose();
        for (const dispose of [disposeModels, disposeBackend, disposeVersion, disposePanelKey]) {
          try {
            dispose?.();
          } catch {
            /* 卸载阶段的释放失败不影响 DSH 退出 */
          }
        }
        return pending;
      };
    }, `${PLUGIN_ID}: panel routes`);
  };

  // 用 ctx.inject 等服务就绪：webServer 通常比插件树晚挂上，直接读属性会拿到 undefined
  // 而静默丢掉面板。注入只影响这一条回调，插件本身仍然不声明任何依赖。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], mount);
      return;
    } catch {
      /* 老版本没有这个签名时退回直接挂载 */
    }
  }
  mount(ctx);
}
