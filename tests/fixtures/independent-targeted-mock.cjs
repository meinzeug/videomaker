// Synthetic test provider. All outbound requests are blocked.
const fs=require('node:fs'),path=require('node:path');
const dir=process.env.INDEPENDENT_TARGETED_FIXTURE;
if(!dir||fs.readFileSync(path.join(dir,'marker'),'utf8')!=='independent-targeted-fixture\n'||process.env.OPENROUTER_API_KEY!=='fake-test-key')throw new Error('Unmarked targeted fixture');
globalThis.fetch=async function(input,init){
 const url=typeof input==='string'?input:input.url;
 if(url!=='https://openrouter.ai/api/v1/chat/completions')throw new Error('External network blocked');
 if(init.headers.Authorization!=='Bearer fake-test-key')throw new Error('Unexpected test key');
 const request=JSON.parse(init.body),system=request.messages[0].content,user=request.messages.at(-1).content;
 const part=user.match(/\bTeil\s+(\d+)\s+von\s+\d+/),schema=request.response_format?.json_schema?.name;
 const phase=system.includes('strukturiertes Faktenblatt')?'facts':schema==='videomaker_teilkorrektur'?'repair':part?`part${part[1]}`:'blocked-image-planning';
 fs.appendFileSync(path.join(dir,'requests.log'),JSON.stringify({phase,model:request.model})+'\n');
 if(phase==='blocked-image-planning')throw new Error('Fixture does not generate images');
 const source='https://example.org/source',meta={titel:['Erster Titel','Zweiter Titel','Dritter Titel'],thumbnail_text:'Ein Thema',pin_kommentar:'Was meint ihr?',quellen:[`Quelle – ${source}`],hinweise_fuer_dennis:[]};
 const payload=phase==='facts'?{fakten:[{text:'Synthetischer Fakt.',quellen:[source],belege:[{text:'Synthetischer Fakt.',quelle:source}]}],meinungen_dritter:[],zitate:[{text:'„Synthetischer Fakt.“',quelle:source,sprecher:'Luisa Neubauer',sprecherkontext:'Luisa Neubauer sagt: „Synthetischer Fakt.“'}],unklar:['Interner Testhinweis'],hinweise_fuer_dennis:[],skriptplan:{teile:['Einleitung','Zitat']}}:phase==='part1'?{skript:'Originaler erster Teil.'}:phase==='part2'?{...meta,skript:process.env.INDEPENDENT_INTERNAL_NOTE==='1'?'Der genaue Zeitpunkt liegt nicht im Faktenblatt vor.':'Zitat: „Erfundener Wortlaut.“'}:{...meta,teile:[{teil:2,skript:'Luisa Neubauer sagt: „Synthetischer Fakt.“'}]};
 return new Response(JSON.stringify({id:'mock-targeted',model:request.model,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}),{status:200});
};
