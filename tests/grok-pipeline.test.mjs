import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {AUTONOMOUS_SCRIPT_SYSTEM,KONTRAKURS_SCRIPT_SYSTEM,FACT_SHEET_SYSTEM,CHANNEL_SCRIPT_SYSTEM,SOURCE_ONLY_SCRIPT_SYSTEM,CHANNEL_SOURCE_ONLY_SCRIPT_SYSTEM} from '../lib/grok-prompt.ts';
import {validateFactSheet} from '../lib/fact-sheet.ts';
import {parseGrokScript} from '../lib/grok-result.ts';
import {ensureGenerationClaimsSchema,acquireGenerationClaim,readGenerationClaim} from '../lib/generation-claims.ts';
import {ensureGrokStateSchema,readGrokRun,startGrokRun,markGrokFacts} from '../lib/grok-state.ts';
import {grokCompletion} from '../lib/grok-provider.ts';
import {GrokPending,GrokInvalid,runGrokFlow} from '../lib/grok-flow.ts';

const id='11111111-1111-4111-8111-111111111111',url='https://example.org/a',now='2026-01-01T00:00:00.000Z';
const source=[{title:'Quelle',url,source:'Quelle',date:'',description:'Beschreibung'}];
const report={sources:[{url}],source_excerpts:[{url,status:'retrieved',text:'Hier steht das bestätigte Originalzitat. Weitere Informationen.'}]};
const rawFacts={fakten:[{text:'Eine belegte Aussage.',quellen:[url]}],meinungen_dritter:[],zitate:[{text:'bestätigte Originalzitat',quelle:url}],unklar:[],hinweise_fuer_dennis:['NUR-INTERN PDF HINWEIS']};
const script=`${Array(905).fill('Wort').join(' ')}\nWenn ihr weiter Klartext wollt, lasst ein Abo da und gebt dem Video einen Daumen nach oben.\nIch bin gespannt, wie ihr das seht, denn dieses Video ist jetzt mit Absicht zu Ende. Ciao, bis bald!`;
function answer(s=script){return JSON.stringify({titel:['Titel 1!','Titel 2!','Titel 3?'],skript:s,thumbnail_text:'Klartext jetzt',pin_kommentar:'Was meint ihr?',quellen:[`Quelle – ${url}`],hinweise_fuer_dennis:[]});}
function response(text,more={}){return new Response(JSON.stringify({id:'gen-test',model:'x-ai/grok-4.3',usage:{prompt_tokens:12,completion_tokens:34,total_tokens:46,cost:0.001},choices:[{finish_reason:'stop',message:{content:text}}],...more}),{status:200});}
function fixture(channel=null,options=null){const db=new Database(':memory:');db.exec(`CREATE TABLE research_reports(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,sources TEXT NOT NULL,report TEXT NOT NULL); CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,platform TEXT,handle TEXT);`);ensureGenerationClaimsSchema(db);ensureGrokStateSchema(db);db.prepare('INSERT INTO research_reports VALUES(?,?,?,?)').run(id,now,JSON.stringify(source),JSON.stringify(report));if(channel)db.prepare('INSERT INTO channels VALUES(?,?,?,?)').run(channel.id,channel.name,channel.platform,channel.handle);if(options)db.prepare('UPDATE research_reports SET report=? WHERE id=?').run(JSON.stringify({...report,generation_options:options}),id);const {claim}=db.transaction(()=>{const result=acquireGenerationClaim(db,id,'descriptions',channel?.id||null,now,options);startGrokRun(db,id,now,'x-ai/grok-4.3','x-ai/grok-4.20');return result;}).immediate();return {db,claim};}

test('autonomous and optional styles do not impose previous editorial limits',()=>{
 for(const prompt of [AUTONOMOUS_SCRIPT_SYSTEM,KONTRAKURS_SCRIPT_SYSTEM,SOURCE_ONLY_SCRIPT_SYSTEM]){
  assert.doesNotMatch(prompt,/900–1.400|Wenn ihr weiter Klartext|Ich bin gespannt, wie ihr das seht/);
 }
 assert.match(AUTONOMOUS_SCRIPT_SYSTEM,/selbst über Länge, Aufbau und Formulierung/);
 assert.match(SOURCE_ONLY_SCRIPT_SYSTEM,/keine eigene Bewertung/);
 assert.match(KONTRAKURS_SCRIPT_SYSTEM,/Kontrakurs.*Orientierung/);
});
test('literal quotes require the exact text in a retrieved original, never a fallback description',()=>{
 const facts=validateFactSheet({...rawFacts,zitate:[...rawFacts.zitate,{text:'erfunden',quelle:url},{text:'wiederholt',quelle:'https://evil.example/x'}]},source,report);
 assert.deepEqual(facts.zitate,[rawFacts.zitate[0]]);assert.match(facts.hinweise_fuer_dennis.join(' '),/2 Zitat/);
 const fallback=validateFactSheet(rawFacts,source,{...report,source_excerpts:[{url,status:'unavailable',text:'bestätigte Originalzitat'}]});assert.deepEqual(fallback.zitate,[]);
});
test('source-verified surrounding quote marks are removed only for exact comparison',()=>{
 const quoted='„Bestätigter Wortlaut.“';const verified=validateFactSheet({...rawFacts,zitate:[{text:quoted,quelle:url}]},source,{...report,source_excerpts:[{url,status:'retrieved',text:`Hier steht ${quoted} Ende.`}]});
 assert.ok(parseGrokScript(answer(`Zitat: ${quoted}\n`+script),false,verified).project);
 for(const changed of ['Zitat: „Bestätigter Wortlaut und Zusatz.“\n','Zitat: „Bestätigter Wortlaut“\n','Zitat: „Bestätigter Wortlaut.“ und Zusatz\n']){
  const result=parseGrokScript(answer(changed+script),false,verified);assert.equal(result.project,null);assert.ok(result.issues.some(issue=>issue.code==='unverified_quote'));
 }
 const unverified=validateFactSheet({...rawFacts,zitate:[{text:quoted,quelle:url}]},source,{...report,source_excerpts:[{url,status:'retrieved',text:'Anderer Quelltext.'}]});
 assert.equal(parseGrokScript(answer(`Zitat: ${quoted}\n`+script),false,unverified).project,null);
});
test('each announced quote is checked independently and only explicit closing marks bound continuation',()=>{
 const quoted='„Bestätigter Wortlaut.“';const facts=validateFactSheet({...rawFacts,zitate:[{text:quoted,quelle:url}]},source,{...report,source_excerpts:[{url,status:'retrieved',text:`Hier steht ${quoted} Ende.`}]});
 const good=`Zitat: ${quoted} Dann folgt eine Erläuterung.\n`;
 assert.ok(parseGrokScript(answer(good+script),false,facts).project);
 for(const text of [
  `Zitat: ${quoted} und frei erfundener Zusatz.\n`,
  'Zitat: „Bestätigter Wortlaut. Frei erfundener Zusatz.“ Dann weiter.\n',
  `Zitat: ${quoted} Dann folgt Zitat: Frei erfundener Zusatz.\n`,
  'Zitat: Bestätigter Wortlaut. Frei erfundener Zusatz.\n',
 ]){
  const result=parseGrokScript(answer(text+script),false,facts);assert.equal(result.project,null);assert.ok(result.issues.some(issue=>issue.code==='unverified_quote'),text);
 }
 const question='Bestätigte Frage?';const questionFacts=validateFactSheet({...rawFacts,zitate:[{text:question,quelle:url}]},source,{...report,source_excerpts:[{url,status:'retrieved',text:`Hier steht ${question} Ende.`}]});
 const ambiguous=parseGrokScript(answer(`Zitat: ${question} Ein zusätzlicher Satz.\n`+script),false,questionFacts);assert.equal(ambiguous.project,null);assert.ok(ambiguous.issues.some(issue=>issue.code==='unverified_quote'&&/Grenze.*nicht eindeutig/.test(issue.message)));
});

test('output enforces exact quality, typed fields, verified sources and complete literal quotations',()=>{
 const facts=validateFactSheet(rawFacts,source,report);
 assert.ok(parseGrokScript(answer(),false,facts).project);
 const wrongChannel=parseGrokScript(answer('Willkommen bei Kontrakurs. Das ist ein Test.'),false,facts,'Eigenkanal',false);assert.ok(wrongChannel.project); // Channel mismatch is surfaced as a warning at project creation.
 assert.ok(parseGrokScript(answer('Willkommen bei Eigenkanal.\n'+script),false,facts,'Eigenkanal').project);
 assert.equal(parseGrokScript(answer(),true,facts).project,null);
 for(const example of ['Zitat: bestätigte Originalzitat und frei erfundener Zusatz.\n','Hier: „nicht\nbelegtes Zitat“\n','Hier: „unbegrenzt\n']){
  const failure=parseGrokScript(answer(example+script),false,facts);assert.equal(failure.project,null);assert.ok(failure.issues.some(issue=>issue.code==='unverified_quote'));
 }
 const data=JSON.parse(answer());data.quellen.push('Erfunden – https://evil.example/x');const parsed=parseGrokScript(JSON.stringify(data),false,facts);assert.deepEqual(parsed.project.quellen,[`example.org – ${url}`]);assert.match(parsed.project.hinweise_fuer_dennis.join(' '),/entfernt/);
 data.quellen=[];const supplemented=parseGrokScript(JSON.stringify(data),false,facts);assert.deepEqual(supplemented.project.quellen,[`example.org – ${url}`]);assert.match(supplemented.project.hinweise_fuer_dennis.join(' '),/ergänzt/);
 data.hinweise_fuer_dennis=[3];assert.equal(parseGrokScript(JSON.stringify(data),false,facts).project,null);
});
test('technical field errors remain strict while editorial length and thumbnail are free',()=>{
 const facts=validateFactSheet(rawFacts,source,report),data=JSON.parse(answer('Ein kurzer Testtext.'));
 data.hinweise_fuer_dennis='Ein Hinweis als falscher Datentyp';data.quellen=[3];data.thumbnail_text='Eins Zwei Drei Vier Fünf Sechs Sieben Acht Neun Zehn';
 const result=parseGrokScript(JSON.stringify(data),false,facts);assert.equal(result.project,null);
 for(const code of ['hinweise_fuer_dennis','quellen'])assert.ok(result.issues.some(issue=>issue.code===code),code);
 assert.ok(!result.issues.some(issue=>['thumbnail_text','word_count'].includes(issue.code)));
 data.hinweise_fuer_dennis=[];data.quellen=[];assert.ok(parseGrokScript(JSON.stringify(data),false,facts).project);
});
test('429 retries are bounded, recorded and use the requested Grok parameters',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';const calls=[],delays=[];
 try{const reply=await grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{sleep:async ms=>delays.push(ms),fetch:async(_url,init)=>{calls.push(JSON.parse(init.body));return calls.length<3?new Response('',{status:429}):response(JSON.stringify(rawFacts));}});
  assert.equal(calls.length,3);assert.deepEqual(calls.map(c=>c.model),['x-ai/grok-4.3','x-ai/grok-4.3','x-ai/grok-4.20']);assert.deepEqual(delays,[1000,2000]);assert.equal(calls[0].temperature,0.3);assert.equal(calls[0].top_p,0.95);assert.equal(calls[0].max_tokens,4000);assert.equal(calls[0].response_format.type,'json_object');assert.equal(reply.usage.costUsd,0.001);
  assert.deepEqual(db.prepare('SELECT state FROM grok_generation_attempts ORDER BY ordinal').all().map(x=>x.state),['failed','failed','received']);
 }finally{if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});
test('timeout after response headers selects fallback and retains unknown cost of the first call',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';const models=[];const keepAlive=setTimeout(()=>{},1000);
 try{const reply=await grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{timeoutMs:30,fetch:async(_url,init)=>{const model=JSON.parse(init.body).model;models.push(model);return model.endsWith('4.3')?new Response(new ReadableStream({start(){}}),{status:200}):response(JSON.stringify(rawFacts),{model});}});
  assert.deepEqual(models,['x-ai/grok-4.3','x-ai/grok-4.20']);assert.equal(reply.usage.model,'x-ai/grok-4.20');const rows=db.prepare('SELECT state,cost_usd FROM grok_generation_attempts ORDER BY ordinal').all();assert.equal(rows[0].state,'unknown');assert.equal(rows[0].cost_usd,null);assert.equal(rows[1].state,'received');
 }finally{clearTimeout(keepAlive);if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});
test('known facts resume after logout; one repair is reserved, hints never enter script prompts',async()=>{
 const {db,claim}=fixture(),old=process.env.OPENROUTER_API_KEY,oldFetch=globalThis.fetch;process.env.OPENROUTER_API_KEY='test-only';let allowed=false;const messages=[],requests=[];
 globalThis.fetch=async(_url,init)=>{const req=JSON.parse(init.body);messages.push(req.messages);requests.push(req);const broken=JSON.parse(answer('Zu kurz. UNTRUSTED-ERFUNDEN'));broken.thumbnail_text='Eins Zwei Drei Vier Fünf Sechs Sieben Acht Neun Zehn';broken.hinweise_fuer_dennis='Falscher Typ';return response(req.messages[0].content===FACT_SHEET_SYSTEM?JSON.stringify(rawFacts):messages.filter(m=>m[0].content!==FACT_SHEET_SYSTEM).length===1?JSON.stringify(broken):answer());};
 try{
  await assert.rejects(runGrokFlow(db,claim,true,()=>{if(!allowed&&messages.length)throw new Error('logged out');}),/logged out/);
  assert.equal(readGrokRun(db,id).phase,'facts_ready');assert.equal(messages.length,1);
  allowed=true;const final=await runGrokFlow(db,claim,false,()=>{});assert.equal(final.state,'received');assert.equal(messages.length,3);assert.equal(readGrokRun(db,id).phase,'repair_ready');assert.deepEqual(requests.map(req=>req.model),['x-ai/grok-4.3','x-ai/grok-4.3','x-ai/grok-4.20']);const repairAttempts=db.prepare("SELECT requested_model FROM grok_generation_attempts WHERE phase='repair' ORDER BY ordinal").all();assert.deepEqual(repairAttempts.map(x=>x.requested_model),['x-ai/grok-4.20']);
  for(const m of messages.slice(1)){assert.equal(m[0].content,KONTRAKURS_SCRIPT_SYSTEM);assert.doesNotMatch(m[1].content,/NUR-INTERN PDF HINWEIS/);}
  assert.match(messages[2][1].content,/Erzeuge keinen Skripttext/);assert.match(messages[2][1].content,/auch bei nur einem Hinweis/);
  assert.equal(requests[1].response_format.json_schema.schema.properties.skript.pattern,undefined);
  assert.equal(requests[2].response_format.json_schema.schema.properties.skript,undefined);
  assert.equal(Object.hasOwn(requests[1],'max_tokens'),false);assert.equal(Object.hasOwn(requests[2],'max_tokens'),false);
  const content=JSON.parse(final.responseText);assert.equal(content.script,'Zu kurz. UNTRUSTED-ERFUNDEN');assert.deepEqual(content.broll,[]);assert.equal(content.pin_kommentar,'Was meint ihr?');
 }finally{globalThis.fetch=oldFetch;if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});
test('unknown in-flight or old pending claims cannot start duplicate paid calls',async()=>{
 const {db,claim}=fixture();await assert.rejects(runGrokFlow(db,claim,false,()=>{}),GrokPending);assert.equal(readGenerationClaim(db,id).state,'pending');assert.equal(db.prepare('SELECT count(*) AS n FROM grok_generation_attempts').get().n,0);db.close();
});

test('all 5xx attempts are globally bounded and include fallback',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';const models=[];
 try{
  await assert.rejects(grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{sleep:async()=>{},fetch:async(_url,init)=>{models.push(JSON.parse(init.body).model);return new Response('',{status:503});}}),/Ersatzmodell/);
  assert.deepEqual(models,['x-ai/grok-4.3','x-ai/grok-4.3','x-ai/grok-4.20']);assert.equal(db.prepare('SELECT count(*) AS n FROM grok_generation_attempts').get().n,3);
 }finally{if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});

test('pre-header timeout falls back; later failures preserve unknown first cost',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';const models=[];const keepAlive=setTimeout(()=>{},1000);
 try{
  await assert.rejects(grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{timeoutMs:30,sleep:async()=>{},fetch:async(_url,init)=>{models.push(JSON.parse(init.body).model);return models.length===1?new Promise(()=>{}):new Response('',{status:429});}}),/unklar/);
  assert.deepEqual(models,['x-ai/grok-4.3','x-ai/grok-4.20','x-ai/grok-4.20']);const rows=db.prepare('SELECT state,cost_usd FROM grok_generation_attempts ORDER BY ordinal').all();assert.deepEqual(rows.map(x=>x.state),['unknown','failed','failed']);assert.equal(rows[0].cost_usd,null);
 }finally{clearTimeout(keepAlive);if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});

test('logout during backoff prevents another paid attempt',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';let allowed=true,calls=0;
 try{
  await assert.rejects(grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{authorize:()=>{if(!allowed)throw new Error('logged out');},sleep:async()=>{allowed=false;},fetch:async()=>{calls++;return new Response('',{status:503});}}),/logged out/);
  assert.equal(calls,1);assert.equal(db.prepare('SELECT count(*) AS n FROM grok_generation_attempts').get().n,1);
 }finally{if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});

test('fallback authentication failure preserves prior timeout uncertainty',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';let calls=0;
 try{
  await assert.rejects(grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{fetch:async()=>{if(++calls===1)throw new Error('network');return new Response('',{status:401});}}),e=>e.uncertain===true&&/berechnet/.test(e.message));
  assert.equal(calls,2);assert.equal(db.prepare('SELECT state FROM grok_generation_attempts ORDER BY ordinal').all()[0].state,'unknown');
 }finally{if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});

test('a hanging error-body cancel cannot block fallback after 503',async()=>{
 const {db}=fixture(),old=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';const models=[];
 try{
  const reply=await grokCompletion(db,id,'facts',FACT_SHEET_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},{timeoutMs:30,sleep:async()=>{},fetch:async(_url,init)=>{models.push(JSON.parse(init.body).model);return models.length<3?new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}),{status:503}):response(JSON.stringify(rawFacts),{model:'x-ai/grok-4.20'});}});
  assert.equal(reply.usage.model,'x-ai/grok-4.20');assert.equal(models.length,3);
 }finally{if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});


test('other channel receives its own metadata without Kontrakurs opinion or name',async()=>{
 const channel={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Eigenkanal',platform:'tiktok',handle:'@eigen'}, {db,claim}=fixture(channel),old=process.env.OPENROUTER_API_KEY,oldFetch=globalThis.fetch;process.env.OPENROUTER_API_KEY='test-only';const messages=[],requests=[];
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);messages.push(request.messages);requests.push(request);return response(request.messages[0].content===FACT_SHEET_SYSTEM?JSON.stringify(rawFacts):answer('Willkommen bei Eigenkanal. Hier ein kurzer Testbeitrag.'));};
 try{const result=await runGrokFlow(db,claim,true,()=>{});assert.equal(result.state,'received');assert.equal(messages[1][0].content,CHANNEL_SCRIPT_SYSTEM);assert.doesNotMatch(messages[1][1].content,/Ankündigung und Zitat allein in eine eigene Zeile/);assert.equal(requests[1].response_format.json_schema.schema.properties.skript.pattern,undefined);assert.doesNotMatch(messages[1][0].content,/Kontrakurs|Du hast eine klare Meinung/);assert.match(messages[1][1].content,/Eigenkanal/);assert.match(messages[1][1].content,/tiktok/);assert.doesNotMatch(messages[1][0].content,/900|1.400|Wenn ihr weiter Klartext|Ich bin gespannt/);}
 finally{globalThis.fetch=oldFetch;if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});

test('explicit source-only mode avoids imposed opinion for other channels',async()=>{
 const channel={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Eigenkanal',platform:'youtube',handle:'@eigen'},options={mode:'source',scope:'selected',tones:['frech'],dramaturgy:'Spannung',instructions:'Kurz und direkt',allowIncompleteSources:true};
 const {db,claim}=fixture(channel,options),old=process.env.OPENROUTER_API_KEY,oldFetch=globalThis.fetch;process.env.OPENROUTER_API_KEY='test-only';const messages=[],requests=[];
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);messages.push(request.messages);requests.push(request);return response(request.messages[0].content===FACT_SHEET_SYSTEM?JSON.stringify(rawFacts):answer('Willkommen bei Eigenkanal. Hier ein kurzer Testbeitrag.'));};
 try{await runGrokFlow(db,claim,true,()=>{});assert.equal(messages[1][0].content,CHANNEL_SOURCE_ONLY_SCRIPT_SYSTEM);assert.doesNotMatch(messages[1][1].content,/Ankündigung und Zitat allein in eine eigene Zeile/);assert.equal(requests[1].response_format.json_schema.schema.properties.skript.pattern,undefined);assert.match(messages[1][1].content,/Eigenkanal/);assert.match(messages[1][1].content,/frech/);assert.match(messages[1][1].content,/Spannung/);assert.match(messages[1][1].content,/Kurz und direkt/);assert.doesNotMatch(messages[1][0].content,/900|1.400|Wenn ihr weiter Klartext|Ich bin gespannt/);}
 finally{globalThis.fetch=oldFetch;if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});


test('an unverified quote stops without rewriting the script or starting a repair',async()=>{
 const {db,claim}=fixture(),old=process.env.OPENROUTER_API_KEY,oldFetch=globalThis.fetch;process.env.OPENROUTER_API_KEY='test-only';const messages=[];
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);messages.push(request.messages);return response(request.messages[0].content===FACT_SHEET_SYSTEM?JSON.stringify({...rawFacts,zitate:[]}):answer('Zitat: Frei erfunden.\n'+script));};
 try{await assert.rejects(runGrokFlow(db,claim,true,()=>{}),GrokInvalid);assert.equal(messages.length,2);assert.equal(readGenerationClaim(db,id).state,'received');assert.match(readGenerationClaim(db,id).responseText,/Frei erfunden/);}
 finally{globalThis.fetch=oldFetch;if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});

test('one quality repair starts with fallback and may use primary only within the same bounded phase',async()=>{
 const {db,claim}=fixture(),old=process.env.OPENROUTER_API_KEY,oldFetch=globalThis.fetch;process.env.OPENROUTER_API_KEY='test-only';const calls=[];
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);calls.push(request);if(calls.length===1)return response(JSON.stringify(rawFacts));if(calls.length===2){const broken=JSON.parse(answer('Kurzer Originaltext.'));broken.hinweise_fuer_dennis='kein Array';return response(JSON.stringify(broken));}if(calls.length===3)return new Response('',{status:400});return response(answer());};
 try{const final=await runGrokFlow(db,claim,true,()=>{});assert.equal(final.state,'received');assert.deepEqual(calls.map(req=>req.model),['x-ai/grok-4.3','x-ai/grok-4.3','x-ai/grok-4.20','x-ai/grok-4.3']);const rows=db.prepare("SELECT requested_model,state FROM grok_generation_attempts WHERE phase='repair' ORDER BY ordinal").all();assert.deepEqual(rows,[{requested_model:'x-ai/grok-4.20',state:'failed'},{requested_model:'x-ai/grok-4.3',state:'received'}]);assert.equal(readGrokRun(db,id).phase,'repair_ready');}
 finally{globalThis.fetch=oldFetch;if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;db.close();}
});


test('autonomous and source-only mode both accept editorial wording without prescribed phrases',async()=>{
 const old=process.env.OPENROUTER_API_KEY,oldFetch=globalThis.fetch;process.env.OPENROUTER_API_KEY='test-only';
 try{
  for(const options of [null,{mode:'source',scope:'selected',tones:[],dramaturgy:'',instructions:'',allowIncompleteSources:true}]){
   const {db,claim}=fixture(null,options);const messages=[];
   globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);messages.push(request.messages);return response(request.messages[0].content===FACT_SHEET_SYSTEM?JSON.stringify(rawFacts):answer('Recherche und Überschrift sind zulässige Wörter. Der Zustand dieser Bewegung ist Thema.'));};
   try{const result=await runGrokFlow(db,claim,true,()=>{});assert.equal(result.state,'received');assert.equal(messages.length,2);assert.equal(messages[1][0].content,options?SOURCE_ONLY_SCRIPT_SYSTEM:KONTRAKURS_SCRIPT_SYSTEM);assert.doesNotMatch(messages[1][1].content,/900 bis 1.400|Ankündigung und Zitat allein in eine eigene Zeile/);}
   finally{db.close();}
  }
 }finally{globalThis.fetch=oldFetch;if(old===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;}
});

test('script output budget uses provider default unless explicitly configured',async()=>{
 const {db}=fixture(),oldKey=process.env.OPENROUTER_API_KEY,oldMax=process.env.SCRIPT_MAX_TOKENS;process.env.OPENROUTER_API_KEY='test-only';const calls=[];
 db.prepare("UPDATE grok_generation_runs SET phase='script_pending' WHERE research_id=?").run(id);
 try{
  delete process.env.SCRIPT_MAX_TOKENS;
  const deps={fetch:async(_url,init)=>{calls.push(JSON.parse(init.body));return response(answer());}};
  await grokCompletion(db,id,'script',AUTONOMOUS_SCRIPT_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},deps);
  process.env.SCRIPT_MAX_TOKENS='16000';await grokCompletion(db,id,'script',AUTONOMOUS_SCRIPT_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},deps);
  process.env.SCRIPT_MAX_TOKENS='-1';await assert.rejects(grokCompletion(db,id,'script',AUTONOMOUS_SCRIPT_SYSTEM,'test',{primary:'x-ai/grok-4.3',fallback:'x-ai/grok-4.20'},deps),/SCRIPT_MAX_TOKENS/);
  assert.equal(Object.hasOwn(calls[0],'max_tokens'),false);assert.equal(calls[1].max_tokens,16000);assert.equal(calls.length,2);
 }finally{if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;if(oldMax===undefined)delete process.env.SCRIPT_MAX_TOKENS;else process.env.SCRIPT_MAX_TOKENS=oldMax;db.close();}
});
