import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import Database from 'better-sqlite3';

const enabled=process.env.GENERATION_RESTART_TEST_ALLOW_WRITES==='1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
 const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test('a killed server never reissues an unresolved provider request after restart',{skip:!enabled,timeout:120_000},async()=>{
 if(process.platform!=='linux')throw new Error('Der isolierte Prozessgruppentest benötigt Linux.');
 const fixture=mkdtempSync(join(tmpdir(),'videomaker-generation-restart-'));
 mkdirSync(join(fixture,'data'));writeFileSync(join(fixture,'.channel-fixture'),'isolated-channel-generation\n');
 const port=await freePort(),origin=`http://127.0.0.1:${port}`;let child,log='',cookie='';
 const next=join(process.cwd(),'node_modules/next/dist/bin/next'),mock=join(process.cwd(),'tests/fixtures/channel-generation-openrouter-mock.cjs');
 async function start(){
  log='';child=spawn(process.execPath,[next,'dev','-H','127.0.0.1','-p',String(port)],{cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'development',DATA_DIR:join(fixture,'data'),CHANNEL_GENERATION_FIXTURE_DIR:fixture,ADMIN_PASSWORD:'restart-local-test',SESSION_SECRET:'restart-test-secret-12345678901234567890',OPENROUTER_API_KEY:'invalid-mock-only',NODE_OPTIONS:`--require=${mock}`}});
  child.stdout.on('data',chunk=>{log+=chunk.toString();});child.stderr.on('data',chunk=>{log+=chunk.toString();});
  for(let i=0;i<400;i++){
   if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture startete nicht: ${log.slice(-1000)}`);
   if(log.includes('Ready'))try{const r=await fetch(origin+'/api/health');if(r.ok)return;}catch{}
   await sleep(50);
  }
  throw new Error('Zeitlimit beim Start der isolierten Fixture.');
 }
 async function stop(signal='SIGTERM'){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const proc=child;process.kill(-proc.pid,signal);
  for(let i=0;i<200&&proc.exitCode===null&&proc.signalCode===null;i++)await sleep(25);
  if(proc.exitCode===null&&proc.signalCode===null)throw new Error('Fixture-Prozess konnte nicht beendet werden.');
 }
 async function request(path,method='GET',body){
  const headers={Origin:origin};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};
 }
 try{
  await start();assert.equal((await request('/api/login','POST',{password:'restart-local-test'})).status,200);
  assert.equal((await request('/api/projects')).status,200);
  const id=randomUUID(),db=new Database(join(fixture,'data','videomaker.sqlite'),{fileMustExist:true});
  try{db.prepare('INSERT INTO research_reports VALUES(?,?,?,?)').run(id,new Date().toISOString(),'[]',JSON.stringify({marker:'TEST_DELETE_DURING_GENERATION'}));}finally{db.close();}
  assert.equal((await request('/api/generate?researchId='+id)).data.state,'not_started');
  const first=request('/api/generate','POST',{researchId:id,imageMode:'descriptions'}).then(()=>false,()=>true);
  for(let i=0;i<400&&!existsSync(join(fixture,'waiting'));i++)await sleep(25);
  assert.ok(existsSync(join(fixture,'waiting')),'der lokale Mock muss die Anfrage erhalten');
  const count=readFileSync(join(fixture,'ai-requests.log'),'utf8').trim().split('\n').length;assert.equal(count,1);
  await stop('SIGKILL');assert.equal(await first,true);
  await start();cookie='';assert.equal((await request('/api/login','POST',{password:'restart-local-test'})).status,200);
  assert.equal((await request('/api/generate?researchId='+id)).data.state,'pending');
  const again=await request('/api/generate','POST',{researchId:id,imageMode:'descriptions'});assert.equal(again.status,409);assert.equal(again.data.code,'generation_pending');
  assert.equal(readFileSync(join(fixture,'ai-requests.log'),'utf8').trim().split('\n').length,count);
  const check=new Database(join(fixture,'data','videomaker.sqlite'),{readonly:true,fileMustExist:true});
  try{assert.equal(check.prepare('SELECT count(*) AS n FROM projects').get().n,0);assert.ok(check.prepare('SELECT 1 FROM research_reports WHERE id=?').get(id));}finally{check.close();}
 }finally{
  await stop().catch(()=>{});
  // This directory was created by this test, never a user-supplied DATA_DIR.
  rmSync(fixture,{recursive:true,force:true});
 }
});
