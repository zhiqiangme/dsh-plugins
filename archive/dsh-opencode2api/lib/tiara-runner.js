/** Tiara 的受管启动器：配置/会话独立于程序版本；原生 OpenCode 直接启动，不经 cmd。 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadTiaraProxy } from './tiara-compat.js';

const current = process.env.DSH_TIARA_CURRENT;
const data = process.env.DSH_TIARA_DATA;
let backend,
  proxy,
  stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  backend?.kill();
  proxy?.server?.close();
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), 2000);
  timer.unref();
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('disconnect', () => shutdown());
process.on('unhandledRejection', (error) => {
  console.error('[Tiara]', error);
  shutdown(1);
});

try {
  const saved = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  saved.API_KEY = process.env.DSH_TIARA_API_KEY || saved.API_KEY;
  if (!saved.API_KEY || !saved.OPENCODE_SERVER_PASSWORD) throw new Error('Tiara 配置缺少本地密钥或后端密码');
  const upstream = await loadTiaraProxy(current);
  const backendPort = Number(process.env.DSH_TIARA_SERVER_PORT);
  const backendURL = `http://127.0.0.1:${backendPort}`;
  const workspace = join(data, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const backendEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: upstream.buildBackendConfigContent(),
    OPENCODE_SERVER_PASSWORD: saved.OPENCODE_SERVER_PASSWORD,
    ...(saved.ZEN_API_KEY ? { OPENCODE_API_KEY: saved.ZEN_API_KEY } : {}),
    // 固定 XDG 目录，1.x 数据库与本机可能已安装的 2.x 彻底分开。
    XDG_CONFIG_HOME: join(data, 'config'),
    XDG_DATA_HOME: join(data, 'share'),
    XDG_CACHE_HOME: join(data, 'cache'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
  const binary = join(current, 'runtime', 'opencode.exe');
  backend = spawn(binary, ['serve', '--port', String(backendPort), '--hostname', '127.0.0.1'], {
    cwd: workspace,
    env: backendEnv,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  backend.on('error', (error) => {
    console.error('[Tiara] OpenCode 启动失败', error.message);
    shutdown(1);
  });
  backend.on('exit', () => {
    if (!stopping) {
      console.error('[Tiara] OpenCode 已退出');
      shutdown(1);
    }
  });
  const deadline = Date.now() + 100_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`${backendURL}/global/health`, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${saved.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(1500),
      });
      const body = await response.json();
      if (response.ok && body.healthy === true && /^1\./.test(body.version)) {
        ready = true;
        break;
      }
    } catch {
      /* 首次启动尚未监听，继续等同一个受管子进程。 */
    }
    await sleep(300);
  }
  if (!ready) throw new Error('兼容的 OpenCode 1.x 后端未就绪，请查看后端日志');
  // /global/health 在插件依赖与目录尚未初始化时就会成功。先等 1.x 的 provider API，
  // 让 OpenCode 自己完成首次插件依赖安装；API 对外就绪后 DSH 立即读目录不会再超时。
  console.log('[Tiara] 正在初始化 OpenCode 模型目录…');
  const catalogResponse = await fetch(`${backendURL}/config/providers`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${saved.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` },
    signal: AbortSignal.timeout(180_000),
  });
  const catalog = await catalogResponse.json();
  if (!catalogResponse.ok || !Array.isArray(catalog.providers)) throw new Error('OpenCode 模型目录初始化失败');
  if (!stopping) {
    proxy = upstream.startProxy({
      ...saved,
      PORT: Number(process.env.DSH_TIARA_PORT),
      BIND_HOST: process.env.DSH_TIARA_HOST,
      OPENCODE_SERVER_URL: backendURL,
      MANAGE_BACKEND: false,
      WEB_PANEL_ENABLED: true,
    });
    console.log('[Tiara] OpenCode2API 已就绪');
  }
} catch (error) {
  console.error('[Tiara]', error.message);
  shutdown(1);
}
