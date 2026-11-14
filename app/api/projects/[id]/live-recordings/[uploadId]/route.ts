import {authorized,sameOrigin,sessionAuthorized,sessionValue} from '@/lib/auth';
import db from '@/lib/db';
import {cameraUploadIdFor} from '@/lib/camera-project-claims';
import {acquireRecordingUpload} from '@/lib/recording-upload-guard';
import {acquireAuthorizedLiveLease} from '@/lib/live-recording-lease';
import {LiveBodyError,readLiveRecordingBody} from '@/lib/live-recording-body';
import {createLiveStaging,LIVE_CHUNK_BYTES,LiveStagingError} from '@/lib/live-recording-staging';
import {publishLiveRecording} from '@/lib/live-recording-publish';
import {getLiveRecordingReceipt} from '@/lib/live-recording-receipt';
import {isRecordingId} from '@/lib/recordings';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{id:string;uploadId:string}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
// The experimental API is deliberately unreachable on production, regardless of flags.
const enabled=()=>process.env.NODE_ENV!=='production'&&process.env.LIVE_RECORDING_UPLOAD_TEST_ENABLE==='1';
const response=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
const number=(raw:string|null)=>raw!==null&&/^(?:0|[1-9]\d{0,15})$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):null;
const codes:Record<string,number>={INVALID_ID:400,INVALID_PAGE:400,INVALID_CHUNK:400,INVALID_FINAL:400,NOT_FOUND:404,RECEIPT_MISSING:404,UNAUTHORIZED:401,PROJECT_MISSING:404,BINDING_CONFLICT:409,WEB_CLAIM:409,REVISION_CONFLICT:409,NONCONTIGUOUS:409,NOT_OPEN:409,NOT_SEALED:409,PUBLISHED:409,PUBLISH_UNCERTAIN:409,FINAL_CONFLICT:409,INCOMPLETE:409,FINAL_MISMATCH:422,STAGE_CHANGED:409,RETRY:409,INVALID_MP4:422,PROBE_BUSY:429,PROBE_UNAVAILABLE:503,CAPACITY:429,NO_SPACE:507};
const error=(e:unknown)=>e instanceof LiveBodyError?response({error:'Aufnahmeteil konnte nicht vollständig empfangen werden.'},e.code==='TOO_LARGE'?413:e.code==='TIMEOUT'?408:400):e instanceof LiveStagingError?response({code:e.code,error:'Aufnahme konnte nicht fortgesetzt werden. Das Original bleibt auf dem Smartphone.'},codes[e.code]??503):response({error:'Upload vorübergehend nicht verfügbar. Das Original bleibt auf dem Smartphone.'},503);
async function setup(req:Request,context:Context,mutate:boolean,allowMissingProject=false){
 if(!enabled())return {failure:response({error:'Nicht gefunden.'},404)} as const;
 if(!await authorized())return {failure:response({error:'Nicht angemeldet.'},401)} as const;
 if(mutate&&!await sameOrigin(req))return {failure:response({error:'Nicht erlaubt.'},403)} as const;
 const credential=await sessionValue(),params=await context.params,project=params.id.toLowerCase(),upload=params.uploadId.toLowerCase();
 const recording=(req.headers.get('x-recording-id')||'').toLowerCase();
 if(!isRecordingId(project)||!isRecordingId(upload)||!isRecordingId(recording)||cameraUploadIdFor(recording,project)!==upload||req.headers.get('x-live-origin')!=='lan'||req.headers.has('x-camera-recording-id'))return {failure:response({error:'Ungültige Aufnahmebindung.'},400)} as const;
 const database=db();
 const assertAuthorized=()=>{
  if(!sessionAuthorized(database,credential))throw new LiveStagingError('UNAUTHORIZED');
  if(!allowMissingProject&&!database.prepare('SELECT 1 FROM projects WHERE id=?').get(project))throw new LiveStagingError('PROJECT_MISSING');
 };
 assertAuthorized();
 return {database,project,upload,recording,assertAuthorized,store:createLiveStaging(database,process.env.DATA_DIR||'./data',undefined,assertAuthorized)} as const;
}

export async function GET(req:Request,context:Context){
 try{
  const input=await setup(req,context,false,true);if(input.failure)return input.failure;
  const query=new URL(req.url).searchParams,receiptValues=query.getAll('receipt');
  if(receiptValues.length){
   if(receiptValues.length!==1||receiptValues[0]!=='1'||query.has('after')||query.has('limit'))return response({error:'Ungültiger Belegabruf.'},400);
   return response(await getLiveRecordingReceipt({database:input.database,root:process.env.DATA_DIR||'./data',id:input.upload,project:input.project,recording:input.recording,authorize:input.assertAuthorized}));
  }
  const afterValues=query.getAll('after'),limitValues=query.getAll('limit');
  if(afterValues.length>1||limitValues.length>1)return response({error:'Ungültige Seitenauswahl.'},400);
  const after=afterValues.length?number(afterValues[0]): -1,limit=limitValues.length?number(limitValues[0]):16;
  if(after===null||limit===null)return response({error:'Ungültige Seitenauswahl.'},400);
  return response(input.store.status(input.upload,input.project,input.recording,after,limit));
 }catch(e){return error(e);}
}

export async function POST(req:Request,context:Context){
 try{
  const operation=req.headers.get('x-live-operation');
  const input=await setup(req,context,true,operation==='cancel');if(input.failure)return input.failure;
  if(operation==='begin'){
   const stage=input.store.begin(input.upload,input.project,input.recording);
   return response({state:stage.state,chunkBytes:LIVE_CHUNK_BYTES});
  }
  if(operation==='cancel'){input.store.cancel(input.upload,input.project,input.recording);return response({cancelled:true});}
  if(operation==='seal'){
   if(req.headers.get('x-live-finalized')!=='1')return response({error:'Die Aufnahme muss zuerst auf dem Smartphone abgeschlossen werden.'},400);
   const size=number(req.headers.get('x-live-final-size')),sha=req.headers.get('x-live-final-sha256')||'';
   if(size===null)return response({error:'Ungültige Aufnahmegröße.'},400);
   return response({...input.store.seal(input.upload,input.project,input.recording,size,sha),state:'sealed',published:false});
  }
  if(operation==='commit'){
   if(req.headers.get('x-live-finalized')!=='1')return response({error:'Die Aufnahme muss zuerst auf dem Smartphone abgeschlossen werden.'},400);
   const size=number(req.headers.get('x-live-final-size')),sha=req.headers.get('x-live-final-sha256')||'';
   if(size===null||size<=0||!/^[a-f0-9]{64}$/.test(sha))return response({error:'Ungültiger Aufnahmebeleg.'},400);
   const result=await publishLiveRecording({database:input.database,store:input.store,root:process.env.DATA_DIR||'./data',id:input.upload,project:input.project,recording:input.recording,size,sha256:sha,authorize:input.assertAuthorized});
   return response({...result,published:true});
  }
  return response({error:'Ungültiger Vorgang.'},400);
 }catch(e){return error(e);}
}

export async function PUT(req:Request,context:Context){
 let lease:ReturnType<typeof acquireRecordingUpload>=null;
 try{
  const input=await setup(req,context,true);if(input.failure)return input.failure;
  const part=number(req.headers.get('x-live-part')),revision=number(req.headers.get('x-live-revision'));
  const length=number(req.headers.get('content-length')),sha=req.headers.get('x-live-sha256')||'';
  if(part===null||revision===null||length===null||length<1||length>LIVE_CHUNK_BYTES||!req.body)return response({error:'Ungültiger Aufnahmeteil.'},400);
  lease=acquireAuthorizedLiveLease(input.database,input.assertAuthorized);if(!lease)return response({error:'Zu viele Uploads laufen. Bitte später erneut versuchen.'},429);
  const reader=req.body.getReader();let bytes:Buffer;
  try{bytes=await readLiveRecordingBody(reader,length,lease.check);}finally{reader.releaseLock();}
  return response(input.store.put(input.upload,input.project,input.recording,part,revision,bytes,sha));
 }catch(e){return error(e);}finally{try{lease?.release();}catch{/* A failed release stays fenced until the lease expires. */}}
}
