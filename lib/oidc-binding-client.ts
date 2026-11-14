import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {request} from 'node:https';
import {dirname,isAbsolute,parse,resolve} from 'node:path';

type Configuration={endpoint:string;secret:string;caFile:string};
type Operation='issue'|'check'|'reset';
const cookiePattern=/^kontrakurs_session=[A-Za-z0-9_.-]{1,512}$/;
const referencePattern=/^[A-Za-z0-9_-]{43}$/;
const maxActive=16;
let active=0,caReads=0;

/** Refuse symlinks and paths writable by principals other than root/the service user. */
async function trustedCa(file:string):Promise<Buffer> {
 if(!isAbsolute(file)||resolve(file)!==file)throw new Error('Ungültiger CA-Pfad');
 let parent=dirname(file);
 for(;;){
  const s=await lstat(parent);
  if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o022)!==0||(s.uid!==0&&s.uid!==process.geteuid?.()))throw new Error('Ungeschützter CA-Pfad');
  if(parent===parse(parent).root)break;
  parent=dirname(parent);
 }
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=await handle.stat();
  if(!s.isFile()||s.size<1||s.size>65536||(s.mode&0o022)!==0||(s.uid!==0&&s.uid!==process.geteuid?.()))throw new Error('Ungültige CA-Datei');
  const out=Buffer.alloc(65537);let offset=0;
  while(offset<out.length){const read=await handle.read(out,offset,out.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
  if(offset<1||offset>65536)throw new Error('Ungültige CA-Datei');
  return out.subarray(0,offset);
 }finally{await handle.close();}
}

/**
 * HTTPS-only session-binding transport. It does not run or configure an OIDC provider.
 * Authentication failures return null/false; configuration and transport failures throw.
 */
export function createOidcBindingClient(config:Configuration) {
 let endpoint:URL;
 try{endpoint=new URL(config.endpoint);}catch{throw new Error('Ungültiger OIDC-Sitzungsendpunkt');}
 if(endpoint.protocol!=='https:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.pathname!=='/api/internal/oidc/session-binding'||endpoint.search||endpoint.hash)throw new Error('Ungültiger OIDC-Sitzungsendpunkt');
 const secret=config.secret,caFile=config.caFile;
 if(!/^[\x21-\x7e]{32,512}$/.test(secret)||!isAbsolute(caFile))throw new Error('Ungültige OIDC-Sitzungskonfiguration');
 const send=async(operation:Operation,credential:string):Promise<string|boolean|null>=>{
  if((operation==='check'?!referencePattern.test(credential):!cookiePattern.test(credential)))return operation==='issue'?null:false;
  if(active>=maxActive||caReads>=maxActive)throw new Error('OIDC-Sitzungsprüfung ausgelastet');
  active++;
  const signal=AbortSignal.timeout(2000);
  try{
   caReads++;
   const pendingCa=trustedCa(caFile);
   void pendingCa.then(()=>{caReads--;},()=>{caReads--;});
   const ca=await Promise.race([pendingCa,new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Zeitüberschreitung')),{once:true}))]);
   const response=await new Promise<{status:number;body:string}>((resolveResponse,reject)=>{
    const headers:Record<string,string>={'content-length':'0','x-videomaker-internal-secret':secret,'x-oidc-binding-operation':operation};
    if(operation==='check')headers['x-oidc-session-reference']=credential;else headers.cookie=credential;
    const outgoing=request(endpoint,{method:'POST',headers,ca,servername:'videomaker-session.internal',rejectUnauthorized:true,agent:false,signal},incoming=>{
     let body='',size=0;
     incoming.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024)incoming.destroy(new Error('Antwort zu groß'));else body+=chunk.toString('utf8');});
     incoming.once('end',()=>resolveResponse({status:incoming.statusCode??0,body}));
     incoming.once('error',reject);
    });
    outgoing.once('error',reject);outgoing.end();
   });
   if(response.status===401||response.status===403)return operation==='issue'?null:false;
   if(operation!=='issue'&&response.status===204)return true;
   if(operation==='issue'&&response.status===200){
    let value:unknown;try{value=JSON.parse(response.body);}catch{throw new Error('Ungültige OIDC-Sitzungsantwort');}
    if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as {reference?:unknown}).reference==='string'&&referencePattern.test((value as {reference:string}).reference))return (value as {reference:string}).reference;
   }
   throw new Error('OIDC-Sitzungsprüfung nicht verfügbar');
  }finally{active--;}
 };
 return {
  issue:(cookie:string)=>send('issue',cookie) as Promise<string|null>,
  check:(reference:string)=>send('check',reference) as Promise<boolean>,
  reset:(cookie:string)=>send('reset',cookie) as Promise<boolean>,
 };
}
