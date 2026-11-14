// TEST ONLY: orchestrator must restart the disposable local server with each synthetic secret.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { isAbsolute,join } from 'node:path';
const origin=process.env.OIDC_BINDING_TEST_SERVER,dir=process.env.OIDC_BINDING_TEST_DATA,phase=process.env.OIDC_ROTATION_TEST_PHASE;
if(origin!=='http://127.0.0.1:3337'||!dir||!isAbsolute(dir)||process.env.OIDC_BINDING_FIXTURE_ALLOW_WRITES!=='1'||
 readFileSync(join(dir,'.oidc-test-fixture'),'utf8')!=='VIDEOMAKER OIDC TEST ONLY\n')throw new Error('Nur für isolierte OIDC-Testinstanzen');
const secret='isolated-oidc-bridge-test-secret-123456789',file=join(dir,'synthetic-rotation-reference.txt');
const internal=(op,extra={})=>fetch(`${origin}/api/internal/oidc/session-binding`,{method:'POST',headers:{'x-videomaker-internal-secret':secret,'x-oidc-binding-operation':op,...extra}});
if(phase==='seed'){
 const login=await fetch(`${origin}/api/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'isolated-oidc-test-password'})});
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],issued=await internal('issue',{cookie});assert.equal(issued.status,200);
 const {reference}=await issued.json();assert.equal((await internal('check',{'x-oidc-session-reference':reference})).status,204);
 writeFileSync(file,reference,{mode:0o600});
}else if(['rotated','rolled-back','missing'].includes(phase)){
 const reference=readFileSync(file,'utf8');
 const response=await internal('check',{'x-oidc-session-reference':reference});
 assert.equal(response.status,phase==='missing'?503:401);
}else throw new Error('Unbekannte Testphase');
console.log(`Synthetischer HTTP-Rotationstest ${phase}: erfolgreich.`);
