/** An AI-produced fact sheet is a draft, not a guarantee that sources are true. */
type Fact={text:string;quellen:string[]};
type Quote={text:string;quelle:string};
export type FactSheet={fakten:Fact[];meinungen_dritter:Fact[];zitate:Quote[];unklar:string[];hinweise_fuer_dennis:string[]};
const str=(x:unknown,max:number)=>typeof x==='string'?x.trim().slice(0,max):'';
const obj=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;

/** Reject invented references and keep literal quotes only when directly present in retrieved source text. */
export function validateFactSheet(raw:unknown,sources:unknown,report:unknown):FactSheet {
 const data=obj(raw),rep=obj(report);
 if(!data||!Array.isArray(data.fakten)||!Array.isArray(data.meinungen_dritter)||!Array.isArray(data.zitate)||!Array.isArray(data.unklar)||!Array.isArray(data.hinweise_fuer_dennis))throw new Error('Das Faktenblatt ist unvollständig.');
 const known=new Set<string>();
 for(const candidate of [sources,rep?.sources])if(Array.isArray(candidate))for(const entry of candidate){const url=str(obj(entry)?.url,2000);try{const parsed=new URL(url);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&parsed.hostname)known.add(url);}catch{}}
 const originals=new Map<string,string[]>();
 if(Array.isArray(rep?.source_excerpts))for(const entry of rep.source_excerpts){const e=obj(entry),url=str(e?.url,2000),text=str(e?.text,40000);if(e?.status==='retrieved'&&known.has(url)&&text)originals.set(url,[...(originals.get(url)||[]),text]);}
 const readFacts=(items:unknown[]):Fact[]=>items.slice(0,100).map(item=>{
  const f=obj(item),text=str(f?.text,1600),refs=Array.isArray(f?.quellen)?[...new Set(f.quellen.map(x=>str(x,2000)).filter(x=>known.has(x)))].slice(0,6):[];
  return {text,quellen:refs};
 }).filter(x=>x.text&&x.quellen.length);
 const facts=readFacts(data.fakten),opinions=readFacts(data.meinungen_dritter);
 if(!facts.length)throw new Error('Das Faktenblatt enthält keine Aussagen mit bekannten Quellen.');
 let omitted=0;const quotes:Quote[]=[];
 for(const item of data.zitate.slice(0,100)){
  const q=obj(item),text=str(q?.text,2000),quelle=str(q?.quelle,2000);
  if(text&&known.has(quelle)&&originals.get(quelle)?.some(source=>source.includes(text)))quotes.push({text,quelle});else omitted++;
 }
 const strings=(items:unknown[])=>items.map(x=>str(x,1200)).filter(Boolean).slice(0,100);
 const notes=strings(data.hinweise_fuer_dennis);
 if(omitted)notes.push(`${omitted} Zitat(e) ohne überprüfbaren Originalwortlaut wurden ausgelassen.`);
 if(!originals.size)notes.push('Für wörtliche Zitate liegt kein direkt abgerufener Originaltext vor; solche Zitate wurden nicht übernommen.');
 return {fakten:facts,meinungen_dritter:opinions,zitate:quotes,unklar:strings(data.unklar),hinweise_fuer_dennis:notes};
}
