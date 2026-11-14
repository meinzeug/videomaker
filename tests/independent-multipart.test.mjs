// Independent contract tests: fake provider only. Never uses a real API key or network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(process.env.GROK_TEST_ROOT||process.cwd());
const load=name=>import(pathToFileURL(path.join(root,'lib',name)));
const require=createRequire(path.join(path.resolve(process.env.GROK_TEST_DEPENDENCIES||root),'package.json'));
const Database=require('better-sqlite3');
const {ensureGenerationClaimsSchema,acquireGenerationClaim,readGenerationClaim}=await load('generation-claims.ts');
const state=await load('grok-state.ts');
const {runGrokFlow}=await load('grok-flow.ts');
const prompts=await load('grok-prompt.ts');
const id='11111111-1111-4111-8111-111111111111',url='https://example.org/a',now='2026-01-01T00:00:00.000Z';
const sources=[{title:'Quelle',url,source:'Quelle',date:'',description:'Beschreibung'}];
const report={sources:[{url}],source_excerpts:[{url,status:'retrieved',text:'Eine belegte Aussage.'}]};
const options=mode=>({mode,scope:'selected',tones:['frech'],dramaturgy:'Spannung',instructions:'Direkt zum Thema',allowIncompleteSources:true});
const finalFields={titel:['Titel eins','Titel zwei','Titel drei'],thumbnail_text:'Ein Thema',pin_kommentar:'Was meint ihr?',quellen:[`Quelle – ${url}`],hinweise_fuer_dennis:[]};
function fixture(channel=null,selected=null,file=':memory:'){
 const db=new Database(file);db.exec('CREATE TABLE research_reports(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,sources TEXT NOT NULL,report TEXT NOT NULL); CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,platform TEXT,handle TEXT);');
 ensureGenerationClaimsSchema(db);state.ensureGrokStateSchema(db);
 db.prepare('INSERT INTO research_reports VALUES(?,?,?,?)').run(id,now,JSON.stringify(sources),JSON.stringify(selected?{...report,generation_options:selected}:report));
 if(channel)db.prepare('INSERT INTO channels VALUES(?,?,?,?)').run(channel.id,channel.name,channel.platform,channel.handle);
 const {claim}=db.transaction(()=>{const v=acquireGenerationClaim(db,id,'descriptions',channel?.id||null,now,selected);state.startGrokRun(db,id,now,'x-ai/grok-4.3','x-ai/grok-4.20',true);return v;}).immediate();
 return {db,claim};
}
function fake(plan){
 const calls=[];
 const fetch=async(urlArg,init)=>{
  assert.equal(urlArg,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init.headers.Authorization,'Bearer fake-test-key');
  const body=JSON.parse(init.body);calls.push(body);
  const facts=calls.length===1;
  const n=calls.length-1;
  const value=facts?{fakten:[{text:'Eine belegte Aussage.',quellen:[url]}],meinungen_dritter:[],zitate:[],unklar:[],hinweise_fuer_dennis:['INTERNER TESTHINWEIS'],skriptplan:{teile:plan}}:{skript:`Abschnitt ${n} enthält eine belegte Aussage.`,...(n===plan.length?finalFields:{})};
  return new Response(JSON.stringify({id:`fake-${calls.length}`,model:body.model,usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{status:200});
 };
 return {calls,fetch};
}
async function isolated(plan,channel=null,selected=null,run){
 const oldFetch=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY;const {db,claim}=fixture(channel,selected);const mock=fake(plan);
 globalThis.fetch=mock.fetch;process.env.OPENROUTER_API_KEY='fake-test-key';
 try{return await run({db,claim,...mock});}finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;db.close();}
}
for(const count of [1,2,5]) test(`provider-selected ${count} parts are written once in original order`,async()=>{
 const plan=Array.from({length:count},(_,i)=>`Ziel ${i+1}`);
 await isolated(plan,null,null,async({db,claim,calls})=>{
  const result=await runGrokFlow(db,claim,true,()=>{});assert.equal(result.state,'received');
  assert.equal(calls.length,count+1);assert.equal(state.readGrokPlan(db,id).length,count);
  const text=JSON.parse(result.responseText).script;
  assert.equal(text,Array.from({length:count},(_,i)=>`Abschnitt ${i+1} enthält eine belegte Aussage.`).join('\n\n'));
  assert.deepEqual(state.readGrokParts(db,id).map(p=>[p.part,p.state]),Array.from({length:count},(_,i)=>[i+1,'ready']));
  assert.equal(db.prepare('select count(*) n from grok_generation_attempts').get().n,count+1);
  for(const call of calls.slice(1))assert.ok(!JSON.stringify(call.messages).includes('INTERNER TESTHINWEIS'));
 });
});
test('a durable completed part is reused after interruption without a duplicate provider call',async()=>{
 await isolated(['Anfang','Ende'],null,null,async({db,claim,calls})=>{
  await assert.rejects(runGrokFlow(db,claim,true,()=>{if(state.readGrokParts(db,id).some(p=>p.part===1&&p.state==='ready'))throw new Error('simulated logout');}),/simulated logout/);
  assert.equal(calls.length,2);assert.deepEqual(state.readGrokParts(db,id).map(p=>[p.part,p.state]),[[1,'ready']]);
  const result=await runGrokFlow(db,claim,false,()=>{});assert.equal(result.state,'received');assert.equal(calls.length,3);
  assert.equal(JSON.parse(result.responseText).script,'Abschnitt 1 enthält eine belegte Aussage.\n\nAbschnitt 2 enthält eine belegte Aussage.');
 });
});
test('an uncertain pending part never triggers an automatic paid retry',async()=>{
 await isolated(['Anfang','Ende'],null,null,async({db,claim,calls})=>{
  await assert.rejects(runGrokFlow(db,claim,true,()=>{if(state.readGrokParts(db,id).some(p=>p.part===1&&p.state==='ready'))throw new Error('simulated logout');}),/simulated logout/);
  assert.equal(db.transaction(()=>state.reserveGrokPart(db,id,2,now)).immediate(),true);
  await assert.rejects(runGrokFlow(db,claim,false,()=>{}),/unklar|ungeklärt|läuft/i);assert.equal(calls.length,2);
 });
});
test('channel identity and source-only mode reach every script-part request',async()=>{
 const channel={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Eigenkanal',platform:'tiktok',handle:'@eigen'};
 await isolated(['Anfang','Ende'],channel,options('source'),async({db,claim,calls})=>{
  const result=await runGrokFlow(db,claim,true,()=>{});assert.equal(result.state,'received');
  for(const body of calls.slice(1)){
   assert.equal(body.messages[0].content,prompts.CHANNEL_SOURCE_ONLY_SCRIPT_SYSTEM);
   const user=body.messages.find(m=>m.role==='user').content;assert.match(user,/Eigenkanal/);assert.match(user,/tiktok/);assert.match(user,/"mode":"source"/);
  }
 });
});

test('completed parts survive closing and reopening the database without duplicate provider calls',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'grok-multipart-unit-')),file=path.join(dir,'test.sqlite');
 const oldFetch=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY,mock=fake(['Anfang','Ende']);let {db,claim}=fixture(null,null,file);
 globalThis.fetch=mock.fetch;process.env.OPENROUTER_API_KEY='fake-test-key';
 try{
  await assert.rejects(runGrokFlow(db,claim,true,()=>{if(state.readGrokParts(db,id).some(p=>p.part===1&&p.state==='ready'))throw new Error('simulated interruption');}),/simulated interruption/);
  assert.equal(mock.calls.length,2);db.close();db=new Database(file);claim=readGenerationClaim(db,id);
  assert.deepEqual(state.readGrokParts(db,id).map(p=>[p.part,p.state]),[[1,'ready']]);
  const result=await runGrokFlow(db,claim,false,()=>{});assert.equal(result.state,'received');assert.equal(mock.calls.length,3);
  assert.equal(JSON.parse(result.responseText).script,'Abschnitt 1 enthält eine belegte Aussage.\n\nAbschnitt 2 enthält eine belegte Aussage.');
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('invalid or empty plans are preserved and never trigger paid script parts',async()=>{
 for(const plan of [[],['Erster Teil',''],['  ']]){
  const oldFetch=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY,{db,claim}=fixture();let calls=0;
  process.env.OPENROUTER_API_KEY='fake-test-key';globalThis.fetch=async(urlArg,init)=>{
   assert.equal(urlArg,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init.headers.Authorization,'Bearer fake-test-key');calls++;
   return new Response(JSON.stringify({id:'fake',model:'x-ai/grok-4.3',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify({fakten:[{text:'Eine Aussage.',quellen:[url]}],meinungen_dritter:[],zitate:[],unklar:[],hinweise_fuer_dennis:[],skriptplan:{teile:plan}})}}]}),{status:200});
  };
  try{
   await assert.rejects(runGrokFlow(db,claim,true,()=>{}),/Faktenblatt|Skriptplan/i);assert.equal(calls,1);
   assert.equal(state.readGrokRun(db,id).phase,'facts_invalid');assert.ok(state.readGrokRun(db,id).factsRaw);assert.deepEqual(state.readGrokParts(db,id),[]);
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;db.close();}
 }
});

test('large valid plans remain exact and visible without silently starting parts',async()=>{
 const plan=Array.from({length:1025},(_,i)=>`Ziel ${i+1}`);
 await isolated(plan,null,null,async({db,claim,calls})=>{
  await assert.rejects(runGrokFlow(db,claim,true,()=>{if(calls.length)throw new Error('stop before parts');}),/stop before parts/);
  assert.deepEqual(state.readGrokPlan(db,id),plan);assert.equal((plan.length+2)*3,3081);assert.equal(calls.length,1);assert.deepEqual(state.readGrokParts(db,id),[]);
 });
});

for(const repairedTitles of [['Repariert eins','Repariert zwei','Repariert drei'],[]]) test(`metadata repair preserves original parts when ${repairedTitles.length?'valid':'invalid'}`,async()=>{
 await isolated(['Anfang','Ende'],null,null,async({db,claim,calls,fetch:baseFetch})=>{
  const expected='Abschnitt 1 enthält eine belegte Aussage.\n\nAbschnitt 2 enthält eine belegte Aussage.';
  globalThis.fetch=async(urlArg,init)=>{
   const request=JSON.parse(init.body),schema=request.response_format?.json_schema?.name;
   if(schema==='videomaker_metadaten'){
    calls.push(request);assert.equal(request.model,'x-ai/grok-4.20');assert.ok(!('skript' in request.response_format.json_schema.schema.properties));
    const body={...finalFields,titel:repairedTitles};return new Response(JSON.stringify({id:'metadata-mock',model:request.model,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}]}),{status:200});
   }
   const response=await baseFetch(urlArg,init);
   if(calls.length===3){const value=await response.json(),payload=JSON.parse(value.choices[0].message.content);payload.titel=[];value.choices[0].message.content=JSON.stringify(payload);return new Response(JSON.stringify(value),{status:200});}
   return response;
  };
  if(repairedTitles.length){const result=await runGrokFlow(db,claim,true,()=>{});assert.equal(result.state,'received');assert.equal(JSON.parse(result.responseText).script,expected);}
  else await assert.rejects(runGrokFlow(db,claim,true,()=>{}),/Korrektur|Metadaten/i);
  const saved=state.readGrokRun(db,id);assert.equal(JSON.parse(JSON.parse(saved.scriptRaw).text).skript,expected);assert.ok(saved.repairRaw);
  assert.deepEqual(state.readGrokParts(db,id).map(p=>[p.part,p.state]),[[1,'ready'],[2,'ready']]);
  assert.equal(calls.length,4,'at most one metadata correction');
 });
});

test('malformed metadata correction keeps the original assembled script and parts',async()=>{
 await isolated(['Anfang','Ende'],null,null,async({db,claim,calls,fetch:baseFetch})=>{
  globalThis.fetch=async(urlArg,init)=>{
   const request=JSON.parse(init.body);
   if(request.response_format?.json_schema?.name==='videomaker_metadaten'){
    calls.push(request);return new Response(JSON.stringify({id:'metadata-mock',model:request.model,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0},choices:[{finish_reason:'stop',message:{content:'{unvollständig'}}]}),{status:200});
   }
   const response=await baseFetch(urlArg,init);
   if(calls.length===3){const value=await response.json(),payload=JSON.parse(value.choices[0].message.content);payload.titel=[];value.choices[0].message.content=JSON.stringify(payload);return new Response(JSON.stringify(value),{status:200});}
   return response;
  };
  await assert.rejects(runGrokFlow(db,claim,true,()=>{}),/Metadatenkorrektur/i);
  const saved=state.readGrokRun(db,id);assert.equal(JSON.parse(JSON.parse(saved.scriptRaw).text).skript,'Abschnitt 1 enthält eine belegte Aussage.\n\nAbschnitt 2 enthält eine belegte Aussage.');
  assert.equal(JSON.parse(saved.repairRaw).text,'{unvollständig');assert.deepEqual(state.readGrokParts(db,id).map(p=>[p.part,p.state]),[[1,'ready'],[2,'ready']]);assert.equal(calls.length,4);
 });
});

test('earlier generated text is never passed as factual material to later parts',async()=>{
 await isolated(['Anfang','Mitte','Ende'],null,null,async({db,claim,calls})=>{
  await runGrokFlow(db,claim,true,()=>{});
  for(let index=2;index<calls.length;index++){
   const content=JSON.stringify(calls[index].messages);
   for(let prior=1;prior<index;prior++)assert.ok(!content.includes(`Abschnitt ${prior} enthält eine belegte Aussage.`));
   assert.match(content,/keine Faktenquelle/);
  }
 });
});

test('unrepresentable assembled data stops durably without requesting remaining parts',async()=>{
 await isolated(['Anfang','Mitte','Ende'],null,null,async({db,claim,calls,fetch:baseFetch})=>{
  globalThis.fetch=async(urlArg,init)=>{
   const result=await baseFetch(urlArg,init);if(calls.length===1)return result;
   const value=await result.json(),payload=JSON.parse(value.choices[0].message.content);payload.skript='x'.repeat(1100000);value.choices[0].message.content=JSON.stringify(payload);return new Response(JSON.stringify(value),{status:200});
  };
  await assert.rejects(runGrokFlow(db,claim,true,()=>{}),/Speichergrenze/);assert.equal(calls.length,3);
  assert.match(state.readGrokFailure(db,id),/Speichergrenze/);assert.deepEqual(state.readGrokParts(db,id).map(p=>p.state),['ready','ready']);
  await assert.rejects(runGrokFlow(db,claim,false,()=>{}),/Speichergrenze/);assert.equal(calls.length,3);
 });
});
