export type ManualSource={title:string;url:string;source:string;date:string;description:string};
export type ManualPackage={title:string;angle:string;sources:ManualSource[]};
export type ManualScript={title:string;script:string;thumbnail:string;broll:string[];titles:string[];sources:ManualSource[]};

function text(value:unknown,label:string,max:number,required=false):string {
 if(value===undefined||value===null)value='';
 if(typeof value!=='string')throw new Error(`${label} ist ungültig.`);
 const result=value.trim();
 if(required&&!result)throw new Error(`${label} fehlt.`);
 if(result.length>max)throw new Error(`${label} ist zu lang (maximal ${max} Zeichen).`);
 return result;
}
function parseSources(value:unknown):ManualSource[] {
 if(!Array.isArray(value)||value.length>3)throw new Error('Bitte höchstens drei Quellen angeben.');
 const seen=new Set<string>();
 return value.map((item:unknown):ManualSource=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Ungültige Quelle.');
  const source=item as Record<string,unknown>;const raw=text(source.url,'Quellenlink',1000,true);
  let url:URL;try{url=new URL(raw);}catch{throw new Error('Bitte einen gültigen HTTPS-Artikel-Link eingeben.');}
  if(url.protocol!=='https:'||!url.hostname.includes('.')||url.pathname==='/'||url.username||url.password)throw new Error('Bitte einen vollständigen HTTPS-Artikel-Link eingeben.');
  if(seen.has(url.href))throw new Error('Jeder Quellenlink darf nur einmal vorkommen.');seen.add(url.href);
  const date=text(source.date,'Quellendatum',100);
  if(date&&!Number.isFinite(Date.parse(date)))throw new Error('Bitte ein gültiges Quellendatum angeben.');
  return {url:url.href,title:text(source.title,'Quellentitel',500)||url.hostname,source:text(source.source,'Medium',100)||url.hostname,date:date?new Date(date).toISOString():'',description:text(source.description,'Quellenbeschreibung',800)};
 });
}
export function parseManualPackage(data:unknown):ManualPackage {
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Ungültiges News-Paket.');
 const input=data as Record<string,unknown>;
 const title=text(input.title,'Titel',200,true),angle=text(input.angle,'Blickwinkel',2000);
 const sources=parseSources(input.sources);
 return {title,angle,sources};
}
export function parseManualScript(data:unknown):ManualScript {
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Ungültiges Skript.');
 const input=data as Record<string,unknown>;
 if(!Array.isArray(input.broll)||input.broll.length>30)throw new Error('Bitte höchstens 30 Bildideen angeben.');
 const title=text(input.title,'Titel',200,true);
 if(typeof input.script!=='string'||!input.script.trim())throw new Error('Skripttext fehlt.');
 if(input.script.length>300000)throw new Error('Skripttext ist zu lang (maximal 300000 Zeichen).');
 const alternatives=input.titles===undefined?[]:input.titles;
 if(!Array.isArray(alternatives)||alternatives.length>2)throw new Error('Bitte höchstens zwei weitere Titelideen angeben.');
 return {title,script:input.script,thumbnail:text(input.thumbnail,'Thumbnail-Idee',5000),broll:input.broll.map(x=>text(x,'Bildidee',3000)).filter(Boolean),titles:[title,...alternatives.map(x=>text(x,'Titelidee',200)).filter(Boolean)],sources:parseSources(input.sources===undefined?[]:input.sources)};
}
