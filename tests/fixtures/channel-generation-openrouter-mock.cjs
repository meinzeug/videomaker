// Only use with the explicit, isolated fixture documented in
// docs/channel-generation-tests.md. No OpenRouter request leaves this process.
const fs=require('node:fs');
const path=require('node:path');
const directory=process.env.CHANNEL_GENERATION_FIXTURE_DIR;
if(!directory||fs.readFileSync(path.join(directory,'.channel-fixture'),'utf8')!=='isolated-channel-generation\n')throw new Error('Channel mock requires its own marked fixture.');
const original=globalThis.fetch;
globalThis.fetch=async function(input,init){
 const url=typeof input==='string'?input:input.url;
 if(!url.startsWith('https://openrouter.ai/'))return original.apply(this,arguments);
 const request=JSON.parse(init.body),messages=request.messages,prompt=messages?.[1]?.content||'';
 fs.appendFileSync(path.join(directory,'ai-requests.log'),JSON.stringify(messages)+'\n');
 if(prompt.includes('TEST_MOCK_FAILURE'))return new Response(JSON.stringify({error:{message:'mock failure'}}),{status:500,headers:{'Content-Type':'application/json'}});
 if(prompt.includes('TEST_DELETE_DURING_GENERATION')){
  fs.writeFileSync(path.join(directory,'waiting'),'1');
  for(let i=0;i<400&&!fs.existsSync(path.join(directory,'release'));i++)await new Promise(resolve=>setTimeout(resolve,25));
 }
 const urls=['https://example.org/a','https://example.net/b','https://example.org/c'];
 const research={summary:'Beispiel',sources:urls.map((url,i)=>({title:`Quelle ${i}`,url,publisher:'Beispiel',date:'2026-01-01'})),findings:urls.map(url=>({claim:'Beispiel',assessment:'belegt',explanation:'Testdaten',source_urls:[url]})),hypotheses:[],open_questions:[]};
 const content=request.tools?research:{titles:['Testtitel','Titel 2','Titel 3'],thumbnail:'Bild',broll:['Eins','Zwei'],script:prompt.includes('TEST_WRONG_CHANNEL')?'Erster Satz. Willkommen bei Kontrakurs. Dritter Satz.':'Erster Satz. Zweiter Satz. Dritter Satz.',generation_warnings:[{fake:true}],generation_target:'forged',image_mode:'render'};
 return new Response(JSON.stringify({usage:{server_tool_use_details:{web_search_requests:2}},choices:[{finish_reason:'stop',message:{content:JSON.stringify(content),annotations:urls.map(url=>({type:'url_citation',url_citation:{url}}))}}]}),{status:200,headers:{'Content-Type':'application/json'}});
};
