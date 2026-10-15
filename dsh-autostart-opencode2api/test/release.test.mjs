import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindowsAsset } from '../lib/release.js';
test('正式资产格式：区分 Windows x64、ARM64，不误选 macOS 或校验和',()=>{
  const names=['opencode2api_v1.4.0_darwin_amd64.tar.gz','opencode2api_v1.4.0_windows_arm64.zip',
    'opencode2api_v1.4.0_windows_amd64.zip.sha256','opencode2api_v1.4.0_windows_amd64.zip'];
  const assets=names.map(name=>({name}));
  assert.equal(pickWindowsAsset(assets,'x64').name,names[3]);
  assert.equal(pickWindowsAsset(assets,'arm64').name,names[1]);
  assert.throws(()=>pickWindowsAsset(assets,'ia32'),/不支持/);
  assert.throws(()=>pickWindowsAsset([],'arm64'),/没有.*windows_arm64/);
});
