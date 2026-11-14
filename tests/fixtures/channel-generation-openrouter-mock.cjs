// Only use with the explicit, isolated fixture documented in
// docs/channel-generation-tests.md. No OpenRouter request leaves this process.
const fs=require('node:fs');
const path=require('node:path');
const directory=process.env.CHANNEL_GENERATION_FIXTURE_DIR;
if(!directory||fs.readFileSync(path.join(directory,'.channel-fixture'),'utf8')!=='isolated-channel-generation\n')throw new Error('Channel mock requires its own marked fixture.');
globalThis.fetch=async function(input,init){
 const url=typeof input==='string'?input:input.url;
 if(!url.startsWith('https://openrouter.ai/'))throw new Error('All outbound requests are blocked in this synthetic fixture.');
 const request=JSON.parse(init.body),messages=request.messages,prompt=[...messages].reverse().find(m=>m.role==='user')?.content||'';
 fs.appendFileSync(path.join(directory,'ai-requests.log'),JSON.stringify(messages)+'\n');
 if(prompt.includes('TEST_MOCK_FAILURE'))return new Response(JSON.stringify({error:{message:'mock failure'}}),{status:500,headers:{'Content-Type':'application/json'}});
 if(prompt.includes('TEST_DELETE_DURING_GENERATION')||prompt.includes('TEST_LOGOUT_DURING_GENERATION')){
  fs.writeFileSync(path.join(directory,'waiting'),'1');
  for(let i=0;i<400&&!fs.existsSync(path.join(directory,'release'));i++)await new Promise(resolve=>setTimeout(resolve,25));
 }
 const urls=['https://example.org/a','https://example.net/b','https://example.org/c'];
 const research={summary:'Beispiel',sources:urls.map((url,i)=>({title:`Quelle ${i}`,url,publisher:'Beispiel',date:'2026-01-01'})),findings:urls.map(url=>({claim:'Beispiel',assessment:'belegt',explanation:'Testdaten',source_urls:[url]})),hypotheses:[],open_questions:[]};
 const system=messages?.[0]?.content||'';
 const isFacts=!request.tools&&system.includes('strukturiertes Faktenblatt');
 const isGrokScript=!request.tools&&String(request.model||'').startsWith('x-ai/grok-')&&!isFacts;
 const sourceUrl=prompt.match(/https:\/\/[^"\\\s]+/)?.[0]||urls[0];
 const marker=prompt.match(/TEST_[A-Z_]+/)?.[0]||'Beispiel';
 const facts={fakten:[{text:`Synthetischer Testbefund ${marker}`,quellen:[sourceUrl]}],meinungen_dritter:[],zitate:[],unklar:[],hinweise_fuer_dennis:[],...(prompt.includes('skriptplan')?{skriptplan:{teile:['Ein zusammenhängender Sprechertext']}}:{})};
 const cta='Wenn ihr weiter Klartext wollt, lasst ein Abo da und gebt dem Video einen Daumen nach oben.';
 const outro='Ich bin gespannt, wie ihr das seht, denn dieses Video ist jetzt mit Absicht zu Ende. Ciao, bis bald!';
 let channel='Kontrakurs';
 const channelData=prompt.match(/Kanalangaben \(nur Gestaltung, keine Fakten\): (\{[^\n]+\})/);
 if(channelData)try{const value=JSON.parse(channelData[1]);if(typeof value.name==='string')channel=value.name;}catch{/* Fixture keeps its default. */}
 if(prompt.includes('TEST_WRONG_CHANNEL'))channel='Kontrakurs';
 const script=`Willkommen bei ${channel}.\n${'Testwort '.repeat(900)}\n${cta}\n${outro}`;
 const grokScript={titel:['Testtitel?','Titel zwei!','Titel drei?'],skript:script,thumbnail_text:'Testbild',pin_kommentar:'Dies ist ein Test.',quellen:[`Beispiel – ${sourceUrl}`],hinweise_fuer_dennis:[]};
 const content=request.tools?research:isFacts?facts:isGrokScript?(prompt.includes('TEST_INVALID_PROVIDER_RESPONSE')?{titel:[],skript:'Antwort erhalten'}:grokScript):prompt.includes('TEST_INVALID_PROVIDER_RESPONSE')?{titles:[],script:'Antwort erhalten'}:{titles:['Testtitel','Titel 2','Titel 3'],thumbnail:'Bild',broll:['Eins','Zwei'],script:prompt.includes('TEST_WRONG_CHANNEL')?'Erster Satz. Willkommen bei Kontrakurs. Dritter Satz.':'Erster Satz. Zweiter Satz. Dritter Satz.',generation_warnings:[{fake:true}],generation_target:'forged',image_mode:'render'};
 return new Response(JSON.stringify({model:request.model,id:'mock-generation',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0,server_tool_use_details:{web_search_requests:2}},choices:[{finish_reason:prompt.includes('TEST_TRUNCATED_PROVIDER_RESPONSE')?'length':'stop',message:{content:JSON.stringify(content),annotations:urls.map(url=>({type:'url_citation',url_citation:{url}}))}}]}),{status:200,headers:{'Content-Type':'application/json'}});
};
