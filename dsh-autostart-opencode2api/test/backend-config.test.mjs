import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendPaths } from '../lib/backend.js';
import { backendApiKey, ensureBackendConfig, initialAdmin } from '../lib/backend-config.js';

test('首次配置随机密钥、随机密码、匿名上游、本地监听；重复调用不覆盖用户修改',t=>{
  const root=mkdtempSync(join(tmpdir(),'opencode-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const paths=backendPaths({DSH_OPENCODE2API_BACKEND_ROOT:root});
  assert.equal(ensureBackendConfig(paths,{host:'127.0.0.1',port:18980}).created,true);
  const config=JSON.parse(readFileSync(paths.config,'utf8'));
  assert.equal(config.listen,'127.0.0.1:18980');assert.equal(config.anonymous,true);
  assert.equal(config.webui.listen,'127.0.0.1:8081');
  assert.ok(backendApiKey(paths.config).length>32);
  assert.ok(initialAdmin(paths).password.length>=20);
  assert.notEqual(backendApiKey(paths.config),initialAdmin(paths).password);
  // 模拟后端把管理密码迁移成哈希；升级不能覆盖配置或丢失初始密码入口。
  delete config.webui.password;config.webui.password_hash='hash';config.zen_keys=['user-key'];
  const changed=JSON.stringify(config);writeFileSync(paths.config,changed);
  assert.equal(ensureBackendConfig(paths,{}).created,false);
  assert.equal(readFileSync(paths.config,'utf8'),changed);
  assert.ok(initialAdmin(paths).password);
});
