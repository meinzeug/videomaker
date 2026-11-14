import type {FactSheet} from './fact-sheet.ts';


export type GrokScript={titles:string[];script:string;thumbnail:string;broll:string[];pin_kommentar:string;hinweise_fuer_dennis:string[];quellen:string[]};
export type ParsedGrokScript={project:GrokScript|null;issues:Array<{code:string;message:string;pattern?:string}>};
const one=(x:unknown,_max:number)=>typeof x==='string'?x.trim():'';
const list=(x:unknown,max=100)=>Array.isArray(x)?x.map(y=>one(y,2000)).filter(Boolean).slice(0,max):null;

/** Validate the exact text that is later saved to content.script; never append framing afterwards. */
export function parseGrokScript(text:string,truncated:boolean,facts:FactSheet,_channelName?:string,_kontrakurs=true):ParsedGrokScript {
 if(truncated)return {project:null,issues:[{code:'truncated',message:'Die KI-Antwort wurde am Tokenlimit abgeschnitten.'}]};
 let data:Record<string,unknown>;
 try{const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();data=value;}
 catch{return {project:null,issues:[{code:'json',message:'Die KI-Antwort ist kein gültiges JSON.'}]};}
 const titles=list(data.titel,3),script=typeof data.skript==='string'?data.skript:'',thumbnail=one(data.thumbnail_text,1000),pin=one(data.pin_kommentar,3000),sources=list(data.quellen),notes=list(data.hinweise_fuer_dennis);
 const issues:Array<{code:string;message:string;pattern?:string}>=[];
 if(!Array.isArray(data.titel)||data.titel.length!==3||!titles||titles.length!==3)issues.push({code:'titel',message:'Das Feld titel muss ein Array mit genau drei nichtleeren Strings sein.'});
 if(!script.trim())issues.push({code:'skript',message:'Das Feld skript muss ein nichtleerer String mit dem vollständigen Telepromptertext sein.'});
 if(!thumbnail)issues.push({code:'thumbnail_text',message:'Das Feld thumbnail_text muss ein nichtleerer String sein.'});
 if(!pin)issues.push({code:'pin_kommentar',message:'Das Feld pin_kommentar muss ein nichtleerer String mit ein bis zwei Sätzen sein.'});
 if(!Array.isArray(data.quellen)||data.quellen.some(x=>typeof x!=='string'))issues.push({code:'quellen',message:'Das Feld quellen muss ein Array aus Strings im Format Quelle – URL sein.'});
 if(!Array.isArray(data.hinweise_fuer_dennis)||data.hinweise_fuer_dennis.some(x=>typeof x!=='string'))issues.push({code:'hinweise_fuer_dennis',message:'Das Feld hinweise_fuer_dennis muss ein Array aus Strings sein, auch bei nur einem Hinweis; wenn keine Hinweise vorliegen, verwende [].'});
 // Literal quotation marks and announced quotations are accepted only when the exact words were checked against a retrieved original.
 const pairs:Record<string,string>={'„':'“','“':'”','"':'"','»':'«','«':'»','‚':'‘'},closers=new Set(['”','‘']);
 // A literal source quotation may itself contain the surrounding quote marks.
 // Remove only one exact matching outer pair after source verification; no
 // whitespace, punctuation or content inside the verified words is changed.
 const verified=facts.zitate.flatMap(({text})=>{
  const close=pairs[text[0]];
  return close&&text.length>2&&text.endsWith(close)?[text,text.slice(1,-1)]:[text];
 });
 const quoted:string[]=[];
 for(let index=0;index<script.length;index++){
  const char=script[index],close=pairs[char];
  if(close){const end=script.indexOf(close,index+1);if(end<0||end-index>2001){issues.push({code:'unverified_quote',message:'Ein wörtliches Zitat ist nicht vollständig begrenzt.'});break;}quoted.push(script.slice(index+1,end));index=end;}
  else if(closers.has(char)){issues.push({code:'unverified_quote',message:'Ein wörtliches Zitat ist nicht vollständig begrenzt.'});break;}
 }
 // Each announced quotation must be checked separately, including multiple
 // announcements on one line. A continuation is safe only after an explicit
 // closing delimiter and an already complete quoted sentence. Without such a
 // delimiter a following sentence could still be part of the quotation.
 const markers=[...script.matchAll(/(?:^|\s)(?:Zitat|wörtlich):[^\S\r\n]*/giu)];
 const exactLine=(line:string,q:string)=>[q,`„${q}“`,`“${q}”`,`"${q}"`,`»${q}«`,`«${q}»`,`‚${q}‘`].includes(line.trim());
 let ambiguousBoundary=false;
 const announcedChecks=markers.map((marker,index)=>{
  const start=marker.index+marker[0].length,next=markers[index+1]?.index??script.length;
  const newline=script.slice(start,next).search(/[\r\n]/u);
  const line=script.slice(start,newline<0?next:start+newline).trimEnd();
  if(verified.some(q=>exactLine(line,q)))return true;
  const close=pairs[line[0]];if(!close){if(verified.some(q=>line.startsWith(q)&&line.length>q.length))ambiguousBoundary=true;return false;}
  const end=line.indexOf(close,1);if(end<0)return false;
  const contents=line.slice(1,end),rest=line.slice(end+1);
  return verified.includes(contents)&&/[.!?…]$/u.test(contents)&&/^[^\S\r\n]+[\p{Lu}]/u.test(rest);
 });
 if(quoted.some(q=>!verified.includes(q))||announcedChecks.some(valid=>!valid))issues.push({code:'unverified_quote',message:ambiguousBoundary?'Die Grenze einer als wörtlich angekündigten Passage ist ohne schließende Anführungszeichen nicht eindeutig. Bitte das vollständige belegte Zitat exakt mit Anführungszeichen abgrenzen.':'Ein Ausdruck in Anführungszeichen oder eine als Zitat angekündigte Passage ist nicht als wörtliches Zitat im Faktenblatt bestätigt. Auch belegte Werk- oder Eigennamen können betroffen sein; gegebenenfalls ohne Anführungszeichen formulieren.'});
 if(issues.length||!titles||!sources||!notes)return {project:null,issues};
 const allowed=new Set([...facts.fakten.flatMap(f=>f.quellen),...facts.meinungen_dritter.flatMap(f=>f.quellen),...facts.zitate.map(q=>q.quelle)]);
 const accepted:string[]=[];let rejected=0;
 for(const source of sources){
  const urls=source.match(/https?:\/\/[^\s<>"']+/g)||[];
  const url=urls.length===1?urls[0].replace(/[),.;]+$/,''):'';
  if(allowed.has(url)){try{const entry=`${new URL(url).hostname} – ${url}`;if(!accepted.includes(entry))accepted.push(entry);}catch{rejected++;}}else rejected++;
 }
 const notices=[...facts.hinweise_fuer_dennis,...notes];
 if(rejected)notices.push(`${rejected} Quellenangabe(n) ohne passenden Faktenblattbeleg wurden entfernt.`);
 if(!accepted.length&&allowed.size){for(const url of allowed){try{accepted.push(`${new URL(url).hostname} – ${url}`);}catch{}}notices.push('Die Quellenliste wurde aus den belegten Faktenblatt-URLs ergänzt.');}
 return {project:{titles,script,thumbnail,broll:[],pin_kommentar:pin,hinweise_fuer_dennis:notices,quellen:accepted},issues:[]};
}
