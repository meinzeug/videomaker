// Opt-in only: this test creates and deletes synthetic projects in a dedicated loopback fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';

const origin=process.env.LAN_CAPTURE_TEST_SERVER,dir=process.env.LAN_CAPTURE_TEST_DATA;
const marker=dir&&isAbsolute(dir)?join(dir,'.lan-capture-test-fixture'):'';
const enabled=origin==='http://127.0.0.1:3339'&&process.env.LAN_CAPTURE_FIXTURE_ALLOW_WRITES==='1'&&marker&&existsSync(marker)&&readFileSync(marker,'utf8')==='VIDEOMAKER LAN CAPTURE TEST ONLY\n';
const baseHeaders={origin,'content-type':'application/json'};
const endpoint='/api/projects/lan-captures';

test('neutraler LAN-Projektfallback prüft Session und Origin und bleibt bei Retry/Neustartversuch atomar',{skip:!enabled,timeout:60000},async()=>{
 const login=async()=>{
  const r=await fetch(`${origin}/api/login`,{method:'POST',headers:baseHeaders,body:JSON.stringify({password:'isolated-lan-capture-test-password'})});
  assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];
 };
 const call=(cookie,recording,options={})=>fetch(`${origin}${endpoint}`,{method:'POST',headers:{...baseHeaders,...(cookie?{cookie}:{}),...options.headers},body:options.body??JSON.stringify({recordingId:recording})});
 const recording=randomUUID(),cookie=await login(),createdProjects=[];
 try{
  assert.equal((await call(null,recording)).status,403);
  assert.equal((await call(cookie,recording,{headers:{origin:'https://fremd.invalid'}})).status,403);
  assert.equal((await call(cookie,'ungueltig')).status,400);
  assert.equal((await call(cookie,recording,{body:JSON.stringify({recordingId:recording,script:'darf nicht übertragen werden'})})).status,400);
  assert.equal((await call(cookie,recording,{body:'x'.repeat(1025)})).status,413);
  const initial=await call(cookie,recording);assert.equal(initial.status,201);const project=await initial.json();
  assert.equal(project.recordingId,recording);assert.equal(project.created,true);assert.match(project.projectId,/^[0-9a-f-]{36}$/);createdProjects.push(project.projectId);
  const retry=await call(cookie,recording.toUpperCase());assert.equal(retry.status,200);assert.deepEqual(await retry.json(),{projectId:project.projectId,recordingId:recording,created:false});
  const parallelId=randomUUID(),replies=await Promise.all([call(cookie,parallelId),call(cookie,parallelId)]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,201]);const values=await Promise.all(replies.map(r=>r.json()));
  assert.equal(values[0].projectId,values[1].projectId);createdProjects.push(values[0].projectId);
  const projects=await fetch(`${origin}/api/projects`,{headers:{cookie}});assert.equal(projects.status,200);
  const contents=await projects.json(),neutral=contents.find(p=>p.id===project.projectId);
  assert.equal(neutral.title,'Aufnahme ohne Skript');assert.equal(neutral.content.script,'');assert.deepEqual(neutral.sources,[]);
  const deleted=await fetch(`${origin}/api/projects/${project.projectId}`,{method:'DELETE',headers:{origin,cookie}});assert.equal(deleted.status,200);
  const afterDelete=await call(cookie,recording);assert.equal(afterDelete.status,409);assert.equal((await afterDelete.json()).code,'project_deleted');
  // Send only a partial body, revoke this separate cookie, then finish the body.
  const revokedCookie=await login(),delayedId=randomUUID(),body=JSON.stringify({recordingId:delayedId}),split=body.length-3;
  const responsePromise=new Promise((resolve,reject)=>{
   const request=httpRequest(`${origin}${endpoint}`,{method:'POST',headers:{...baseHeaders,cookie:revokedCookie,'content-length':Buffer.byteLength(body)}},response=>{
    let data='';response.setEncoding('utf8');response.on('data',part=>data+=part);response.on('end',()=>resolve({status:response.statusCode,data}));
   });request.on('error',reject);request.write(body.slice(0,split));
   setTimeout(async()=>{
    try{const logout=await fetch(`${origin}/api/logout`,{method:'POST',headers:{origin,cookie:revokedCookie}});assert.equal(logout.status,200);request.end(body.slice(split));}
    catch(error){request.destroy(error);}
   },500);
  });
  const revoked=await responsePromise;assert.ok([401,403].includes(revoked.status));
  const final=await fetch(`${origin}/api/projects`,{headers:{cookie}});assert.equal(final.status,200);
  assert.equal((await final.json()).length,1,'widerrufene Anfrage darf kein weiteres Projekt erzeugen');
 }finally{
  for(const project of createdProjects)await fetch(`${origin}/api/projects/${project}`,{method:'DELETE',headers:{origin,cookie}}).catch(()=>{});
 }
});

test('ein langsamer gestückelter Body überschreitet eine Gesamtfrist',{skip:!enabled,timeout:20000},async()=>{
 const login=await fetch(`${origin}/api/login`,{method:'POST',headers:baseHeaders,body:JSON.stringify({password:'isolated-lan-capture-test-password'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const before=performance.now();let timer;
 const result=await new Promise(resolve=>{
  const request=httpRequest(`${origin}${endpoint}`,{method:'POST',headers:{...baseHeaders,cookie,'content-length':'500'}},response=>{
   response.resume();response.on('end',()=>{clearInterval(timer);request.destroy();resolve({status:response.statusCode});});
  });
  request.on('error',()=>{clearInterval(timer);resolve({status:0});});
  request.write('{');timer=setInterval(()=>request.write(' '),1000);
 });
 assert.ok([0,400].includes(result.status),'Request wird ohne Projektanlage beendet');
 assert.ok(performance.now()-before<14000,'regelmäßige Mini-Chunks verlängern die Gesamtfrist nicht');
 const projects=await fetch(`${origin}/api/projects`,{headers:{cookie}});assert.equal(projects.status,200);assert.equal((await projects.json()).length,0);
});
