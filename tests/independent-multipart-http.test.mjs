// Opt-in integration fixture: only synthetic data and a mock that blocks all network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
const enabled=process.env.INDEPENDENT_MULTIPART_HTTP_TEST==='1';
const root=resolve(process.env.GROK_TEST_ROOT||process.cwd());
const require=createRequire(join(resolve(process.env.GROK_TEST_DEPENDENCIES||root),'package.json'));
const Database=require('better-sqlite3');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok)});const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
test('HTTP status is read-only and uncertain second part is not repeated after process death',{skip:!enabled,timeout:180000},async()=>{
 if(process.platform!=='linux')throw Error('Linux process groups required');
 const dir=mkdtempSync(join(tmpdir(),'grok-multipart-http-'));mkdirSync(join(dir,'data'));writeFileSync(join(dir,'marker'),'independent-multipart-fixture\n');
 const port=await freePort(),origin=`http://127.0.0.1:${port}`,mock=join(process.cwd(),'tests/fixtures/independent-multipart-mock.cjs'),next=join(root,'node_modules/next/dist/bin/next');
 let child,db,log='',cookie='';
 const requests=()=>existsSync(join(dir,'requests.log'))?readFileSync(join(dir,'requests.log'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 async function start(){
  log='';child=spawn(process.execPath,[next,'dev','-H','127.0.0.1','-p',String(port)],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'development',DATA_DIR:join(dir,'data'),ADMIN_PASSWORD:'fixture-only-password',SESSION_SECRET:'fixture-only-secret-012345678901234567890',OPENROUTER_API_KEY:'fake-test-key',INDEPENDENT_MULTIPART_FIXTURE:dir,VIDEOMAKER_PUBLIC_ORIGIN:origin,NODE_OPTIONS:`--require=${mock}`}});
  child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
  for(let i=0;i<900;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error(`Fixture failed: ${log.slice(-1200)}`);if(log.includes('Ready'))try{if((await fetch(origin+'/api/health')).ok)return;}catch{}await sleep(50)}throw Error('Fixture failed to become ready');
 }
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,'SIGKILL');for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);}}
 async function call(url,method='GET',body){const headers={Origin:origin};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';const r=await fetch(origin+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};}
 try{
  await start();assert.equal((await call('/api/login','POST',{password:'fixture-only-password'})).status,200);
  assert.equal((await call('/api/generate')).status,200);
  db=new Database(join(dir,'data','videomaker.sqlite'),{fileMustExist:true});
  const researchId=randomUUID(),url='https://example.org/a';
  db.prepare('INSERT INTO research_reports(id,created_at,sources,report) VALUES(?,?,?,?)').run(researchId,new Date().toISOString(),JSON.stringify([{title:'Test',url,source:'Test',date:'',description:'Test'}]),JSON.stringify({sources:[{url}],source_excerpts:[{url,status:'retrieved',text:'Synthetischer Fakt.'}]}));
  const first=call('/api/generate','POST',{researchId,imageMode:'descriptions'}).catch(()=>null);
  for(let i=0;i<1200&&!existsSync(join(dir,'part2-inflight'));i++)await sleep(50);
  assert.ok(existsSync(join(dir,'part2-inflight')),'Mock did not reach the second part');
  const before=requests();assert.deepEqual(before.map(x=>x.phase),['facts','part1','part2']);
  let status=await call(`/api/generate?researchId=${researchId}`);assert.equal(status.status,200);assert.equal(status.data.partCount,3);assert.equal(status.data.completedParts,1);assert.equal(status.data.maxProviderAttempts,15);assert.equal(status.data.pipelinePhase,'script_pending');
  assert.deepEqual(status.data.parts.map(p=>[p.part,p.state]),[[1,'ready'],[2,'pending']]);
  const overlapping=await call('/api/generate','POST',{researchId,imageMode:'descriptions'});assert.equal(overlapping.status,409);
  for(let i=0;i<3;i++)assert.equal((await call(`/api/generate?researchId=${researchId}`)).status,200);
  assert.deepEqual(requests(),before,'GET must never call provider');
  await stop();await first;db.close();db=null;
  await start();status=await call(`/api/generate?researchId=${researchId}`);assert.equal(status.data.completedParts,1);assert.equal(status.data.partCount,3);
  const retry=await call('/api/generate','POST',{researchId,imageMode:'descriptions'});assert.equal(retry.status,409);assert.deepEqual(requests(),before,'unknown in-flight part must never be repeated');
 }finally{db?.close();await stop();rmSync(dir,{recursive:true,force:true});}
});
