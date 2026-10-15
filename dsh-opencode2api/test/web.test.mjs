import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ensureBackendConfig } from '../lib/backend-config.js';
import { resolvePluginConfig } from '../lib/config.js';
import { applySelection, describeModels, registerPanelRoutes, MODELS_PATH, PANEL_KEY_PATH, BACKEND_PATH } from '../lib/web.js';
import { createFakeConfigEditor, profileRows } from '../fixtures/fake-config-editor.mjs';
import { catalog, memoryCredentials, serve } from '../fixtures/http-fixture.mjs';

async function request(handler,{method='GET',origin,body}={}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=method;req.url='/';req.headers=origin?{origin}:{};
  const res={writeHead(status){this.status=status;},end(text){this.body=JSON.parse(text);}};
  await handler(req,res);return res;
}
test('路由鉴权边界，管理页与 API 独立端口，普通状态接口不泄露密码',async(t)=>{
  const root=mkdtempSync(join(tmpdir(),'opencode-web-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={DSH_OPENCODE2API_BACKEND_ROOT:root};const resolved=resolvePluginConfig({},env);
  ensureBackendConfig(resolved.paths,resolved.spec);
  const routes=new Map(),disposers=[];
  const ctx={webServer:{register:({path,handler})=>{routes.set(path,handler);return()=>routes.delete(path);}},effect:(f)=>disposers.push(f()),get:()=>undefined};
  registerPanelRoutes(ctx,{resolved,env,logger:{warn(){}},checkVersion:async()=>({ok:false})});
  t.after(()=>{for(const dispose of disposers)dispose?.();});
  assert.equal((await request(routes.get(PANEL_KEY_PATH))).status,405);
  assert.equal((await request(routes.get(PANEL_KEY_PATH),{method:'POST',origin:'https://evil.example',body:{}})).status,403);
  const password=await request(routes.get(PANEL_KEY_PATH),{method:'POST',body:{}});
  assert.equal(password.status,200);assert.ok(password.body.key.length>=20);
  const snapshot=await request(routes.get(BACKEND_PATH));
  assert.equal(snapshot.body.backend.panelUrl,'http://127.0.0.1:8081/');
  assert.ok(!JSON.stringify(snapshot.body).includes(password.body.key));
  assert.equal((await request(routes.get(MODELS_PATH),{method:'DELETE'})).status,405);
  assert.equal((await request(routes.get(BACKEND_PATH),{method:'POST',body:{action:'uninstall'}})).status,400);
});
test('模型卡片显示真实能力和价格，保存勾选立即同步',async(t)=>{
  const url=await serve(t,(_req,res)=>res.end(JSON.stringify({data:catalog})));
  const resolved=resolvePluginConfig({models:{enabled:false,apiKey:'key',baseURL:url}},{});
  const editor=createFakeConfigEditor(profileRows({withProvider:false,models:{enabled:false}}));
  const credentials=memoryCredentials();
  const snapshot=await describeModels({...resolved,editor,credentials,env:{}});
  assert.equal(snapshot.models.length,2);assert.equal(snapshot.models[0].credits,'Free');
  assert.equal(snapshot.models[0].vision,true);
  const result=await applySelection({resolved,editor,credentials,env:{},enabled:true,only:['vision-free']});
  assert.equal(result.sync.state,'updated');assert.equal(result.sync.count,1);
  assert.deepEqual(editor.entry('dsh-opencode2api').options.config.models.only,['vision-free']);
  assert.equal((await applySelection({resolved,editor,only:'bad'})).ok,false);
});
