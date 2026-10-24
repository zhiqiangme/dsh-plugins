import { INSTANT_FIELDS, KEY_REF, LOCAL_KEY, PACKAGE_NAME, PLUGIN_ID, object, resolveConfig, revision } from './config.js';
import { credential, findEntry, catalogModels, requestGateway, syncModels } from './models.js';
import { PROVIDER_NAMES, keepOrderIndexes, sortModelIndexes } from './names.js';
import { MagpieBackend } from './backend.js';

// 本机网关正常时几十毫秒内应答；状态检查会定时重复，超时设短免得卡片长时间显示“检查中”。
const STATUS_TIMEOUT = 2_000;

export function hostService(ctx, name, usable = (value) => value !== undefined) {
  const candidates = [];
  try { candidates.push(ctx?.[name]); } catch { /* 宿主服务可能尚未挂载。 */ }
  try { candidates.push(ctx?.get?.(name)); } catch { /* 兼容没有 getter 的宿主。 */ }
  return candidates.find((value) => value != null && usable(value));
}

export class ModelManager {
  constructor(ctx, raw, { env = process.env, fetchImpl = fetch, backend } = {}) {
    this.ctx = ctx;
    this.config = resolveConfig(raw);
    this.env = env;
    this.fetch = fetchImpl;
    this.backend = backend ?? new MagpieBackend({ env });
    this.pending = Promise.resolve();
    this.disposed = false;
  }
  get editor() { return hostService(this.ctx, 'configEditor'); }
  get credentials() { return hostService(this.ctx, 'credentials'); }
  current() {
    const entry = findEntry(this.editor, PACKAGE_NAME, PLUGIN_ID);
    return entry ? resolveConfig(entry.options.config) : this.config;
  }
  enqueue(run) {
    const work = this.pending.then(() => {
      if (this.disposed) throw new Error('插件已关闭');
      return run();
    });
    this.pending = work.catch(() => {});
    return work;
  }
  async describe() {
    const config = this.current();
    const saved = await this.credentials?.resolve?.(KEY_REF);
    const llm = findEntry(this.editor, '@deepseek-ai/dsh-llm-pi-ai');
    return {
      ok: true, config, revision: revision(config), lastSync: this.lastSync, providerNames: PROVIDER_NAMES,
      backend: await this.backend.describe(config.magpiePath), magpieSettings: this.backend.settings?.(),
      keyConfigured: Boolean(this.env[KEY_REF] || (saved?.value && saved.value !== LOCAL_KEY)),
      keyWritable: !this.env[KEY_REF] && (await this.credentials?.describe?.(KEY_REF))?.writable !== false,
      editable: Boolean(findEntry(this.editor, PACKAGE_NAME, PLUGIN_ID)),
      nativeProviders: Object.keys(object(llm?.options.config?.providers)).filter((id) => ['magpie', 'magpie-responses', 'magpie-anthropic'].includes(id)),
    };
  }
  async sync(config = this.current()) {
    try {
      const result = await syncModels(config, { editor: this.editor, credentials: this.credentials, env: this.env });
      return (this.lastSync = { ok: true, ...result });
    } catch (error) {
      return (this.lastSync = { ok: false, reason: error.message });
    }
  }
  assertRevision(expected, config = this.current()) {
    if (typeof expected !== 'string' || expected !== revision(config)) {
      const error = new Error('配置已在其它页面改变，请重新载入后保存');
      error.status = 409;
      throw error;
    }
  }
  /** 开关和下拉改完即生效：只改这些字段，不带上卡片里未保存的连接设置和模型草稿。 */
  async patch(raw, expected) {
    const patch = object(raw);
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((key) => !INSTANT_FIELDS.includes(key))) throw new Error('只能直接修改开关和下拉设置');
    const entry = findEntry(this.editor, PACKAGE_NAME, PLUGIN_ID);
    if (!entry || typeof this.editor?.edit !== 'function') throw new Error('宿主 configEditor 尚未就绪，无法保存');
    let config;
    await this.editor.edit(entry, (current) => {
      // 返回的新版本号会用于后续保存，不能让旧草稿借即时开关绕过冲突检查。
      this.assertRevision(expected, resolveConfig(current));
      config = resolveConfig({ ...resolveConfig(current), ...patch });
      return { ...object(current), ...config };
    });
    this.config = config;
    if (patch.autoLightweight === true) this.backend.ensureLightweight?.();
    // 同步开关决定 DSH 是否保留 Magpie 分组，改完立即按已保存清单重写。
    const sync = keys.includes('syncEnabled') ? await this.sync(config) : undefined;
    // describe 等待期间可能又有其它页面保存；只返回本次锁内写入的配置及版本给草稿续用。
    return { ...await this.describe(), config, revision: revision(config), saved: true, ...(sync ? { sync } : {}) };
  }
  async handle(body) {
    if (['backend-status', 'backend-check', 'backend-install', 'backend-open'].includes(body.action)) {
      const path = body.magpiePath ?? this.current().magpiePath;
      const lightweight = this.current().autoLightweight;
      if (body.action === 'backend-check') await this.backend.check(path);
      if (body.action === 'backend-install') this.backend.install(path, { lightweight });
      if (body.action === 'backend-open') await this.backend.open(path, { lightweight });
      return { ok: true, backend: await this.backend.describe(path), magpieSettings: this.backend.settings?.() };
    }
    if (body.action === 'catalog-order') {
      // 「默认排序」只读 Magpie 目录的顺序，不保存也不改清单；排好的草稿仍由保存并同步提交。
      const config = resolveConfig({ ...this.current(), baseURL: body.baseURL ?? this.current().baseURL });
      const key = await credential(this.credentials, this.env, config.baseURL, body.apiKey);
      const hello = await requestGateway(config.baseURL, '/api/hello', key, this.fetch);
      if (hello?.name !== 'magpie') throw new Error('该地址没有返回 Magpie 身份信息');
      return { ok: true, ids: catalogModels(await requestGateway(config.baseURL, '/v1/models', key, this.fetch)).map((model) => model.id) };
    }
    if (body.action === 'status') {
      // 卡片标题处的网关状态：短超时，读不到就算未连接，不报错。
      const config = this.current();
      try {
        const key = await credential(this.credentials, this.env, config.baseURL);
        const hello = await requestGateway(config.baseURL, '/api/hello', key, this.fetch, STATUS_TIMEOUT);
        return { ok: true, gateway: hello?.name === 'magpie' ? { online: true, version: hello.version ?? null } : { online: false } };
      } catch { return { ok: true, gateway: { online: false } }; }
    }
    if (body.action === 'magpie-settings') {
      // 直接写 Magpie 自己的设置，不属于插件配置，也不需要版本号。
      return { ok: true, magpieSettings: this.backend.updateSettings({ lightweight: body.lightweight, keepAwake: body.keepAwake }) };
    }
    if (body.action === 'patch') return this.enqueue(() => this.patch(body.patch, body.revision));
    if (body.action === 'check') {
      const config = resolveConfig({ ...this.current(), baseURL: body.baseURL ?? this.current().baseURL });
      const key = await credential(this.credentials, this.env, config.baseURL, body.apiKey);
      const hello = await requestGateway(config.baseURL, '/api/hello', key, this.fetch);
      if (hello?.name !== 'magpie') throw new Error('该地址没有返回 Magpie 身份信息');
      return { ok: true, version: hello.version };
    }
    if (!['save', 'sync', 'sync-catalog'].includes(body.action)) throw new Error('不支持的操作');
    return this.enqueue(async () => {
      this.assertRevision(body.revision);
      if (body.action === 'sync') return { ok: true, sync: await this.sync(), ...await this.describe() };
      if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) throw new Error('保存需要完整的配置对象');
      const mirror = body.action === 'sync-catalog';
      // 全量同步替换草稿模型，允许用户用同步按钮修复尚未填完的手工条目。
      let config = resolveConfig(mirror ? { ...body.config, enabled: true, syncEnabled: true, models: [] } : body.config);
      if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw new Error('Key 必须是文本');
      const entry = findEntry(this.editor, PACKAGE_NAME, PLUGIN_ID);
      if (!entry || typeof this.editor?.edit !== 'function') throw new Error('宿主 configEditor 尚未就绪，无法保存');
      const key = body.apiKey?.trim();
      if (key && (this.env[KEY_REF] || typeof this.credentials?.set !== 'function' || (await this.credentials.describe?.(KEY_REF))?.writable === false)) {
        throw new Error('DSH 凭据不可写，未保存');
      }
      if (mirror) {
        const gatewayKey = await credential(this.credentials, this.env, config.baseURL, body.apiKey);
        const hello = await requestGateway(config.baseURL, '/api/hello', gatewayKey, this.fetch);
        if (hello?.name !== 'magpie') throw new Error('该地址没有返回 Magpie 身份信息');
        const catalog = catalogModels(await requestGateway(config.baseURL, '/v1/models', gatewayKey, this.fetch));
        // 默认按模型名称排好再保存，与卡片「按模型排序」一致；选了「默认排序」时沿用 Magpie 目录顺序。
        // 用户手动排过序时保留卡片上的现有顺序，新模型接在末尾。
        const order = config.manualOrder
          ? keepOrderIndexes(catalog, (Array.isArray(body.config.models) ? body.config.models : []).map((m) => m?.id))
          : config.catalogOrder ? catalog.map((_model, index) => index) : sortModelIndexes(catalog, 'model');
        config = resolveConfig({ ...config, models: order.map((index) => catalog[index]) });
      }
      // 在宿主锁内核对版本，旧页面不能覆盖其它页面刚保存的模型清单。
      await this.editor.edit(entry, (raw) => {
        this.assertRevision(body.revision, resolveConfig(raw));
        const next = { ...object(raw), ...config };
        // 空路径在规范化配置中会被省略，合并时必须主动清除旧的自定义路径。
        if (!config.magpiePath) delete next.magpiePath;
        return next;
      });
      this.config = config;
      if (key) {
        try { await this.credentials.set(KEY_REF, key); }
        catch { return { ...await this.describe(), saved: true, sync: { ok: false, reason: '清单已保存，Key 保存失败；请重新输入 Key 后同步' } }; }
      }
      const sync = await this.sync(config);
      return { ...await this.describe(), saved: true, sync };
    });
  }
}
