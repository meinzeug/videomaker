// Exact wording is not enough: the stated speaker must also be supported.
// All texts below are synthetic and no network/provider is contacted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(process.env.GROK_TEST_ROOT||process.cwd());
const {validateFactSheet}=await import(pathToFileURL(path.join(root,'lib','fact-sheet.ts')));
const {parseGrokScript}=await import(pathToFileURL(path.join(root,'lib','grok-result.ts')));
const url='https://example.org/article',speaker='Luisa Neubauer';
const quote='Es geht nicht darum, dass wir überall einer Meinung sind.';
const context=`Greta Thunberg sprach zuvor über das Video. Luisa Neubauer erklärte ihre Sicht. „${quote}“, sagte Neubauer der Zeitung.`;
const report={sources:[{url}],source_excerpts:[{url,status:'retrieved',text:context}],generation_options:{scope:'selected',allowIncompleteSources:false}};
const sources=[{url,title:'Testquelle',source:'Test',date:'',description:''}];
const raw={fakten:[{text:'Neubauer sprach über unterschiedliche Meinungen.',quellen:[url],belege:[{text:`„${quote}“, sagte Neubauer der Zeitung.`,quelle:url}]}],meinungen_dritter:[],zitate:[{text:`„${quote}“`,quelle:url,sprecher:speaker,sprecherkontext:context}],unklar:[],hinweise_fuer_dennis:[]};
const answer=script=>JSON.stringify({titel:['Eins','Zwei','Drei'],skript:script,thumbnail_text:'Ein Thema',pin_kommentar:'Was meint ihr?',quellen:[url],hinweise_fuer_dennis:[]});

test('correctly attributed quote from a source mentioning two people is accepted',()=>{
 const facts=validateFactSheet(raw,sources,report,true);
 assert.equal(facts.zitate.length,1,'source explicitly attributes the quote to Neubauer');
 assert.ok(parseGrokScript(answer(`Luisa Neubauer sagte: „${quote}“`),false,facts).project);
 assert.ok(parseGrokScript(answer(`„${quote}“, sagte Luisa Neubauer.`),false,facts).project);
});

test('same exact quote with a false, missing, pronoun-only or multi-person attribution is not released',()=>{
 const facts=validateFactSheet(raw,sources,report,true);
 for(const script of [`„${quote}“, wird Thunberg zitiert.`,`Greta Thunberg sagte: „${quote}“`,`„${quote}“`,`Sie sagte: „${quote}“`,`Luisa Neubauer und Greta Thunberg sagten: „${quote}“`]){
  const result=parseGrokScript(answer(script),false,facts);
  assert.equal(result.project,null,script);assert.ok(result.issues.some(x=>/quote|zitat|speaker|sprecher/iu.test(x.code)),script);
 }
});

test('mere proximity to multiple names or an ambiguous pronoun cannot establish a speaker',()=>{
 for(const altered of [
  {speaker:'Greta Thunberg',source:context},
  {speaker:'',source:context},
  {speaker,source:`Greta Thunberg traf Luisa Neubauer. Sie sagte: „${quote}“`},
  {speaker,source:`Greta Thunberg und Luisa Neubauer diskutierten. „${quote}“`},
 ]){
  const input={...raw,zitate:[{text:`„${quote}“`,quelle:url,sprecher:altered.speaker,sprecherkontext:altered.source}]};
  const sourceReport={...report,source_excerpts:[{url,status:'retrieved',text:altered.source}]};
  // Preserve one ordinary sourced fact independent of the attribution under test.
  input.fakten=[{text:'Der Bericht enthält Text.',quellen:[url],belege:[{text:altered.source,quelle:url}]}];
  const facts=validateFactSheet(input,sources,sourceReport,true);
  assert.deepEqual(facts.zitate,[],`unverified speaker must be omitted for ${altered.speaker}`);
 }
});

test('unretrieved or altered speaker context cannot establish an attributed quote',()=>{
 for(const bad of [context+' erfundener Nachsatz','',`„${quote}“, sagte Luisa Neubauer.`]){
  const input={...raw,zitate:[{...raw.zitate[0],sprecherkontext:bad}]};
  assert.deepEqual(validateFactSheet(input,sources,report,true).zitate,[]);
 }
});

test('matching surnames alone never invent first names or resolve two people with the same surname',()=>{
 const invented={...raw,zitate:[{...raw.zitate[0],sprecher:'Greta Neubauer'}]};
 assert.deepEqual(validateFactSheet(invented,sources,report,true).zitate,[],'a first name absent from the source cannot be inferred from the surname');
 const ambiguous=`Luisa Neubauer und Max Neubauer sprachen über das Video. „${quote}“, sagte Neubauer der Zeitung.`;
 const input={...raw,fakten:[{text:'Die Quelle berichtet über Neubauer.',quellen:[url],belege:[{text:ambiguous,quelle:url}]}],zitate:[{text:`„${quote}“`,quelle:url,sprecher:speaker,sprecherkontext:ambiguous}]};
 const sourceReport={...report,source_excerpts:[{url,status:'retrieved',text:ambiguous}]};
 assert.deepEqual(validateFactSheet(input,sources,sourceReport,true).zitate,[],'a bare surname must not choose between two people');
});

test('a work title in an exact evidence excerpt is a title, not permission to invent speech',()=>{
 const title='Ein Film über das Klima',excerpt=`Für seinen Film „${title}“ wurde sie in einer Küche befragt.`;
 const sourceReport={...report,source_excerpts:[{url,status:'retrieved',text:excerpt}]};
 const input={...raw,fakten:[{text:'Das Interview fand in einer Küche statt.',quellen:[url],belege:[{text:excerpt,quelle:url}]}],zitate:[]};
 const facts=validateFactSheet(input,sources,sourceReport,true);
 assert.ok(facts.werktitel.includes(title));
 assert.ok(parseGrokScript(answer(`Der Film „${title}“ enthält ein Interview.`),false,facts).project);
 assert.equal(parseGrokScript(answer(`Der Film „${title}“, sagte Greta Thunberg.`),false,facts).project,null);
 const noTitleContext={...sourceReport,source_excerpts:[{url,status:'retrieved',text:`Sie sagte „${title}“ in der Küche.`}]};
 const falselyClaimed={...input,fakten:[{...input.fakten[0],belege:[{text:`Sie sagte „${title}“ in der Küche.`,quelle:url}]}]};
 const without=validateFactSheet(falselyClaimed,sources,noTitleContext,true);
 assert.ok(!without.werktitel.includes(title));
 assert.equal(parseGrokScript(answer(`Der Film „${title}“ enthält ein Interview.`),false,without).project,null);
});
