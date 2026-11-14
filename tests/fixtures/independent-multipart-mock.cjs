// This mock refuses every outbound request. It must only run in its own marked fixture.
const fs=require('node:fs');
const path=require('node:path');
const dir=process.env.INDEPENDENT_MULTIPART_FIXTURE;
if(!dir||fs.readFileSync(path.join(dir,'marker'),'utf8')!=='independent-multipart-fixture\n'||process.env.OPENROUTER_API_KEY!=='fake-test-key')throw new Error('Unmarked multipart fixture');
globalThis.fetch=async function(input,init){
 const url=typeof input==='string'?input:input.url;
 if(url!=='https://openrouter.ai/api/v1/chat/completions')throw new Error('All other outbound requests are blocked in the multipart fixture.');
 if(init.headers.Authorization!=='Bearer fake-test-key')throw new Error('Only the fake test key is allowed.');
 const request=JSON.parse(init.body),system=request.messages[0].content,user=request.messages.at(-1).content;
 const facts=system.includes('strukturiertes Faktenblatt');
 const partMatch=user.match(/\bTeil\s+(\d+)\s+von\s+\d+/),part=partMatch?Number(partMatch[1]):null;
 const phase=facts?'facts':part?`part${part}`:'unexpected';
 fs.appendFileSync(path.join(dir,'requests.log'),JSON.stringify({phase,model:request.model})+'\n');
 if(phase==='unexpected')throw new Error('Unexpected fake-provider phase');
 if(phase==='part2'){
  fs.writeFileSync(path.join(dir,'part2-inflight'),'1');
  // Never complete: the test kills this process and verifies no double call.
  await new Promise(()=>{});
 }
 const urlSource='https://example.org/a';
 const result=facts?{fakten:[{text:'Synthetischer Fakt.',quellen:[urlSource]}],meinungen_dritter:[],zitate:[],unklar:[],hinweise_fuer_dennis:[],skriptplan:{teile:['Einstieg','Hauptteil','Abschluss']}}:{skript:`Synthetischer Abschnitt ${part}.`};
 return new Response(JSON.stringify({id:'mock-multipart',model:request.model,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}),{status:200});
};
