import {authorized,sameOrigin,sessionAuthorized,sessionValue} from '@/lib/auth';
import db from '@/lib/db';
import {ensureLanCaptureProject,LanCaptureProjectError} from '@/lib/lan-capture-project';
import {BoundedBodyError,readBoundedRequestBody} from '@/lib/bounded-request-body';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const reply=(body:unknown,status:number)=>NextResponse.json(body,{status,headers});

/** Never accepts a LAN script, credentials, or a caller-supplied project. */
export async function POST(req:Request){
 if(!await authorized()||!await sameOrigin(req))return reply({error:'Nicht erlaubt.'},403);
 const credential=await sessionValue();
 if((req.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='application/json'||!req.body)return reply({error:'Ungültige Aufnahme.'},400);
 const declared=req.headers.get('content-length');
 if(declared!==null&&(!/^\d{1,4}$/.test(declared)||Number(declared)>1024))return reply({error:'Anfrage ist zu groß.'},413);
 let body:Buffer;
 try{body=await readBoundedRequestBody(req.body);}
 catch(error){return error instanceof BoundedBodyError&&error.code==='TOO_LARGE'?reply({error:'Anfrage ist zu groß.'},413):reply({error:'Anfrage ist unvollständig.'},400);}
 let value:unknown;try{value=JSON.parse(body.toString('utf8'));}catch{return reply({error:'Ungültige Aufnahme.'},400);}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||typeof (value as Record<string,unknown>).recordingId!=='string')return reply({error:'Ungültige Aufnahme.'},400);
 const database=db();
 try{
  const result=ensureLanCaptureProject(database,(value as {recordingId:string}).recordingId,()=>{if(!sessionAuthorized(database,credential))throw new LanCaptureProjectError('unauthorized');});
  return reply(result,result.created?201:200);
 }catch(error){
  if(error instanceof LanCaptureProjectError){
   const status=error.code==='unauthorized'?401:error.code==='invalid_recording'?400:error.code==='project_deleted'||error.code==='camera_claim_exists'?409:503;
   return reply({code:error.code,error:error.code==='project_deleted'?'Das Aufnahmeprojekt wurde gelöscht; das Original bleibt auf dem Smartphone.':'Das Aufnahmeprojekt konnte nicht zugeordnet werden.'},status);
  }
  return reply({error:'Das Aufnahmeprojekt konnte nicht angelegt werden. Das Original bleibt auf dem Smartphone.'},503);
 }
}
