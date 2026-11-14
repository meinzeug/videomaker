// Behavioral source-evidence tests: synthetic text only, no provider or network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(process.env.GROK_TEST_ROOT||process.cwd());
const {validateFactSheet}=await import(pathToFileURL(path.join(root,'lib','fact-sheet.ts')));
const first='https://example.org/selected',second='https://example.net/web';
const sources=[{url:first,title:'Auswahl',source:'Test',date:'',description:''}];
const sourceText='Vorheriger Satz. Die vollständige bestätigte Meldung enthält exakt diese Quelle. Danach folgt weiterer Kontext.';
const cited='Die vollständige bestätigte Meldung enthält exakt diese Quelle.';
const base={fakten:[{text:'Eine Aussage aus der Quelle.',quellen:[first],belege:[{text:cited,quelle:first}]}],meinungen_dritter:[],zitate:[],unklar:['Eine nicht beantwortete Frage.'],hinweise_fuer_dennis:[]};
const selected=(status='retrieved',text=sourceText,allow=false)=>({generation_options:{scope:'selected',allowIncompleteSources:allow},sources:[{url:first}],source_excerpts:[{url:first,status,text}]});

test('facts require complete contiguous original evidence and retain uncertainty separately',()=>{
 const facts=validateFactSheet(base,sources,selected(),true);
 assert.equal(facts.fakten.length,1);assert.equal(facts.fakten[0].belege[0].text,cited);
 assert.deepEqual(facts.unklar,['Eine nicht beantwortete Frage.']);
 assert.match(facts.hinweise_fuer_dennis.join(' '),/beweisen nicht|nicht automatisch/iu);
});

test('exact occurrence alone is not reported as semantic verification',()=>{
 const snippet='Sie wurde in einer Küche interviewt und sprach über die geplante Demo.';
 const raw={...base,fakten:[{text:'Sie selbst nahm an der Demonstration teil.',quellen:[first],belege:[{text:snippet,quelle:first}]}]};
 const result=validateFactSheet(raw,sources,selected('retrieved',snippet),true);
 assert.equal(result.fakten.length,1,'this mechanical pass only checks occurrence, not semantic entailment');
 assert.match(result.hinweise_fuer_dennis.join(' '),/beweisen nicht|nicht automatisch/iu);
});

test('invented, shortened-to-match and overlong source evidence never silently verifies a fact',()=>{
 const evidence=[cited+' frei erfundener Nachsatz',sourceText+' erfundene Fortsetzung','x'.repeat(40001)];
 for(const text of evidence){
  const raw={...base,fakten:[...base.fakten,{text:'Falsche Aussage',quellen:[first],belege:[{text,quelle:first}]}]};
  const facts=validateFactSheet(raw,sources,selected(),true);
  assert.deepEqual(facts.fakten.map(x=>x.text),['Eine Aussage aus der Quelle.']);
  assert.match(facts.hinweise_fuer_dennis.join(' '),/Aussage.*nicht/iu);
 }
});

test('overlong generated factual statements are never silently shortened',()=>{
 const longText='Eine lange Aussage '.repeat(100)+'Das ist ausdrücklich nicht geschehen.';
 const raw={...base,fakten:[...base.fakten,{text:longText,quellen:[first],belege:[{text:cited,quelle:first}]}]};
 const facts=validateFactSheet(raw,sources,selected(),true);
 const item=facts.fakten.find(x=>x.text.startsWith('Eine lange Aussage'));
 assert.ok(!item||item.text===longText,'a statement may remain exact or be explicitly rejected, but never truncated');
 if(!item)assert.match(facts.hinweise_fuer_dennis.join(' '),/Aussage.*nicht/iu);
});

test('evidence for one URL cannot be borrowed from a different source',()=>{
 const wrong={...base,fakten:[...base.fakten,{text:'Fremde Aussage',quellen:[first],belege:[{text:'Dies steht nur bei der zweiten Quelle.',quelle:first}]}]};
 const report={...selected(),sources:[{url:first},{url:second}],source_excerpts:[...selected().source_excerpts,{url:second,status:'retrieved',text:'Dies steht nur bei der zweiten Quelle.'}]};
 const facts=validateFactSheet(wrong,sources,report,true);
 assert.deepEqual(facts.fakten.map(x=>x.text),['Eine Aussage aus der Quelle.']);
});

test('selection mode cannot introduce an unselected web source through the report',()=>{
 const raw={...base,fakten:[...base.fakten,{text:'Nicht ausgewählte Quelle',quellen:[second],belege:[{text:'Diese zusätzliche Quelle wurde nicht ausgewählt.',quelle:second}]}]};
 const report={...selected(),sources:[{url:first},{url:second}],source_excerpts:[...selected().source_excerpts,{url:second,status:'retrieved',text:'Diese zusätzliche Quelle wurde nicht ausgewählt.'}]};
 const facts=validateFactSheet(raw,sources,report,true);
 assert.deepEqual(facts.fakten.map(x=>x.text),['Eine Aussage aus der Quelle.']);
});

test('web mode permits an actually retrieved cited web source',()=>{
 const text='Ein Artikel auf einer zweiten geprüften Webseite.';
 const raw={...base,fakten:[...base.fakten,{text:'Weitere Webquelle',quellen:[second],belege:[{text,quelle:second}]}]};
 const report={generation_options:{scope:'web',allowIncompleteSources:false},sources:[{url:first},{url:second}],source_excerpts:[{url:first,status:'retrieved',text:sourceText},{url:second,status:'retrieved',text}]};
 const facts=validateFactSheet(raw,sources,report,true);
 assert.deepEqual(facts.fakten.map(x=>x.text),['Eine Aussage aus der Quelle.','Weitere Webquelle']);
});

test('unavailable short descriptions are accepted only by explicit selection fallback and marked unverified',()=>{
 const description='Laut der Kurzbeschreibung fand das Ereignis in Berlin statt.';
 const raw={...base,fakten:[{text:'Das Ereignis fand laut Kurzbeschreibung in Berlin statt.',quellen:[first],belege:[{text:description,quelle:first}]}],zitate:[{text:description,quelle:first}]};
 assert.throws(()=>validateFactSheet(raw,sources,selected('unavailable',description,false),true));
 const fallback=validateFactSheet(raw,sources,selected('unavailable',description,true),true);
 assert.equal(fallback.fakten[0].ungeprueft,true);assert.equal(fallback.fakten[0].belege[0].ungeprueft,true);
 assert.deepEqual(fallback.zitate,[],'unretrieved descriptions must never become verified literal quotations');
 assert.match(fallback.hinweise_fuer_dennis.join(' '),/Kurzbeschreibung.*ungeprüft/iu);
 const web={...selected('unavailable',description,true),generation_options:{scope:'web',allowIncompleteSources:true}};
 assert.throws(()=>validateFactSheet(raw,sources,web,true),'fallback must not apply to web mode');
});

test('quoted material inside an otherwise sourced fact must itself appear in the original text',()=>{
 const raw={...base,fakten:[...base.fakten,{text:'Dort steht angeblich „eine erfundene Aussage“.',quellen:[first],belege:[{text:cited,quelle:first}]}]};
 const facts=validateFactSheet(raw,sources,selected(),true);
 assert.deepEqual(facts.fakten.map(x=>x.text),['Eine Aussage aus der Quelle.']);
});

test('fragment variants refer to one source while different query parameters stay distinct',async()=>{
 const {normalizeSources}=await import('../lib/research.ts');
 const baseUrl='https://example.org/a?edition=one',same=baseUrl+'#auszug',other='https://example.org/a?edition=two';
 const normalized=normalizeSources([{title:'Auswahl',url:same,source:'Beispiel',date:'',description:''}],1);
 assert.equal(normalized[0].url,baseUrl);
 const exact='Hier steht ein zusammenhängender, belegbarer Originalausschnitt.';
 const report={generation_options:{scope:'selected'},sources:[{url:baseUrl}],source_excerpts:[{url:baseUrl,status:'retrieved',text:exact}]};
 const raw={fakten:[{text:'Diese Aussage verweist auf den ausgewählten Artikel.',quellen:[same],belege:[{text:exact,quelle:baseUrl+'#anderer-anker'}]}],meinungen_dritter:[],zitate:[],unklar:[],hinweise_fuer_dennis:[]};
 const fact=validateFactSheet(raw,normalized,report,true).fakten[0];assert.deepEqual(fact.quellen,[baseUrl]);assert.equal(fact.belege[0].quelle,baseUrl);
 const wrong={...raw,fakten:[{...raw.fakten[0],quellen:[other],belege:[{text:exact,quelle:other}]}]};
 assert.throws(()=>validateFactSheet(wrong,normalized,report,true),'a different query must not borrow evidence');
});
