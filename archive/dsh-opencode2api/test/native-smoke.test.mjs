/** 可选真实程序测试：二进制路径由环境提供，上游指向本地替身，不消耗真实模型额度。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePluginConfig } from '../lib/config.js';
import { ensureBackendConfig, backendApiKey } from '../lib/backend-config.js';
import { GatewayService } from '../lib/gateway-service.js';
import { readBuildInfo } from '../lib/backend.js';
import { serve } from '../fixtures/http-fixture.mjs';

async function freePort() {
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();await new Promise(resolve=>server.close(resolve));return port;
}
test('官方 Windows exe：配置可启动、健康契约、API 鉴权、管理页与退出回收',
  {skip:!process.env.OPENCODE2API_TEST_EXE},async(t)=>{
    const upstream=await serve(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'big-pickle',object:'model'}]}));});
    const root=mkdtempSync(join(tmpdir(),'opencode-native-'));
    const port=await freePort(),webPort=await freePort();
    const resolved=resolvePluginConfig({port,webPort,backend:{checkOnStart:false}}, {DSH_OPENCODE2API_BACKEND_ROOT:root});
    ensureBackendConfig(resolved.paths,resolved.spec);
    const config=JSON.parse(readFileSync(resolved.paths.config,'utf8'));
    config.upstream={zen:upstream,go:upstream,anonymous:upstream};
    writeFileSync(resolved.paths.config,JSON.stringify(config));
    copyFileSync(process.env.OPENCODE2API_TEST_EXE,resolved.spec.exe);
    assert.match(readBuildInfo(resolved.spec.exe).revision,/^[a-f0-9]{40}$/);
    const service=new GatewayService(resolved.spec,{info(){},warn(){},error(){}});
    t.after(async()=>{await service.stop('test cleanup');rmSync(root,{recursive:true,force:true});});
    const result=await service.ensureRunning();
    assert.equal(result.state,'started',result.reason);assert.equal(result.health.ok,true);
    const unauthorized=await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(unauthorized.status,401);
    const models=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:`Bearer ${backendApiKey(resolved.paths.config)}`}});
    assert.equal(models.status,200);assert.ok(Array.isArray((await models.json()).data));
    assert.equal((await fetch(resolved.panelUrl)).status,200);
    await service.stop('test finished');assert.equal(service.isAlive(),false);
  });
