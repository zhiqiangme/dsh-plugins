import { createServer } from 'node:http';
import { ROUTER_BASE_PATH } from './auto-route.js';
import { ROUTER_PATH } from './router.js';

/** 只复用本插件保存过的本机路由地址，不能把 Magpie 或用户的其它地址当成监听配置。 */
function savedEndpoint(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/$/, '');
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port
      || url.username || url.password || url.search || url.hash || ![ROUTER_BASE_PATH, ROUTER_PATH].includes(path)) return undefined;
    return url;
  } catch { return undefined; }
}

/**
 * Desktop 换宿主端口时，已保存的 auto provider 仍可能先引用旧端口。
 * 与 WB 一样保留旧监听作兼容转发；只处理模型调用，不开放面板或配置接口。
 */
export function createRouterEndpoint({ webServer, router, savedBaseURL, onError = () => {} }) {
  const current = () => {
    try { return webServer.getOrigin().replace(/\/$/, ''); } catch { return undefined; }
  };
  const saved = savedEndpoint(savedBaseURL);
  if (!saved || saved.origin === current()) return { baseURL: current, ready: Promise.resolve(), stop: async () => {} };
  let baseURL, stopped = false;
  const server = createServer((req, res) => router.handle(req, res));
  const ready = new Promise((resolve) => {
    server.on('error', (error) => { baseURL = undefined; onError(error); resolve(); });
    server.listen(Number(saved.port), saved.hostname === '[::1]' ? '::1' : saved.hostname, () => {
      if (!stopped) baseURL = saved.origin;
      resolve();
    });
  });
  server.unref();
  return {
    baseURL: () => baseURL,
    ready,
    async stop() {
      stopped = true; baseURL = undefined;
      await ready;
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
