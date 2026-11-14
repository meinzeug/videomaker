import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import Database from 'better-sqlite3';

const enabled=process.env.GROK_LEGACY_HTTP_TEST==='1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}

test('legacy received, pending, invalid and completed claims survive the Grok upgrade without another script request', {skip:!enabled,timeout:120_000},async()=>{
 if(process.platform!=='linux')throw new Error('Die isolierte Prozessgruppe benötigt Linux.');
 const fixture=mkdtempSync(join(tmpdir(),'videomaker-grok-legacy-'));
 mkdirSync(join(fixture,'data'));writeFileSync(join(fixture,'.channel-fixture'),'isolated-channel-generation\n');
 const port=await freePort(),origin=`http://127.0.0.1:${port}`;
 const next=join(process.cwd(),'node_modules/next/dist/bin/next'),mock=join(process.cwd(),'tests/fixtures/channel-generation-openrouter-mock.cjs');
 let child,log='',cookie='',database;
 async function call(path,method='GET',body){
  const headers={Origin:origin};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};
 }
 const logMessages=()=>existsSync(join(fixture,'ai-requests.log'))?readFileSync(join(fixture,'ai-requests.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
 function assertNoGrok(){assert.equal(logMessages().filter(m=>m?.[0]?.content?.includes('strukturiertes Faktenblatt')).length,0,'Alte Claims dürfen keinen neuen Grok-Faktenaufruf auslösen');}
 try {
  child=spawn(process.execPath,[next,'dev','-H','127.0.0.1','-p',String(port)],{cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'development',DATA_DIR:join(fixture,'data'),CHANNEL_GENERATION_FIXTURE_DIR:fixture,ADMIN_PASSWORD:'legacy-test-password',SESSION_SECRET:'legacy-test-secret-12345678901234567890',OPENROUTER_API_KEY:'invalid-mock-only',NODE_OPTIONS:`--require=${mock}`}});
  child.stdout.on('data',chunk=>{log+=chunk.toString();});child.stderr.on('data',chunk=>{log+=chunk.toString();});
  let ready=false;for(let i=0;i<400;i++){if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture-Start fehlgeschlagen: ${log.slice(-1000)}`);if(log.includes('Ready'))try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await sleep(50);}assert.ok(ready,'isolierter Server muss starten');
  assert.equal((await call('/api/login','POST',{password:'legacy-test-password'})).status,200);
  assert.equal((await call('/api/channels')).status,200);
  assert.equal((await call('/api/generate')).status,200);
  database=new Database(join(fixture,'data','videomaker.sqlite'),{fileMustExist:true});
  const channel={id:randomUUID(),name:'Archivkanal',platform:'youtube',handle:''};
  database.prepare('INSERT INTO channels(id,name,platform,handle,created_at) VALUES(?,?,?,?,?)').run(channel.id,channel.name,channel.platform,channel.handle,'2026-01-01');
  const output={titles:['Alttitel','Alternative 1','Alternative 2'],thumbnail:'Archivbild',broll:['Bild 1','Bild 2'],script:'Dies ist ein alter Sprechertext. Er bleibt erhalten.'};
  const insert=database.prepare(`INSERT INTO generation_claims(research_id,project_id,image_mode,requested_channel,sources_json,report_json,channel_json,state,response_text,response_truncated,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const seed=(state,response,requested=channel.id,snapshot=channel,truncated=0)=>{const researchId=randomUUID(),projectId=randomUUID();insert.run(researchId,projectId,'descriptions',requested,'[]',JSON.stringify({summary:'Alte Recherche'}),JSON.stringify(snapshot),state,response,truncated,'2026-01-01','2026-01-01');return {researchId,projectId};};
  const received=seed('received',JSON.stringify(output));
  let response=await call('/api/generate','POST',{researchId:received.researchId,imageMode:'descriptions',channelId:channel.id});
  assert.equal(response.status,200);assert.equal(response.data.id,received.projectId);assert.match(response.data.content.script,/Dies ist ein alter Sprechertext/);
  assert.deepEqual((await call(`/api/projects/${received.projectId}/channels`)).data.channelIds,[channel.id]);assertNoGrok();
  response=await call('/api/generate','POST',{researchId:received.researchId,imageMode:'descriptions',channelId:channel.id});
  assert.equal(response.status,200);assert.equal(response.data.id,received.projectId);assertNoGrok();
  assert.equal((await call(`/api/generate?researchId=${received.researchId}`)).data.state,'complete');
  assert.equal((await call('/api/generate','POST',{researchId:received.researchId,imageMode:'render',channelId:channel.id})).status,409);
  const pending=seed('pending',null,'',null);
  response=await call('/api/generate','POST',{researchId:pending.researchId,imageMode:'descriptions'});assert.equal(response.status,409);assert.equal(response.data.code,'generation_pending');
  assert.equal((await call(`/api/generate?researchId=${pending.researchId}`)).data.state,'pending');assertNoGrok();
  const invalid=seed('invalid','unvollständige alte Antwort','',null);
  response=await call('/api/generate','POST',{researchId:invalid.researchId,imageMode:'descriptions'});assert.equal(response.status,409);assert.equal(response.data.code,'generation_invalid');
  assert.equal((await call(`/api/generate?researchId=${invalid.researchId}`)).data.responseText,'unvollständige alte Antwort');assertNoGrok();
  const truncated=seed('received',JSON.stringify(output),'',null,1);
  response=await call('/api/generate','POST',{researchId:truncated.researchId,imageMode:'descriptions'});assert.equal(response.status,409);assert.equal(response.data.code,'generation_invalid');assertNoGrok();
  const completed=seed('complete',JSON.stringify(output),'',null);
  database.prepare('INSERT INTO projects(id,created_at,title,sources,content) VALUES(?,?,?,?,?)').run(completed.projectId,'2026-01-01','Archiviert','[]',JSON.stringify(output));
  response=await call('/api/generate','POST',{researchId:completed.researchId,imageMode:'descriptions'});assert.equal(response.status,200);assert.equal(response.data.id,completed.projectId);assertNoGrok();
  const missing=seed('complete',JSON.stringify(output),'',null);
  assert.equal((await call(`/api/generate?researchId=${missing.researchId}`)).data.state,'project_missing');
  response=await call('/api/generate','POST',{researchId:missing.researchId,imageMode:'descriptions'});assert.equal(response.status,410);assert.equal(response.data.code,'generation_project_missing');assertNoGrok();
  const changed=seed('received',JSON.stringify(output));database.prepare('UPDATE channels SET name=? WHERE id=?').run('Geänderter Kanal',channel.id);
  response=await call('/api/generate','POST',{researchId:changed.researchId,imageMode:'descriptions',channelId:channel.id});assert.equal(response.status,200);assert.match(response.data.channelWarning,/ohne Zuordnung/);
  assert.deepEqual((await call(`/api/projects/${changed.projectId}/channels`)).data.channelIds,[]);assertNoGrok();
 } finally {
  database?.close();
  if(child&&child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,'SIGTERM');for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);if(child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,'SIGKILL');}
  // Only this test's freshly created private fixture is ever removed.
  rmSync(fixture,{recursive:true,force:true});
 }
});
