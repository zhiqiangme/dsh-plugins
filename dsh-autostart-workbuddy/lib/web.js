/**
 * Web 面板的宿主半侧：把「后端有哪些模型 / 当前白名单是什么」交给浏览器半侧，
 * 并接受勾选结果写回 profile；另有后端版本路由与插件自身的版本检查路由（见 lib/update.js）。
 *
 * 为什么必须有宿主半侧：
 *   页面跑在 DSH Web 客户端里，拿不到 wb2api 的响应——面板只监听 127.0.0.1:7863
 *   且不发 CORS 头，跨源 fetch 会被浏览器拦掉。所以由插件自己开一条 loopback 路由：
 *   GET 读（后端模型 + 当前白名单），POST 保存选择或刷新并同步 provider 清单。
 *
 * 写入一律走宿主的 configEditor（与 DSH 设置页同一个入口，持 profile 锁、校验、原子写、热重载）：
 * 白名单写本插件自己那一行的 `models.only`，模型清单写 llm-pi-ai 那一行（见 models.js）。
 * 读白名单用插件手里的配置——它由 index.js 的 internal/update 钩子随每次配置变更就地刷新，
 * 不再回头解析 cordis.patch.yml。
 *
 * 为什么挂在 ctx.webServer 而不是自己 listen：
 *   DSH 的 host webserver 已经占着客户端的同源地址，插件路由挂在它下面才拿得到
 *   同源 fetch 与既有的生命周期管理；自己开端口既跨源，又要处理端口冲突与鉴权。
 *   这也意味着本插件的宿主半侧第一次用到了 Host Service——但只是"用得上就用"，
 *   拿不到 webServer 时只记一条 warn，拉起后端与同步模型列表照常工作。
 *
 * 只依赖 node: 内置模块（与 services.js 的约束一致）。
 */

import { isDeepStrictEqual } from 'node:util';

import { autoUpdateStatus } from './auto-update.js';
import { diagnose } from './diagnostics.js';
import { createAccountOverview } from './overview.js';
import { creditValue, normalizeModelRules } from './model-rules.js';
import { GATEWAY_IDS, backendLockHolder, gatewayDriver, withBackendLock } from './gateway.js';
import { HUB_DEFAULT_PANEL_PASSWORD, hubPanelPasswordIsDefault } from './hub.js';
import {
  creditsLabel,
  fetchModels,
  fetchHubRegions,
  hubRegionKeys,
  HUB_KEY_REFS,
  providerKeyRef,
  resolveModelApiKey,
  LLM_PI_AI_PACKAGE,
  findConfigEntry,
  modelDisplayName,
  panelApiKey,
  scopedSelection,
  selectionKey,
  selectModels,
  syncModels,
} from './models.js';
import { healthTarget } from './resync.js';
import { isFile } from './services.js';
import { createVersionChecker } from './update.js';

/** 插件名：与 package.json / cordis.patch.yml 里的 name 保持一致。 */
const PLUGIN_ID = 'dsh-autostart-workbuddy';

/** 模型区的失败状态：插件自管的后端还没装。浏览器半侧据此显示"去点安装"，而不是裸的 fetch failed。 */
export const BACKEND_NOT_INSTALLED = 'backend-not-installed';

/** 模型区的失败状态：网关在跑，但账号池里没有可用账号（目前只有 hub 会这样报，见 describeModels）。 */
export const BACKEND_NO_ACCOUNTS = 'backend-no-accounts';

/** 面板路由前缀：DSH 给每个插件留的命名空间，浏览器半侧用同一份常量。 */
export const PANEL_BASE = `/plugins/${PLUGIN_ID}`;

/** 模型清单与勾选结果的端点（GET 只读 / POST 保存选择或刷新并同步）。 */
export const MODELS_PATH = `${PANEL_BASE}/models`;

/** 后端版本与更新端点（GET 读状态 / POST 执行 check|update|rollback|autoUpdate…）。 */
export const BACKEND_PATH = `${PANEL_BASE}/backend`;

/** 本插件自身的版本检查端点：当前运行版本 vs npm latest（?force=1 绕过缓存）。与后端网关的版本无关。 */
export const VERSION_PATH = `${PANEL_BASE}/version`;

/**
 * 后端控制台访问密钥（POST 才给）：控制台 /panel 首次打开会要 config.json 里的 api_key，
 * 用户不知道去哪找，卡片上一键复制。
 *
 * 用 POST 不用 GET：浏览器对跨源 POST 一定带 Origin，guard 会拦下；GET 的顶层导航、
 * <img>/<script> 引用都不带 Origin。密钥也不放进 /backend 快照，只在点按钮时取一次。
 */
export const PANEL_KEY_PATH = `${PANEL_BASE}/panel-key`;

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

/**
 * 读后端控制台的访问密钥：就是 wb2api 自己 config.json 里的 api_key（控制台的密钥门校验的正是它）。
 * 不走 resolveModelApiKey——那里优先用 profile/凭据库里给 DSH 调用的网关密钥，未必与 config.json 一致。
 *
 * key 为空字符串 = config.json 没设 api_key，控制台不鉴权、不会弹密钥框。
 */
export function readPanelKey(resolved) {
  // hub 的看板用面板密码登录，不认 api_key。还是出厂密码时直接给出 admin 供复制；
  // 用户改过之后 hub 只存哈希，插件拿不到明文，只能提示用自己设的密码。
  if (resolved?.gateway === 'hub') {
    const paths = resolved.backend?.paths ?? resolved.paths;
    const isDefault = paths?.accounts ? hubPanelPasswordIsDefault(paths) : true;
    return { ok: true, gateway: 'hub', key: isDefault === true ? HUB_DEFAULT_PANEL_PASSWORD : '', passwordDefault: isDefault === true };
  }
  const path = resolved?.models?.panelConfig || resolved?.backend?.paths?.config || resolved?.paths?.config || '';
  if (!path || !isFile(path)) {
    return { ok: false, reason: `找不到后端配置文件 ${path || 'config.json'}（后端可能还没安装或从未启动过）` };
  }
  return { ok: true, key: panelApiKey(path), configPath: path };
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
 * hub：行的 id 是带出口前缀的白名单键（cn:xxx / global:xxx，见 models.js 的 selectionKey），回显的白名单
 * 也把老的裸 id 展开成两个出口的键。浏览器半侧原样回传，存下来的勾选就按出口分开，hub 切出口时各用各的。
 *
 * `models` 是插件手里的当前配置（随配置变更就地刷新，见 index.js），`patchPath` 只用来
 * 告诉用户写到了哪个文件。
 */
export async function describeModels({ spec, models, editor, env = process.env, managedExe, gateway, probe, credentials }) {
  const patchPath = editor?.documentPath;
  const only = scopedSelection(models.only ?? [], gateway);
  const enabled = models.enabled;

  // hub 的 /v1/models 不看账号池：一个账号都没有也照样返回内置目录（实测 17 个），
  // 勾上同步进 DSH 后对话只会 503 "no usable account"。所以先问 /health，账号池空着就不列模型。
  // wb2api 的目录本来就是用账号拉的，不需要这一步。探针不通时不拦，交给下面的拉取报真实错误。
  if (gateway === 'hub' && !models.hubDual && typeof probe === 'function') {
    const health = await probe(healthTarget(models.baseURL, spec)).catch(() => undefined);
    if (health?.ok && health.servable === false) {
      return {
        ok: false,
        state: BACKEND_NO_ACCOUNTS,
        accounts: health.total ?? 0,
        reason: `hub 里还没有可用账号（共 ${health.total ?? 0} 个，可用 0），模型目录不可用。请打开上方后端面板登录或导入 WorkBuddy 账号，再点「重试」。`,
        patchPath, enabled, only,
      };
    }
  }

  const fetched = models.hubDual ? await fetchHubRegions({ models, credentials, env }) : await fetchModels({
    baseURL: models.baseURL || `http://${spec.host}:${spec.port}`,
    apiKey: await resolveModelApiKey(models, env, credentials),
    timeoutMs: models.timeoutMs,
  });
  if (fetched.ok && models.hubDual) {
    fetched.models = fetched.regions.flatMap((region) => region.models.map((model) => ({ ...model, id: selectionKey(model) })));
    fetched.realm = 'dual';
  }
  if (!fetched.ok) {
    // 只在拉取失败后才看 exe 在不在：端口上若是用户另起的后端、拉取成功，就照常显示，不误报未安装。
    if (managedExe === true && !isFile(spec.exe)) {
      return {
        ok: false,
        state: BACKEND_NOT_INSTALLED,
        reason: '后端还没有安装，请点下方「后端版本」里的「安装」，装好后模型列表会自动刷新。',
        patchPath, enabled, only,
      };
    }
    return { ok: false, reason: fetched.reason, patchPath, enabled, only };
  }

  // 与同步同一套挑选规则（含 hub 当前出口没勾过任何模型时按"全部"算），面板显示的勾选就是 DSH 会得到的。
  const selected = new Set(models.hubDual
    ? fetched.regions.flatMap((region) => selectModels(region.models, only).map(selectionKey))
    : selectModels(fetched.models, only).map((model) => model.id));
  const rows = fetched.models.map((model) => ({
    id: selectionKey(model),
    label: modelDisplayName(model),
    credits: creditsLabel(model.credits),
    price: creditValue(model.credits),
    contextWindow: positiveIntOrNull(model.context_length),
    maxTokens: positiveIntOrNull(model.max_output_tokens),
    vision: model.supports_images === true,
    selected: selected.has(model.id),
  }));

  return {
    ok: true,
    url: fetched.url,
    // hub 的当前出口（intl / cn）；wb2api 没有。
    realm: fetched.realm,
    hubDual: models.hubDual,
    patchPath,
    enabled,
    provider: models.provider,
    rules: models.rules,
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
 * index.js 的钩子只就地刷新 models，不重启插件（重启会把托管的 wb2api 一起停掉）。
 *
 * @param {{ resolved: object, editor?: object, credentials?: object, env?: object, only?: unknown, enabled?: boolean }} options
 *   省略 `only` 表示沿用现有白名单（装好后端后只打开同步开关时用，不能把用户勾选清空）。
 *   `resolved` 是插件手里那份配置对象；钩子会就地换掉它的 models，这里也同步刷新一次，
 *   宿主没有转发 internal/update 时（测试、旧版本）保存结果照样立即可见。
 */
export async function applySelection({ resolved, editor, credentials, env = process.env, only, enabled, rules }) {
  const keepOnly = only === undefined && (enabled !== undefined || rules !== undefined);
  if (rules !== undefined && (!rules || typeof rules !== 'object' || Array.isArray(rules) ||
    ['freeOnly', 'visionOnly'].some((key) => rules[key] !== undefined && typeof rules[key] !== 'boolean') ||
    (rules.maxCredits != null && creditValue(rules.maxCredits) === null) ||
    (rules.sort !== undefined && !['upstream', 'name', 'credits'].includes(rules.sort)))) return { ok: false, reason: '模型规则格式不正确' };
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
  const rulesPatch = rules === undefined ? {} : { rules: normalizeModelRules(rules) };
  const changed = !isDeepStrictEqual(currentModels?.only, ids) ||
    (enabled !== undefined && currentModels?.enabled !== enabled) ||
    (rules !== undefined && !isDeepStrictEqual(normalizeModelRules(currentModels?.rules), rulesPatch.rules));

  if (changed) {
    try {
      await editor.edit(entry, (current) => {
        const config = plainObject(current);
        return { ...config, models: { ...plainObject(config.models), ...enabledPatch, ...rulesPatch, only: ids } };
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), patchPath };
    }
  }
  resolved.models = { ...resolved.models, ...enabledPatch, ...rulesPatch, only: ids };

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
      credential: synced.credential?.state,
    },
  };
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/** 锁被占着时给面板的说明：后台自动下载与手点的操作分开说，用户才知道该等什么。 */
function busyReason(holder) {
  if (holder === 'auto-prepare') return '后台正在自动下载后端新版本，请稍候再试';
  if (holder === 'auto-apply') return '正在换装自动下载的后端新版本，请稍候再试';
  return '已有更新操作在进行中，请稍候再试';
}

/**
 * 后端版本端点。
 *
 * GET 默认**不联网**（首屏要快，GitHub 也可能慢甚至不通），带 `?check=1` 才真去查 release。
 * POST 的动作：check、gateway、autoUpdate，以及会动目录的 install / update / rollback / uninstall / purge
 * （后五个与自动更新共用一把锁，同一时刻只跑一个）。
 */
async function handleBackend(req, res, { logger, resolved, env, service, editor, credentials, autoUpdater, recovery, resync, overview }) {
  const paths = resolved.backend?.paths ?? resolved.paths;
  const apiBase = resolved.backend?.apiBase || undefined;
  const driver = gatewayDriver(resolved);
  // 面板地址由服务规格推出来（端口可被 profile 覆盖），浏览器半侧拿它渲染可点击链接。
  const panelUrl = `http://${resolved.spec?.host ?? '127.0.0.1'}:${resolved.spec?.port ?? 7863}${driver.panelPath}`;
  const snapshot = () => ({
    ...driver.describe(paths),
    gateway: driver.id,
    gateways: [...GATEWAY_IDS],
    panelUrl,
    autoUpdate: autoUpdateStatus(resolved),
    recovery: recovery?.status,
    modelStatus: resync?.status,
  });

  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('overview') === '1') {
      json(res, 200, { ok: true, backend: { ...snapshot(), overview: await overview() }, check: null });
      return;
    }
    if (url.searchParams.get('check') !== '1' || resolved.backend?.enabled === false) {
      json(res, 200, { ok: true, backend: snapshot(), check: null });
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
  if (action === 'hubMode') {
    const result = await setHubMode({ resolved, editor, credentials, env, enabled: body.value.enabled, cnKey: body.value.cnKey, globalKey: body.value.globalKey, followKey: body.value.followKey });
    json(res, result.ok ? 200 : 400, result);
    return;
  }
  if (action === 'diagnose') {
    json(res, 200, { ok: true, report: await diagnose({ resolved, service, recovery, editor, credentials, env }) });
    return;
  }

  if (action === 'gateway') {
    // 后台自动下载只写 cache/ 里的暂存文件，不碰正在跑的程序：切网关重启插件不受它影响，不必等它下完。
    const holder = backendLockHolder();
    json(res, 200, await selectGateway({ resolved, editor, gateway: body.value.gateway, busy: Boolean(holder) && holder !== 'auto-prepare' }));
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

  // 会改动磁盘的动作：都要串行执行（见下面的 withBackendLock），其中卸载与清除数据还要求显式二次确认。
  const MUTATING_ACTIONS = new Set(['install', 'update', 'rollback', 'uninstall', 'purge', 'start']);

  if (!MUTATING_ACTIONS.has(action)) {
    json(res, 400, { ok: false, reason: `不认识的动作：${action || '(空)'}` });
    return;
  }

  if ((action === 'uninstall' || action === 'purge') && body.value.confirm !== true) {
    json(res, 400, { ok: false, reason: `${action === 'purge' ? '彻底卸载' : '卸载'}需要二次确认（confirm: true）` });
    return;
  }

  // 自配 exe 的外部后端不归插件管，整目录清除也不该替用户做。
  if (action === 'purge' && resolved.managedExe === false) {
    json(res, 400, { ok: false, reason: '自定义 exe 不由插件管理，请在外部维护该后端的数据。' });
    return;
  }

  // 会动目录的动作与自动更新共用一把锁（见 gateway.js 的 withBackendLock）。
  const locked = await withBackendLock(action, () => {
    if (action === 'start') { recovery?.reset(); return service.ensureRunning().then((result) => ({ ...result, ok: result.state !== 'failed' })); }
    if (action === 'install' || action === 'update') {
      return driver[action]({
        paths,
        env,
        apiBase,
        service,
        logger,
        keepVersions: resolved.backend?.keepVersions,
      });
    }
    if (action === 'purge') return driver.purge({ paths, service, logger, env });
    return driver[action]({ paths, service, logger });
  });
  if (!locked.acquired) {
    json(res, 409, { ok: false, reason: busyReason(locked.holder) });
    return;
  }
  const result = locked.value;
  json(res, result.ok ? 200 : 400, { ...result, backend: snapshot() });
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

/** 区域 Key 只写凭据库，profile 和面板快照只保存模式开关。 */
export async function setHubMode({ resolved, editor, credentials, env = process.env, enabled, cnKey, globalKey, followKey }) {
  if (resolved.gateway !== 'hub' || typeof enabled !== 'boolean') return { ok: false, reason: '请在 HUB 网关下设置双区域模式' };
  const entry = findConfigEntry(editor, { id: PLUGIN_ID });
  if (!entry || typeof editor?.edit !== 'function') return { ok: false, reason: '宿主没有可编辑的插件配置' };
  try {
    const follow = typeof followKey === 'string' ? followKey.trim() : '';
    const keyRef = providerKeyRef(findConfigEntry(editor, { name: LLM_PI_AI_PACKAGE })?.options?.config, resolved.models.provider) || 'WORKBUDDY_PROXY_KEY';
    if (follow) {
      if (typeof credentials?.set !== 'function') return { ok: false, reason: '保存 Key 需要 DSH 凭据服务' };
      if (env[keyRef] && env[keyRef] !== follow) return { ok: false, reason: `${keyRef} 来自只读环境变量` };
      const checked = await Promise.all(['cn', 'intl'].map((realm) => fetchModels({ baseURL: resolved.models.baseURL, apiKey: follow, realm, timeoutMs: resolved.models.timeoutMs })));
      if (checked.some((result, i) => !result.ok || ![i === 0 ? 'cn' : 'intl', ...(i === 1 ? ['global'] : [])].includes(result.realm))) return { ok: false, reason: '跟随出口的 Key 必须有效且不绑定区域，请在 HUB 设置页核对' };
    }
    if (!enabled && !follow) {
      const apiKey = await resolveModelApiKey(resolved.models, env, credentials);
      const check = await fetchModels({ baseURL: resolved.models.baseURL, apiKey, timeoutMs: resolved.models.timeoutMs });
      if (!check.ok) return { ok: false, reason: '当前跟随模式 Key 已失效，请填写一把不绑定区域的 Key 后再应用' };
    }
    if (enabled) {
      const providers = findConfigEntry(editor, { name: LLM_PI_AI_PACKAGE })?.options?.config?.providers ?? {};
      for (const [realm, ref] of Object.entries(HUB_KEY_REFS)) {
        const name = `${resolved.models.provider}-hub-${realm === 'cn' ? 'cn' : 'global'}`;
        if (providers[name] && (providers[name].apiKeyEnv !== ref || providers[name].api !== 'openai-completions')) return { ok: false, reason: `provider ${name} 已被占用，请先修改分组名` };
      }
      if (typeof credentials?.set !== 'function' || typeof credentials?.resolve !== 'function') return { ok: false, reason: '双区域模式需要 DSH 凭据服务' };
      const existing = await hubRegionKeys(credentials, env);
      const keys = { cn: typeof cnKey === 'string' && cnKey.trim() ? cnKey.trim() : existing.cn, intl: typeof globalKey === 'string' && globalKey.trim() ? globalKey.trim() : existing.intl };
      const checked = await fetchHubRegions({ models: resolved.models, keys });
      if (!checked.ok) return checked;
      // 先检查所有只读环境引用，避免写完一个区域后才发现另一个不能修改。
      for (const [realm, ref] of Object.entries(HUB_KEY_REFS)) if (env[ref] && env[ref] !== keys[realm]) return { ok: false, reason: `${ref} 来自只读环境变量，请先在启动环境中修改` };
      for (const [realm, ref] of Object.entries(HUB_KEY_REFS)) if (keys[realm] !== existing[realm]) await credentials.set(ref, keys[realm]);
    }
    if (follow) await credentials.set(keyRef, follow);
    const keyPatch = follow ? { apiKeyRef: keyRef } : {};
    await editor.edit(entry, (current) => ({ ...plainObject(current), models: { ...plainObject(current?.models), ...keyPatch, hubDual: enabled } }));
    resolved.models = { ...resolved.models, ...keyPatch, hubDual: enabled };
    const synced = await syncModels({ spec: resolved.spec, models: resolved.models, editor, credentials, env });
    return { ok: true, enabled, sync: { state: synced.state, reason: synced.reason, count: synced.entries?.length } };
  } catch { return { ok: false, reason: '保存双区域设置失败，请检查凭据库和 profile 的写入权限' }; }
}

/**
 * 切换后端网关：把选择写进本插件那一行的 `config.gateway`。
 *
 * 写完由宿主按"配置变更"重启本插件（index.js 的 internal/update 钩子只放过 models.* 的就地更新，
 * gateway 变了照默认流程重启）：dispose 停掉本插件拉起的旧网关，重新 apply 后按新网关拉起
 * （没装就只挂面板，等用户点安装）。两种网关监听同一端口，所以不能先起新的再停旧的。
 * 更新 / 安装进行中拒绝切换：重启会在换文件的半路把进程停掉。
 */
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

/** 宿主的 credentials 服务（凭据库，host 侧可 resolve / set）；每次用时现取，拿不到返回 undefined。 */
export function credentialsOf(ctx) {
  return hostService(
    ctx,
    'credentials',
    (candidate) => typeof candidate?.resolve === 'function' && typeof candidate?.set === 'function',
  );
}

/** 宿主的 connection 服务（浏览器会话鉴权）；拿不到时 guard 退回本地规则。 */
export function connectionOf(ctx) {
  return hostService(ctx, 'connection', (candidate) => typeof candidate?.requestRejection === 'function');
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
 * resync 与入口处的定时器共用，面板刷新通过 tick() 立即对齐模型清单；
 * autoUpdater 同理，面板打开「自动更新」时立即查一轮。
 */
export function registerPanelRoutes(ctx, { logger, resolved, env = process.env, service, resync, autoUpdater, recovery, checkVersion = createVersionChecker() }) {
  const overview = createAccountOverview({ resolved, env, credentials: () => credentialsOf(ctx) });
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
            json(
              res,
              200,
              await describeModels({
                spec: resolved.spec, models: resolved.models, managedExe: resolved.managedExe,
                editor: configEditorOf(ctx), env, gateway: resolved.gateway, probe: gatewayDriver(resolved).probe, credentials: credentialsOf(ctx),
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
            if (body.value.action === 'refresh') {
              // 刷新只沿用已保存的选择：不能把当前可见的 GL 子集写成永久白名单。
              // 与定时同步共用健康检查、移除确认和并发保护；恢复的模型当轮即可补回。
              const synced = await resync.tick();
              const payload = await describeModels({
                spec: resolved.spec, models: resolved.models, managedExe: resolved.managedExe,
                editor: configEditorOf(ctx), env, gateway: resolved.gateway, probe: gatewayDriver(resolved).probe, credentials: credentialsOf(ctx),
              });
              json(res, 200, { ...payload, sync: { state: synced.state, reason: synced.reason } });
              return;
            }
            const result = await applySelection({
              resolved,
              editor: configEditorOf(ctx),
              credentials: credentialsOf(ctx),
              env,
              only: body.value.only,
              enabled: body.value.enabled,
              rules: body.value.rules,
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
        handler: guard((req, res) => handleBackend(req, res, { logger, resolved, env, service, editor: configEditorOf(ctx), credentials: credentialsOf(ctx), autoUpdater, recovery, resync, overview })),
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
        for (const dispose of [disposeModels, disposeBackend, disposeVersion, disposePanelKey]) {
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
