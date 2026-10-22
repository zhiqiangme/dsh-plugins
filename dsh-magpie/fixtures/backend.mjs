import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MagpieBackend } from '../lib/backend.js';
import { RELEASE_API, RELEASE_REPO, sha256 } from '../lib/release.js';

export function releaseFixture(version = '0.1.2', arch = 'amd64') {
  const bytes = Buffer.from(`magpie ${version}`);
  const name = `magpie-windows-${arch}.exe`, tag = `v${version}`;
  const asset = { name, size: bytes.length, browser_download_url: `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${name}`, digest: `sha256:${sha256(bytes)}` };
  const release = { tag_name: tag, published_at: '2026-10-22T00:00:00Z', assets: [asset] };
  const fetchImpl = async (url) => {
    if (url === RELEASE_API) return { ok: true, json: async () => release };
    if (url === asset.browser_download_url) return { ok: true, body: (async function* () { yield bytes.subarray(0, 4); yield bytes.subarray(4); })() };
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { bytes, asset, release, fetchImpl };
}
export function backendFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-magpie-backend-'));
  t.after(() => {
    // 递归清理只允许刚由测试在临时目录下创建的专用根目录。
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('dsh-magpie-backend-'));
    rmSync(root, { recursive: true, force: true });
  });
  const release = releaseFixture();
  const backend = new MagpieBackend({ env: { DSH_MAGPIE_BACKEND_ROOT: root }, platform: 'win32', arch: 'x64', fetchImpl: release.fetchImpl,
    probe: async (path) => {
      const match = /^magpie (\d+\.\d+\.\d+)$/.exec(readFileSync(path, 'utf8'));
      if (!match) throw new Error('not magpie');
      return match[1];
    }, isRunning: async () => false, ...options });
  t.after(() => backend.dispose());
  return { backend, root, ...release };
}
export async function finish(backend) {
  const pending = backend.pending;
  await pending?.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  return backend.operation;
}
