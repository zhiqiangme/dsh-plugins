import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ensureBackendConfig } from '../lib/backend-config.js';
import { resolvePluginConfig } from '../lib/config.js';
import { applySelection, describeModels, registerPanelRoutes, BACKEND_NOT_INSTALLED, MODELS_PATH, PANEL_KEY_PATH, BACKEND_PATH } from '../lib/web.js';
import { createFakeConfigEditor, profileRows } from '../fixtures/fake-config-editor.mjs';
import { catalog, memoryCredentials, serve } from '../fixtures/http-fixture.mjs';

async function request(handler,{method='GET',origin,body,remoteAddress='127.0.0.1',contentType}={}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=method;req.url='/';req.socket={remoteAddress};
  req.headers={host:'127.0.0.1:3000',...(origin?{origin}:{}),...(body===undefined?{}:{'content-type':contentType??'application/json'})};
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
  // 本机其他端口的网页、局域网来的请求、绕开 CORS 预检的 text/plain 都要拒掉。
  assert.equal((await request(routes.get(PANEL_KEY_PATH),{method:'POST',origin:'http://localhost:5173',body:{}})).status,403);
  assert.equal((await request(routes.get(PANEL_KEY_PATH),{method:'POST',remoteAddress:'192.168.1.5',body:{}})).status,403);
  assert.equal((await request(routes.get(BACKEND_PATH),{method:'POST',contentType:'text/plain',body:{action:'uninstall',confirm:true}})).status,415);
  assert.equal((await request(routes.get(PANEL_KEY_PATH),{method:'POST',origin:'http://127.0.0.1:3000',body:{}})).status,200);
  assert.equal((await request(routes.get(BACKEND_PATH),{remoteAddress:'::ffff:127.0.0.1'})).status,200);
  const password=await request(routes.get(PANEL_KEY_PATH),{method:'POST',body:{}});
  assert.equal(password.status,200);assert.ok(password.body.key.length>=20);
  const snapshot=await request(routes.get(BACKEND_PATH));
  assert.equal(snapshot.body.backend.panelUrl,'http://127.0.0.1:8081/');
  assert.ok(!JSON.stringify(snapshot.body).includes(password.body.key));
  assert.equal((await request(routes.get(MODELS_PATH),{method:'DELETE'})).status,405);
  assert.equal((await request(routes.get(BACKEND_PATH),{method:'POST',body:{action:'uninstall'}})).status,400);
  // 清除后端数据同样必须带 confirm，否则一个误发的请求就能删掉凭证。
  const purge=await request(routes.get(BACKEND_PATH),{method:'POST',body:{action:'purge'}});
  assert.equal(purge.status,400);assert.match(purge.body.reason,/二次确认/);
  assert.equal(snapshot.body.backend.rootExists,true);
});
test('有 connection 服务时按宿主浏览器会话鉴权，未登录返回 401',async(t)=>{
  const root=mkdtempSync(join(tmpdir(),'opencode-web-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={DSH_OPENCODE2API_BACKEND_ROOT:root};const resolved=resolvePluginConfig({},env);
  ensureBackendConfig(resolved.paths,resolved.spec);
  let verdict=401;const seen=[];
  const connection={requestRejection:(req)=>{seen.push(req);return verdict;}};
  const routes=new Map(),disposers=[];
  const ctx={webServer:{register:({path,handler})=>{routes.set(path,handler);return()=>routes.delete(path);}},effect:(f)=>disposers.push(f()),
    get:(name)=>(name==='connection'?connection:undefined)};
  registerPanelRoutes(ctx,{resolved,env,logger:{warn(){}},checkVersion:async()=>({ok:false})});
  t.after(()=>{for(const dispose of disposers)dispose?.();});
  const denied=await request(routes.get(PANEL_KEY_PATH),{method:'POST',body:{}});
  assert.equal(denied.status,401);assert.equal(denied.body.key,undefined);
  verdict=undefined;
  // 宿主放行即可，不再叠加本地的回环地址规则（桌面端请求经 Electron 转发，宿主已校验）。
  assert.equal((await request(routes.get(PANEL_KEY_PATH),{method:'POST',remoteAddress:'10.0.0.2',body:{}})).status,200);
  assert.equal(seen.length,2);
});
test('后端没装且拉不到模型时给出"去点安装"状态；端口上有别的后端能答时照常显示',async(t)=>{
  const root=mkdtempSync(join(tmpdir(),'opencode-web-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={DSH_OPENCODE2API_BACKEND_ROOT:root};
  // 端口 1 上不会有服务：拉取必然失败。
  const missing=resolvePluginConfig({models:{apiKey:'key',baseURL:'http://127.0.0.1:1'}},env);
  assert.equal(missing.managedExe,true);
  const snapshot=await describeModels({...missing,env:{}});
  assert.equal(snapshot.ok,false);assert.equal(snapshot.state,BACKEND_NOT_INSTALLED);assert.match(snapshot.reason,/安装/);
  // 自配 exe（外部后端）时不知道装没装，保留原始错误。
  const external=resolvePluginConfig({exe:join(root,'nope.exe'),models:{apiKey:'key',baseURL:'http://127.0.0.1:1'}},env);
  assert.equal((await describeModels({...external,env:{}})).state,undefined);
  const url=await serve(t,(_req,res)=>res.end(JSON.stringify({data:catalog})));
  const answering=resolvePluginConfig({models:{apiKey:'key',baseURL:url}},env);
  assert.equal((await describeModels({...answering,env:{}})).ok,true,'exe 不在但端口能答时不误报未安装');
});
test('只打开同步开关（省略 only）时沿用已有白名单并立即同步',async(t)=>{
  const url=await serve(t,(_req,res)=>res.end(JSON.stringify({data:catalog})));
  const resolved=resolvePluginConfig({models:{enabled:false,apiKey:'key',baseURL:url,only:['vision-free']}},{});
  const editor=createFakeConfigEditor(profileRows({withProvider:false,models:{enabled:false,only:['vision-free']}}));
  const result=await applySelection({resolved,editor,credentials:memoryCredentials(),env:{},enabled:true});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.only,['vision-free'],'不能把用户之前的勾选清空');
  assert.equal(result.sync.state,'updated');assert.equal(result.sync.count,1);
  const saved=editor.entry('dsh-opencode2api').options.config.models;
  assert.equal(saved.enabled,true);assert.deepEqual(saved.only,['vision-free']);
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
  // 既不带 only 也不带 enabled 的空请求没有意义，仍按参数缺失拒绝。
  assert.equal((await applySelection({resolved,editor})).ok,false);
});

test('网关切换只写当前插件的 gateway，保留模型选择、端口及其他后端配置',async()=>{
  const {selectGateway}=await import('../lib/web.js');
  const editor=createFakeConfigEditor(profileRows({models:{enabled:true,only:['saved-model']}}));
  const row=editor.entry('dsh-opencode2api');row.options.config={...row.options.config,port:9123,exe:'custom.exe'};
  const resolved=resolvePluginConfig(row.options.config,{DSH_HOME:join(tmpdir(),'not-used')});
  const before=structuredClone(row.options.config);
  assert.equal((await selectGateway({resolved,editor,gateway:'bad'})).ok,false);
  assert.equal((await selectGateway({resolved,editor,gateway:'tiara',busy:true})).ok,false);
  assert.deepEqual(row.options.config,before);
  const result=await selectGateway({resolved,editor,gateway:'tiara'});
  assert.equal(result.state,'switched');assert.equal(result.restarting,true);
  assert.deepEqual(editor.entry('dsh-opencode2api').options.config,{...before,gateway:'tiara'});
  assert.equal(resolved.gateway,'jasonxu','当前解析结果在旧实例释放前不能先换网关');
});

test('Tiara 卡片快照与面板密钥按所选后端返回，普通快照不暴露访问密钥',async t=>{
  const {ensureTiaraConfig}=await import('../lib/tiara.js');
  const {readPanelKey}=await import('../lib/web.js');
  const root=mkdtempSync(join(tmpdir(),'tiara-web-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={DSH_OPENCODE2API_BACKEND_ROOT:root};const resolved=resolvePluginConfig({gateway:'tiara'},env);ensureTiaraConfig(resolved.paths);
  const key=readPanelKey(resolved);assert.equal(key.gateway,'tiara');assert.ok(key.key.length>20);
  const routes=new Map();const ctx={webServer:{register:({path,handler})=>{routes.set(path,handler);return()=>{};}},effect:f=>f(),get:()=>undefined};
  registerPanelRoutes(ctx,{resolved,env,logger:{warn(){}},checkVersion:async()=>({ok:false})});
  const response=await request(routes.get(BACKEND_PATH));
  assert.equal(response.body.backend.gateway,'tiara');assert.deepEqual(response.body.backend.gateways,['jasonxu','tiara']);
  assert.equal(response.body.backend.panelUrl,'http://127.0.0.1:8080/panel');assert.equal(response.body.backend.exeExists,false);
  assert.equal(JSON.stringify(response.body).includes(key.key),false);
  const missing=await describeModels({...resolved,models:{...resolved.models,baseURL:'http://127.0.0.1:1'},env});
  assert.equal(missing.state,BACKEND_NOT_INSTALLED,'已存在的 DSH Node 运行时不能被当成已安装的 Tiara');
});

test('启动操作立即返回 202；页面重入看见同一任务，重复安装被拒绝，结束后结果保留', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tiara-web-operation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { DSH_OPENCODE2API_BACKEND_ROOT: root }, resolved = resolvePluginConfig({ gateway: 'tiara' }, env);
  const routes = new Map(), disposers = [];
  let finish;
  const service = { ensureRunning: async () => new Promise(resolve => { finish = resolve; }) };
  const ctx = { webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {}; } },
    effect: f => disposers.push(f()), get: () => undefined };
  registerPanelRoutes(ctx, { resolved, env, service, logger: { warn() {} } });
  t.after(async () => { for (const dispose of disposers) await dispose?.(); });
  const started = await request(routes.get(BACKEND_PATH), { method: 'POST', body: { action: 'start' } });
  assert.equal(started.status, 202);
  const snapshot = await request(routes.get(BACKEND_PATH));
  assert.equal(snapshot.body.operation.id, started.body.operation.id);
  assert.equal(snapshot.body.operation.progress.stage, 'startup');
  assert.equal((await request(routes.get(BACKEND_PATH), { method: 'POST', body: { action: 'install' } })).status, 409);
  assert.equal((await request(routes.get(MODELS_PATH))).body.state, 'backend-installing');
  finish({ state: 'failed', reason: 'backend rejected startup' });
  let done;
  for (let n = 0; n < 20; n++) {
    done = (await request(routes.get(BACKEND_PATH))).body.operation;
    if (done.state !== 'running') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(done.state, 'failed');
  assert.match(done.result.reason, /rejected/);
});
