/**
 * Web 面板的宿主半侧：把「后端有哪些模型 / 当前白名单是什么」交给浏览器半侧，
 * 并接受勾选结果写回 profile。
 *
 * 为什么必须有宿主半侧：
 *   页面跑在 DSH Web 客户端里，拿不到 wb2api 的响应——面板只监听 127.0.0.1:7863
 *   且不发 CORS 头，跨源 fetch 会被浏览器拦掉；白名单又写在 profile 的
 *   cordis.patch.yml 里，页面同样碰不到。所以由插件自己开一条 loopback 路由：
 *   GET 读（后端模型 + 当前白名单），POST 写（白名单 + 立即重新同步 provider 清单）。
 *
 * 为什么挂在 ctx.webServer 而不是自己 listen：
 *   DSH 的 host webserver 已经占着客户端的同源地址，插件路由挂在它下面才拿得到
 *   同源 fetch 与既有的生命周期管理；自己开端口既跨源，又要处理端口冲突与鉴权。
 *   这也意味着本插件的宿主半侧第一次用到了 Host Service——但只是"用得上就用"，
 *   拿不到 webServer 时只记一条 warn，拉起后端与同步模型列表照常工作。
 *
 * 只依赖 node: 内置模块（与 services.js 的约束一致）。
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  applyUpdate,
  checkForUpdate,
  describeBackend,
  installBackend,
  rollbackBackend,
  uninstallBackend,
} from './backend.js';
import {
  backupPatchFile,
  creditsLabel,
  fetchModels,
  modelDisplayName,
  panelApiKey,
  readPluginModelsConfig,
  resolveProfilePatchPath,
  syncModels,
  updatePluginOnlyList,
} from './models.js';
import { isFile } from './services.js';

/** 插件名：与 package.json / cordis.patch.yml 里的 name 保持一致。 */
const PLUGIN_ID = 'dsh-autostart-workbuddy';

/** 面板路由前缀：DSH 给每个插件留的命名空间，浏览器半侧用同一份常量。 */
export const PANEL_BASE = `/plugins/${PLUGIN_ID}`;

/** 模型清单与勾选结果的读写端点（GET 读 / POST 写）。 */
export const MODELS_PATH = `${PANEL_BASE}/models`;

/** 后端版本与更新端点（GET 读状态 / POST 执行 check|update|rollback）。 */
export const BACKEND_PATH = `${PANEL_BASE}/backend`;

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
 * 只接受本机来源。
 *
 * 没有 Origin 头（curl、同源导航）放行；有则必须是 loopback——DSH 的页面本身就是
 * 从 127.0.0.1 加载的，所以正常调用不受影响，而任何外部页面都改不了本机配置。
 */
export function loopbackOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
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
  const fromEnv = typeof env.WORKBUDDY_PROXY_KEY === 'string' ? env.WORKBUDDY_PROXY_KEY.trim() : '';
  return fromEnv || panelApiKey(models.panelConfig);
}

/**
 * 读文件里当前的白名单，而不是宿主启动时传进来的那份。
 *
 * 面板保存后会立刻改文件，用内存里的旧配置回显会让用户看到"刚勾的没生效"；
 * 以文件为准，刷新页面与重启 DSH 得到的结果就一致。
 */
function readLiveModelsConfig(patchPath) {
  if (!patchPath || !isFile(patchPath)) return undefined;
  try {
    return readPluginModelsConfig(readFileSync(patchPath, 'utf8'), PLUGIN_ID);
  } catch {
    return undefined;
  }
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
 */
export async function describeModels({ spec, models, env = process.env }) {
  const patchPath = resolveProfilePatchPath(env, models.profilePatch);
  const live = readLiveModelsConfig(patchPath);
  const only = Array.isArray(live?.only) ? live.only : models.only ?? [];
  const enabled = typeof live?.enabled === 'boolean' ? live.enabled : models.enabled;

  const fetched = await fetchModels({
    baseURL: models.baseURL || `http://${spec.host}:${spec.port}`,
    apiKey: resolveApiKey(models, env),
    timeoutMs: models.timeoutMs,
  });
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason, patchPath, enabled, only };
  }

  const selected = new Set(only);
  const rows = fetched.models.map((model) => ({
    id: model.id,
    label: modelDisplayName(model),
    credits: creditsLabel(model.credits),
    contextWindow: positiveIntOrNull(model.context_length),
    maxTokens: positiveIntOrNull(model.max_output_tokens),
    vision: model.supports_images === true,
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
 * POST 的处理：写白名单 → 立即重新同步 provider 的模型清单。
 *
 * 两步都做是刻意的：只写白名单要等下次 DSH 启动才见效，用户点完"保存"看不到变化；
 * 顺手同步一次，DSH 的模型选择器马上就是新清单（配置热加载生效）。
 */
export async function applySelection({ spec, models, env = process.env, only }) {
  if (!Array.isArray(only) || only.some((id) => typeof id !== 'string')) {
    return { ok: false, reason: 'only 必须是字符串数组' };
  }

  const patchPath = resolveProfilePatchPath(env, models.profilePatch);
  if (!patchPath) return { ok: false, reason: '无法确定 profile 的 cordis.patch.yml 路径' };
  if (!isFile(patchPath)) return { ok: false, reason: `profile 配置不存在：${patchPath}` };

  const updated = updatePluginOnlyList(readFileSync(patchPath, 'utf8'), only, PLUGIN_ID);
  if (!updated.ok) return { ok: false, reason: updated.reason, patchPath };

  let backup;
  if (updated.changed) {
    backup = backupPatchFile(patchPath, models.keepBackups ?? 3);
    writeFileSync(patchPath, updated.text);
  }

  const synced = await syncModels({ spec, models: { ...models, only }, env });
  return {
    ok: true,
    patchPath,
    changed: updated.changed,
    backup,
    only,
    sync: {
      state: synced.state,
      count: Array.isArray(synced.entries) ? synced.entries.length : undefined,
      reason: synced.reason,
      backup: synced.backup,
    },
  };
}

/**
 * 同一时刻只允许一个更新/回滚：下载 + 换文件 + 重启后端不是幂等操作，
 * 两个请求并发进来会把 current 目录搅乱。
 */
let backendBusy = false;

/**
 * 后端版本端点。
 *
 * GET 默认**不联网**（首屏要快，GitHub 也可能慢甚至不通），带 `?check=1` 才真去查 release。
 * POST 只接受 check / update / rollback 三个动作；update 与 rollback 互斥。
 */
async function handleBackend(req, res, { logger, resolved, env, service }) {
  const paths = resolved.backend?.paths ?? resolved.paths;
  const apiBase = resolved.backend?.apiBase || undefined;
  // 面板地址由服务规格推出来（端口可被 profile 覆盖），浏览器半侧拿它渲染可点击链接。
  const panelUrl = `http://${resolved.spec?.host ?? '127.0.0.1'}:${resolved.spec?.port ?? 7863}/panel`;
  const snapshot = () => ({ ...describeBackend(paths), panelUrl });

  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('check') !== '1' || resolved.backend?.enabled === false) {
      json(res, 200, { ok: true, backend: snapshot(), check: null });
      return;
    }
    try {
      const check = await checkForUpdate({
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

  if (action === 'check') {
    const check = await checkForUpdate({
      paths,
      env,
      apiBase,
      ttlMs: resolved.backend?.checkTtlMs,
      force: true,
    });
    json(res, 200, { ok: true, check, backend: snapshot() });
    return;
  }

  // 会改动磁盘的动作：都要串行执行（见 backendBusy），其中卸载还要求显式二次确认。
  const MUTATING_ACTIONS = new Set(['install', 'update', 'rollback', 'uninstall']);

  if (!MUTATING_ACTIONS.has(action)) {
    json(res, 400, { ok: false, reason: `不认识的动作：${action || '(空)'}` });
    return;
  }

  if (action === 'uninstall' && body.value.confirm !== true) {
    json(res, 400, { ok: false, reason: '卸载需要二次确认（confirm: true）' });
    return;
  }

  if (backendBusy) {
    json(res, 409, { ok: false, reason: '已有更新操作在进行中，请稍候再试' });
    return;
  }
  backendBusy = true;
  try {
    let result;
    if (action === 'install') {
      result = await installBackend({
        paths,
        env,
        apiBase,
        service,
        logger,
        keepVersions: resolved.backend?.keepVersions,
      });
    } else if (action === 'uninstall') {
      result = await uninstallBackend({ paths, service, logger });
    } else if (action === 'update') {
      result = await applyUpdate({
        paths,
        env,
        apiBase,
        service,
        logger,
        keepVersions: resolved.backend?.keepVersions,
      });
    } else {
      result = await rollbackBackend({ paths, service, logger });
    }
    json(res, result.ok ? 200 : 400, { ...result, backend: snapshot() });
  } finally {
    backendBusy = false;
  }
}

/**
 * 取宿主 webserver 服务。
 *
 * 不写进 `inject`：本插件的核心职责（拉起后端、同步模型列表）不依赖任何 Host Service，
 * 不该因为 webServer 缺席而整个插件不激活——只影响 Web 面板。
 */
function resolveWebServer(ctx) {
  const candidates = [];
  try {
    candidates.push(ctx?.webServer);
  } catch {
    /* 服务未就绪时读属性可能抛，忽略 */
  }
  try {
    if (typeof ctx?.get === 'function') candidates.push(ctx.get('webServer'));
  } catch {
    /* 同上 */
  }
  return candidates.find((candidate) => typeof candidate?.register === 'function');
}

/** 注册面板路由；宿主没有 webServer 时只记一条 warn。 */
export function registerPanelRoutes(ctx, { logger, resolved, env = process.env, service }) {
  const mount = (scoped) => {
    const holder = scoped ?? ctx;
    const webServer = holder?.webServer ?? resolveWebServer(holder);
    if (typeof webServer?.register !== 'function') {
      logger.warn(`[${PLUGIN_ID}] 宿主没有可用的 webServer 服务，Web 面板路由未注册（插件其余功能不受影响）`);
      return;
    }

    /** 来源校验与异常兜底：两条路由共用，避免各写一遍。 */
    const guard = (handler) => async (req, res) => {
      if (!loopbackOrigin(req)) {
        json(res, 403, { ok: false, reason: 'origin-not-trusted' });
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
            json(res, 200, await describeModels({ spec: resolved.spec, models: resolved.models, env }));
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            if (!body.ok) {
              json(res, 400, { ok: false, reason: body.reason });
              return;
            }
            const result = await applySelection({
              spec: resolved.spec,
              models: resolved.models,
              env,
              only: body.value.only,
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
        handler: guard((req, res) => handleBackend(req, res, { logger, resolved, env, service })),
      });

      return () => {
        for (const dispose of [disposeModels, disposeBackend]) {
          try {
            dispose?.();
          } catch {
            /* 卸载阶段的释放失败不影响 DSH 退出 */
          }
        }
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
