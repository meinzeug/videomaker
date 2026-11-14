import {Resolver} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import type {NewsSource} from './research.ts';

const MAX_BYTES=1024*1024, MAX_TEXT=40000, TIMEOUT_MS=12000;
const state=globalThis as typeof globalThis & {__videomakerSourceReaders?:number};
export class SourceFetchBusy extends Error {}
type SourceResult={source:NewsSource;status:'retrieved'|'unavailable';text:string;truncated:boolean};
type FetchDependencies={resolver:()=>{resolve4:(host:string)=>Promise<string[]>;cancel:()=>void};request:typeof httpsRequest;timeoutMs?:number};

/** Conservatively permit only globally routable IPv4 destinations. */
export function publicIPv4(address:string):boolean {
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===192&&b===0&&(c===0||c===2))||(a===192&&b===88&&c===99)||(a===198&&(b===18||b===19))||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113));
}

function sourceUrl(value:string):URL {
 const u=new URL(value),host=u.hostname.toLowerCase().replace(/\.$/,'');
 if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(host)||!host.includes('.')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal'))throw new Error('Quellenadresse nicht zulässig');
 return u;
}

function remaining(signal:AbortSignal):Promise<never> {
 return new Promise((_,reject)=>{if(signal.aborted){reject(new Error('Zeitlimit'));return;}signal.addEventListener('abort',()=>reject(new Error('Zeitlimit')),{once:true});});
}

export function extractSourceText(body:string,html:boolean):string {
 let s=body;
 if(html){
  const lower=body.toLowerCase(),parts:string[]=[];let at=0;
  const ignored=new Set(['script','style','noscript','svg','nav','footer','head']);
  while(at<body.length){
   const open=body.indexOf('<',at);if(open<0){parts.push(body.slice(at));break;}
   parts.push(body.slice(at,open),' ');
   if(body.startsWith('<!--',open)){const end=body.indexOf('-->',open+4);if(end<0)break;at=end+3;continue;}
   const end=body.indexOf('>',open+1);if(end<0)break;
   const tag=lower.slice(open+1,Math.min(end,open+128)).match(/^\s*([a-z][a-z0-9:-]*)/i)?.[1];
   if(tag&&ignored.has(tag)){
    const close=lower.indexOf(`</${tag}`,end+1);if(close<0)break;
    const closeEnd=body.indexOf('>',close+tag.length+2);if(closeEnd<0)break;at=closeEnd+1;
   }else at=end+1;
  }
  s=parts.join('');
 }
 const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',auml:'ä',ouml:'ö',uuml:'ü',Auml:'Ä',Ouml:'Ö',Uuml:'Ü',szlig:'ß'};
 s=s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(all,entity:string)=>{if(entity[0]!=='#')return named[entity]??' ';const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);return Number.isFinite(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):' ';});
 return s.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_TEXT);
}

async function fetchOne(input:NewsSource,deps?:FetchDependencies):Promise<SourceResult> {
 if((state.__videomakerSourceReaders??0)>=8)throw new SourceFetchBusy('Zu viele Quellenabrufe. Bitte erneut versuchen.');
 state.__videomakerSourceReaders=(state.__videomakerSourceReaders??0)+1;
 const release=()=>{state.__videomakerSourceReaders=Math.max(0,(state.__videomakerSourceReaders??1)-1);};
 let pendingLookup:Promise<unknown>|null=null;
 const signal=AbortSignal.timeout(deps?.timeoutMs??TIMEOUT_MS);
 const resolver=deps?.resolver()??new Resolver();signal.addEventListener('abort',()=>resolver.cancel(),{once:true});
 try {
  let current=sourceUrl(input.url);const initialHost=current.hostname.toLowerCase();
  for(let redirect=0;redirect<=2;redirect++) {
   // A dedicated cancellable resolver avoids tying up Node's shared libuv pool.
   // Unlike dns.lookup, this intentionally does not consult the hosts file.
   const resolving=resolver.resolve4(current.hostname);pendingLookup=resolving;
   const resolved=await Promise.race([resolving,remaining(signal)]);pendingLookup=null;
   if(!resolved.length||resolved.some(address=>!publicIPv4(address)))throw new Error('Quellenadresse nicht öffentlich');
   const address=resolved[0];
   const result=await new Promise<{redirect?:string;body?:Buffer;contentType?:string}>((resolve,reject)=>{
    const req=(deps?.request??httpsRequest)({protocol:'https:',hostname:address,servername:current.hostname,port:443,path:current.pathname+current.search,method:'GET',headers:{Host:current.host,Accept:'text/html,text/plain;q=0.9','Accept-Encoding':'identity','User-Agent':'Videomaker-SourceReader/1.0'},signal,maxHeaderSize:16384,rejectUnauthorized:true,agent:false},res=>{
     const status=res.statusCode||0;
     if([301,302,303,307,308].includes(status)){const location=res.headers.location;res.destroy();if(!location){reject(new Error('Ungültige Weiterleitung'));return;}resolve({redirect:location});return;}
     const contentType=String(res.headers['content-type']||'').toLowerCase(),encoding=String(res.headers['content-encoding']||'identity').toLowerCase();
     if(status!==200||!(/^(text\/html|text\/plain)(?:;|$)/.test(contentType))||encoding!=='identity'){res.destroy();reject(new Error('Quelltext nicht verfügbar'));return;}
     const length=Number(res.headers['content-length']||0);if(!Number.isFinite(length)||length>MAX_BYTES){res.destroy();reject(new Error('Quelle zu groß'));return;}
     const chunks:Buffer[]=[];let total=0;res.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>MAX_BYTES){res.destroy(new Error('Quelle zu groß'));return;}chunks.push(chunk);});
     res.on('error',reject);res.on('end',()=>resolve({body:Buffer.concat(chunks,total),contentType}));
    });req.on('error',reject);req.end();
   });
   if(result.redirect){if(redirect===2)throw new Error('Zu viele Weiterleitungen');const next=sourceUrl(new URL(result.redirect,current).href);if(next.hostname.toLowerCase()!==initialHost)throw new Error('Weiterleitung zu anderer Quelle');current=next;continue;}
   const charset=result.contentType?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]||'utf-8';
   const decoder=new TextDecoder(charset,{fatal:false});const text=extractSourceText(decoder.decode(result.body),!!result.contentType?.startsWith('text/html'));
   if(text.length<80)throw new Error('Zu wenig Quelltext');
   return {source:input,status:'retrieved',text,truncated:text.length>=MAX_TEXT};
  }
 }catch{}finally{
  // Hold the slot until any timed-out resolver call has actually settled.
  if(pendingLookup)void pendingLookup.then(release,release);else release();
 }
 return {source:input,status:'unavailable',text:'',truncated:false};
}

/** No browser state, cookies, credentials, nonselected sources, or external search. */
export async function fetchSelectedSources(sources:NewsSource[],deps?:FetchDependencies):Promise<SourceResult[]> {
 return Promise.all(sources.map(source=>fetchOne(source,deps)));
}
