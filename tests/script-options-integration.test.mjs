import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {existsSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import Database from 'better-sqlite3';
import {request as httpRequest} from 'node:http';
import {KONTRAKURS_SCRIPT_SYSTEM,CHANNEL_SCRIPT_SYSTEM} from '../lib/grok-prompt.ts';

const server=process.env.SCRIPT_OPTIONS_TEST_SERVER;
const enabled=!!server&&process.env.SCRIPT_OPTIONS_TEST_ALLOW_WRITES==='1';
const options={mode:'source',scope:'selected',tones:['frech','alltag'],dramaturgy:'Dramaturgie TEST',instructions:'Kein eigener Kommentar',allowIncompleteSources:true};
const source={title:'TEST_SAVE_FAILURE',url:'https://127.0.0.1/selected',source:'Gewählte Quelle',date:'',description:'Ausgewählte und ausdrücklich bereitgestellte Kurzbeschreibung.'};

test('isolated selected-source flow retains validated options through failure and retry',{skip:!enabled,timeout:120_000},async()=>{
 assert.equal(new URL(server).href,'http://127.0.0.1:3376/');
 const fixture=realpathSync(process.env.CHANNEL_GENERATION_FIXTURE_DIR||'');
 assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.match(basename(fixture),/^videomaker-channel-fixture\.[A-Za-z0-9]{6,}$/);
 const marker=join(fixture,'.channel-fixture');assert.equal(realpathSync(marker),marker);assert.equal(readFileSync(marker,'utf8'),'isolated-channel-generation\n');
 const base=new URL(server).origin;let cookie='';
 async function call(path,method='GET',body,authenticated=true){
  const headers={Origin:base};if(cookie&&authenticated)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'}),set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};
 }
 const log=join(fixture,'ai-requests.log');const count=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).length:0;
 const matching=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(messages=>messages?.at(-1)?.content?.includes('TEST_SAVE_FAILURE')).length:0;
 assert.equal((await call('/api/research','POST',{topic:'Thema',sources:[source],scriptOptions:options},false)).status,403);
 assert.equal((await call('/api/login','POST',{password:'channel-local-test'})).status,200);
 const before=count();
 assert.equal((await call('/api/research','POST',{topic:'Thema',sources:[source],scriptOptions:{...options,scope:['selected']}})).status,400);
 assert.equal((await call('/api/research','POST',{topic:'Thema',sources:[source],scriptOptions:{...options,mode:['source']}})).status,400);
 assert.equal(count(),before,'invalid type must not start web search');
 assert.equal((await call('/api/research','POST',{topic:'Thema',sources:[],scriptOptions:options})).status,400);
 let r=await call('/api/research','POST',{topic:'Thema',sources:[source],scriptOptions:{...options,allowIncompleteSources:false}});assert.equal(r.status,422);assert.match(r.data.error,/TEST_SAVE_FAILURE/);
 r=await call('/api/research','POST',{topic:'Thema',sources:[{...source,description:''}],scriptOptions:options});assert.equal(r.status,422);assert.match(r.data.error,/keine Kurzbeschreibung/i);
 r=await call('/api/research','POST',{topic:'Thema',angle:'UNSELECTED_ANGLE',sources:[source],scriptOptions:options});assert.equal(r.status,200);
 assert.equal(count(),before,'selected sources must not invoke search or AI during retrieval');
 assert.equal(r.data.report.source_mode,'selected');assert.equal(r.data.report.source_access[0].status,'unavailable');assert.deepEqual(r.data.report.sources.map(s=>s.url),[source.url]);
 const id=r.data.id;
 const bad={researchId:id,imageMode:'descriptions',channelId:null,scriptOptions:{...options,instructions:'verändert'}};
 assert.equal((await call('/api/generate','POST',bad)).status,409);assert.equal(count(),before,'mismatched options must not start paid work');
 const dbPath=join(fixture,'data','videomaker.sqlite');assert.equal(realpathSync(dbPath),dbPath);const db=new Database(dbPath,{fileMustExist:true});
 try{
  db.exec("CREATE TRIGGER script_fixture_fail_save BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'fixture save failure'); END");
  r=await call('/api/generate','POST',{...bad,scriptOptions:options});assert.equal(r.status,500);
  const after=count(),matchingAfter=matching();assert.equal(after,before+2);assert.equal(matchingAfter,2);
  const requests=readFileSync(log,'utf8').trim().split('\n').slice(-2).map(JSON.parse),[factsRequest,scriptRequest]=requests;
  assert.match(factsRequest[0].content,/strukturiertes Faktenblatt/);assert.match(factsRequest[1].content,/Ausgewählte und ausdrücklich bereitgestellte Kurzbeschreibung/);assert.doesNotMatch(factsRequest[1].content,/UNSELECTED_ANGLE/);
  assert.match(scriptRequest[0].content,/keine eigene Bewertung/);assert.doesNotMatch(scriptRequest[0].content,/Du hast eine klare Meinung/);
  assert.match(scriptRequest.at(-1).content,/Kein eigener Kommentar/);assert.match(scriptRequest.at(-1).content,/alltag/);assert.match(scriptRequest.at(-1).content,/frech/);
  const list=await call('/api/generate');const claim=list.data.claims.find(item=>item.researchId===id);assert.equal(claim.state,'received');assert.equal(claim.scriptOptions.mode,'source');assert.deepEqual(claim.scriptOptions.tones,['alltag','frech']);
  db.exec('DROP TRIGGER script_fixture_fail_save');
  r=await call('/api/generate','POST',{researchId:id,imageMode:'descriptions',channelId:null,scriptOptions:claim.scriptOptions});assert.equal(r.status,200);assert.equal(matching(),matchingAfter,'finishing saved response must not call provider again');
  assert.equal(r.data.content.script_options.mode,'source');assert.ok(r.data.content.generation_warnings.some(w=>/Kurzbeschreibung/.test(w)));assert.deepEqual(r.data.sources.map(s=>s.url),[source.url]);
  assert.equal((await call('/api/generate','POST',bad)).status,409);
 }finally{db.exec('DROP TRIGGER IF EXISTS script_fixture_fail_save');db.close();}
});

test('logout during asynchronous research prevents persisting its result',{skip:!enabled,timeout:120_000},async()=>{
 const fixture=realpathSync(process.env.CHANNEL_GENERATION_FIXTURE_DIR||'');assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.equal(readFileSync(join(fixture,'.channel-fixture'),'utf8'),'isolated-channel-generation\n');
 const base=new URL(server).origin,waiting=join(fixture,'waiting'),release=join(fixture,'release');let cookie='';
 async function call(path,method='GET',body){const headers={Origin:base};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};}
 for(const f of [waiting,release])if(existsSync(f))unlinkSync(f);
 assert.equal((await call('/api/login','POST',{password:'channel-local-test'})).status,200);
 const db=new Database(join(fixture,'data','videomaker.sqlite'),{fileMustExist:true}),before=db.prepare('SELECT count(*) n FROM research_reports').get().n;
 try{
  const pending=call('/api/research','POST',{topic:'TEST_LOGOUT_DURING_GENERATION',sources:[]});
  for(let i=0;i<400&&!existsSync(waiting);i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(existsSync(waiting));assert.equal((await call('/api/logout','POST')).status,200);writeFileSync(release,'1');
  assert.equal((await pending).status,403);assert.equal(db.prepare('SELECT count(*) n FROM research_reports').get().n,before);
 }finally{for(const f of [waiting,release])if(existsSync(f))unlinkSync(f);db.close();}
});

test('logout while a request body arrives prevents the subsequent paid research call',{skip:!enabled,timeout:120_000},async()=>{
 const fixture=realpathSync(process.env.CHANNEL_GENERATION_FIXTURE_DIR||'');assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.equal(readFileSync(join(fixture,'.channel-fixture'),'utf8'),'isolated-channel-generation\n');
 const base=new URL(server).origin;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'channel-local-test'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';',1)[0],log=join(fixture,'ai-requests.log');
 const before=existsSync(log)?readFileSync(log,'utf8'):'',db=new Database(join(fixture,'data','videomaker.sqlite'),{fileMustExist:true});
 const count=db.prepare('SELECT count(*) n FROM research_reports').get().n;
 try {
  let request;
  const response=new Promise((resolve,reject)=>{
   request=httpRequest(base+'/api/research',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   request.on('error',reject);request.write('{"topic":');
  });
  await new Promise(resolve=>setTimeout(resolve,200));
  const logout=await fetch(base+'/api/logout',{method:'POST',headers:{Origin:base,Cookie:cookie}});assert.equal(logout.status,200);
  request.end('"DELAYED_BODY_FIXTURE","sources":[]}');
  assert.equal(await response,403);assert.equal(db.prepare('SELECT count(*) n FROM research_reports').get().n,count);
  const after=existsSync(log)?readFileSync(log,'utf8'):'';assert.doesNotMatch(after.slice(before.length),/DELAYED_BODY_FIXTURE/);
 }finally{db.close();}
});

test('standard selects Kontrakurs or a channel-specific flexible prompt',{skip:!enabled,timeout:120_000},async()=>{
 const fixture=realpathSync(process.env.CHANNEL_GENERATION_FIXTURE_DIR||'');assert.equal(dirname(fixture),realpathSync(tmpdir()));assert.equal(readFileSync(join(fixture,'.channel-fixture'),'utf8'),'isolated-channel-generation\n');
 const base=new URL(server).origin;let cookie='';
 async function call(path,method='GET',body){const headers={Origin:base};if(cookie)headers.Cookie=cookie;if(body!==undefined)headers['Content-Type']='application/json';const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';',1)[0];return {status:r.status,data:await r.json()};}
 assert.equal((await call('/api/login','POST',{password:'channel-local-test'})).status,200);
 const channel=(await call('/api/channels','POST',{name:'Testkurzkanal',platform:'tiktok',handle:'@test'})).data;
 const standard={mode:'standard',scope:'selected',tones:[],dramaturgy:'',instructions:'',allowIncompleteSources:true};
 const src={...source,title:'DEFAULT_SOURCE_SELECTED'};
 for(const channelId of [null,channel.id]){
  const research=await call('/api/research','POST',{topic:'Test',sources:[src],channelId,scriptOptions:standard});assert.equal(research.status,200);
  const result=await call('/api/generate','POST',{researchId:research.data.id,imageMode:'descriptions',channelId,scriptOptions:standard});
  assert.equal(result.status,200);assert.match(result.data.content.script,/Willkommen bei/);
 }
 const messages=readFileSync(join(fixture,'ai-requests.log'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const factRequests=messages.filter(row=>row?.at(-1)?.content?.includes('DEFAULT_SOURCE_SELECTED'));
 assert.equal(factRequests.length,2);const script=messages[messages.indexOf(factRequests[0])+1],otherScript=messages[messages.indexOf(factRequests[1])+1];assert.equal(script[0].content,KONTRAKURS_SCRIPT_SYSTEM);assert.equal(otherScript[0].content,CHANNEL_SCRIPT_SYSTEM);assert.match(otherScript.at(-1).content,/Testkurzkanal/);assert.match(otherScript.at(-1).content,/tiktok/);assert.doesNotMatch(otherScript[0].content,/900|1.400|Wenn ihr weiter Klartext|Ich bin gespannt/);
});
