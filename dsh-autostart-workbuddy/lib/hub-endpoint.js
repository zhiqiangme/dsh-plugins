import { createServer } from 'node:http';
import { HUB_ROUTER_PATH } from './models.js';

/** 只接管本插件曾保存的本机 HTTP 路由，不能把 provider 的任意地址当成监听配置。 */
function savedEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.search || url.hash
      || url.pathname.replace(/\/$/, '') !== HUB_ROUTER_PATH) return undefined;
    return url;
  } catch { return undefined; }
}

/**
 * Desktop 每次启动都会换宿主端口。保留 provider 已保存的本机地址，使模型调用不依赖
 * 启动时成功热写配置（DSH 0.2.2 的 configEditor 可能在 root Include 校验处拒绝写入）。
 * 同源面板仍用宿主路由；兼容监听只复用相同的 Bearer 鉴权转发器，不开放面板或配置接口。
 */
export function createHubEndpoint({ webServer, router, savedBaseURL, onError = () => {} }) {
  const current = () => {
    try { return `${webServer.getOrigin()}${HUB_ROUTER_PATH}/`; } catch { return undefined; }
  };
  const saved = savedEndpoint(savedBaseURL);
  if (!saved || saved.href === current()) {
    return { baseURL: current, ready: Promise.resolve(), stop: async () => {} };
  }

  let baseURL;
  let stopped = false;
  const server = createServer((req, res) => router.handle(req, res));
  const ready = new Promise((resolve) => {
    server.on('error', (error) => {
      baseURL = undefined;
      onError(error);
      resolve();
    });
    server.listen(Number(saved.port), saved.hostname === '[::1]' ? '::1' : saved.hostname, () => {
      if (!stopped) baseURL = saved.href;
      resolve();
    });
  });
  server.unref();
  return {
    baseURL: () => baseURL,
    ready,
    async stop() {
      stopped = true;
      baseURL = undefined;
      await ready;
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
