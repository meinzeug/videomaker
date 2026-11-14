import {canonicalSourceUrl} from './research.ts';
import {sourceConfirmsSpeaker} from './quote-speaker.ts';
/** An AI-produced fact sheet is a draft, not a guarantee that sources are true. */
type Evidence={text:string;quelle:string;ungeprueft?:boolean};
type Fact={text:string;quellen:string[];belege?:Evidence[];ungeprueft?:boolean};
type Quote={text:string;quelle:string;sprecher?:string;sprecherkontext?:string};
export type FactSheet={fakten:Fact[];meinungen_dritter:Fact[];zitate:Quote[];unklar:string[];hinweise_fuer_dennis:string[];werktitel?:string[];zitatSprecherpflicht?:boolean};
const str=(x:unknown,max:number)=>typeof x==='string'?x.trim().slice(0,max):'';
const obj=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;

/** Reject invented references and keep literal quotes only when directly present in retrieved source text. */
export function validateFactSheet(raw:unknown,sources:unknown,report:unknown,requireEvidence=false):FactSheet {
 const data=obj(raw),rep=obj(report);
 if(!data||!Array.isArray(data.fakten)||!Array.isArray(data.meinungen_dritter)||!Array.isArray(data.zitate)||!Array.isArray(data.unklar)||!Array.isArray(data.hinweise_fuer_dennis))throw new Error('Das Faktenblatt ist unvollständig.');
 const options=obj(rep?.generation_options),fallbackAllowed=options?.scope==='selected'&&options.allowIncompleteSources===true;
 const known=new Set<string>();
 for(const candidate of options?.scope==='selected'?[sources]:[sources,rep?.sources])if(Array.isArray(candidate))for(const entry of candidate){const url=canonicalSourceUrl(obj(entry)?.url);if(url)known.add(url);}
 const originals=new Map<string,string[]>(),fallbacks=new Map<string,string[]>();
 if(Array.isArray(rep?.source_excerpts))for(const entry of rep.source_excerpts){const e=obj(entry),url=canonicalSourceUrl(e?.url),text=str(e?.text,40000);if(!known.has(url)||!text)continue;if(e?.status==='retrieved')originals.set(url,[...(originals.get(url)||[]),text]);else if(e?.status==='unavailable'&&fallbackAllowed)fallbacks.set(url,[...(fallbacks.get(url)||[]),text]);}
 let omittedFacts=0,fallbackFacts=0;const rejectedFacts:string[]=[];
 const readFacts=(items:unknown[]):Fact[]=>items.slice(0,100).map(item=>{
  const f=obj(item),text=typeof f?.text==='string'?f.text.trim():'',refs=Array.isArray(f?.quellen)?[...new Set(f.quellen.map(canonicalSourceUrl).filter(x=>known.has(x)))].slice(0,6):[];
  if(!requireEvidence)return {text,quellen:refs};
  const evidence:Evidence[]=[];
  for(const entry of Array.isArray(f?.belege)?f.belege.slice(0,12):[]){
   const candidate=obj(entry),quote=typeof candidate?.text==='string'?candidate.text.trim():'',url=canonicalSourceUrl(candidate?.quelle);
   if(quote.length<12||!refs.includes(url))continue;
   if(originals.get(url)?.some(source=>source.includes(quote)))evidence.push({text:quote,quelle:url});
   else if(fallbacks.get(url)?.some(source=>source.includes(quote)))evidence.push({text:quote,quelle:url,ungeprueft:true});
  }
  const genuine=evidence.filter(item=>!item.ungeprueft),accepted=genuine.length?genuine:evidence;
  if(!text||!refs.length||!accepted.length){if(text){omittedFacts++;rejectedFacts.push(`Nicht ausreichend belegt: ${text}`);}return null;}
  // Quoted words inside a fact are not exempt from source checking just
  // because they were emitted outside the model's separate quotation list.
  const pairs=[...text.matchAll(/„([^“\r\n]+)“|"([^"\r\n]+)"|»([^«\r\n]+)«/gu)];
  const quotationMarks=(text.match(/[„“"»«]/gu)||[]).length;
  if(quotationMarks!==pairs.length*2||pairs.some(match=>{const quoted=match[1]||match[2]||match[3];return !accepted.some(item=>(item.ungeprueft?fallbacks:originals).get(item.quelle)?.some(source=>source.includes(quoted)));})){omittedFacts++;rejectedFacts.push(`Wortlaut nicht ausreichend belegt: ${text}`);return null;}
  const unverified=accepted.every(item=>item.ungeprueft);if(unverified)fallbackFacts++;
  return {text,quellen:[...new Set(accepted.map(item=>item.quelle))],belege:accepted,...(unverified?{ungeprueft:true}:{})};
 }).filter((x):x is Fact=>!!x&&!!x.text&&!!x.quellen.length);
 const facts=readFacts(data.fakten),opinions=readFacts(data.meinungen_dritter);
 if(!facts.length)throw new Error('Das Faktenblatt enthält keine Aussagen mit bekannten Quellen.');
 // Titles are not speech quotations. Accept a named work only if both the
 // attributed fact and its retrieved source contain its exact title.
 const works=new Set<string>();
 for(const fact of facts){
  const named=/(?:^|[^\p{L}])(?:film|dokumentarfilm|dokufilm|doku|dokumentation|buch|roman|artikel|sendung|serie)\s*(?:[:–—-]\s*)?(?:„([^“\r\n]+)“|"([^"\r\n]+)"|»([^«\r\n]+)«)/giu;
  const attributed=[{text:fact.text,urls:fact.quellen},...(fact.belege||[]).filter(item=>!item.ungeprueft).map(item=>({text:item.text,urls:[item.quelle]}))];
  for(const candidate of attributed)for(const match of candidate.text.matchAll(named)){
   const title=match[1]||match[2]||match[3];
   if(title&&candidate.urls.some(url=>originals.get(url)?.some(source=>[...source.matchAll(named)].some(found=>(found[1]||found[2]||found[3])===title))))works.add(title);
  }
 }
 let omitted=0;const quotes:Quote[]=[];
 for(const item of data.zitate.slice(0,100)){
  const q=obj(item),text=typeof q?.text==='string'?q.text.trim():'',quelle=canonicalSourceUrl(q?.quelle);
  const sprecher=typeof q?.sprecher==='string'?q.sprecher.trim():'',sprecherkontext=typeof q?.sprecherkontext==='string'?q.sprecherkontext.trim():'';
  const named=!!sprecher&&/^[\p{L}\p{M}][\p{L}\p{M}'’\- ]{0,149}$/u.test(sprecher);
  if(text&&known.has(quelle)&&originals.get(quelle)?.some(source=>requireEvidence?named&&sourceConfirmsSpeaker(source,text,sprecher,sprecherkontext):source.includes(text)))quotes.push({text,quelle,...(requireEvidence?{sprecher,sprecherkontext}:{})});else omitted++;
 }
 const strings=(items:unknown[])=>items.map(x=>str(x,1200)).filter(Boolean).slice(0,100);
 const notes=strings(data.hinweise_fuer_dennis);
 if(omittedFacts)notes.push(`${omittedFacts} Aussage(n) ohne exakte überprüfbare Textstelle wurden nicht ins Skript übernommen.`);
 if(fallbackFacts)notes.push(`${fallbackFacts} Aussage(n) beruhen auf ausdrücklich zugelassenen Kurzbeschreibungen, nicht auf abgerufenen Originalquellen, und sind ungeprüft.`);
 if(requireEvidence)notes.push('Belegstellen sind exakte Texttreffer. Sie beweisen nicht automatisch, dass eine Aussage den Quellkontext richtig wiedergibt.');
 if(omitted)notes.push(`${omitted} Zitat(e) ohne überprüfbaren Originalwortlaut${requireEvidence?' oder eindeutige Sprecherstelle':''} wurden ausgelassen.`);
 if(!originals.size)notes.push('Für wörtliche Zitate liegt kein direkt abgerufener Originaltext vor; solche Zitate wurden nicht übernommen.');
 return {fakten:facts,meinungen_dritter:opinions,zitate:quotes,unklar:[...strings(data.unklar),...rejectedFacts],hinweise_fuer_dennis:notes,werktitel:[...works],...(requireEvidence?{zitatSprecherpflicht:true}:{})};
}
