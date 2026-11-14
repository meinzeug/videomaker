import { authorized, sameOrigin } from '@/lib/auth';
import db from '@/lib/db';
import { isRecordingId, MAX_RECORDING_SIZE, recordingPath, recordingsDir, type Recording } from '@/lib/recordings';
import { recordingFileReceipt } from '@/lib/recording-receipt';
import {ensureRecordingIntent,linkRecordingDurably,syncDirectory} from '@/lib/recording-upload-intent';
import {acquireRecordingUpload,cleanupStaleRecordingUploads,readRecordingChunk,recordingFreeBytes,requireRecordingSpace} from '@/lib/recording-upload-guard';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,CameraUploadGateError,cameraUploadIdFor,ensureCameraClaimUploadMappings,lockAndValidateCameraUpload,releaseCameraUploadLock,recordCameraVerifiedUpload} from '@/lib/camera-project-claims';
import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{id:string}>};

export async function GET(_req:Request,{params}:Context) {
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet'},{status:401});
 const {id}=await params;
 if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return NextResponse.json({error:'Skript nicht gefunden'},{status:404});
 return NextResponse.json({recordings:db().prepare('SELECT id,created_at,mime,size FROM project_recordings WHERE project_id=? ORDER BY created_at DESC, id DESC').all(id)},{headers:{'Cache-Control':'no-store'}});
}

/** A receipt describes bytes read from the stored file, not merely the request. */
async function existingReceipt(item:Recording, projectId:string, mime:string, length:number, expectedHash:string|null, heartbeat:()=>void, cameraRecordingId:string|null) {
 if(item.project_id!==projectId||item.mime!==mime||(length>0&&item.size!==length))return NextResponse.json({error:'Aufnahme-ID bereits für andere Daten vergeben.'},{status:409});
 let receipt;
 try {receipt=await recordingFileReceipt(recordingPath(item.id,item.mime),item.size,heartbeat);}
 catch(error) {
  if(error instanceof Error&&['UPLOAD_TIMEOUT','UPLOAD_LEASE_LOST'].includes(error.message))throw error;
  return NextResponse.json({error:'Gespeicherte Aufnahme kann nicht überprüft werden.'},{status:500});
 }
 heartbeat();
 const current=db().prepare('SELECT * FROM project_recordings WHERE id=?').get(item.id) as Recording|undefined;
 if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))return NextResponse.json({error:'Skript wurde gelöscht.'},{status:404});
 if(!current||current.project_id!==item.project_id||current.mime!==item.mime||current.size!==item.size||current.created_at!==item.created_at)return NextResponse.json({error:'Aufnahme wurde während der Prüfung verändert.'},{status:409});
 if(expectedHash&&receipt.sha256!==expectedHash)return NextResponse.json({error:'Aufnahme-ID bereits für andere Daten vergeben.'},{status:409});
 // A verified upload releases a remote project claim only if the same device
 // has also reported this exact take locally finished. ACK alone is insufficient.
 const database=db();
 database.transaction(()=>{
  if((database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('camera_project_claims','camera_project_upload_receipts','camera_remote_devices')").get() as {n:number}).n!==3)return;
  const stillPresent=database.prepare('SELECT 1 FROM project_recordings WHERE id=? AND project_id=? AND mime=? AND size=? AND created_at=?').get(item.id,projectId,item.mime,item.size,item.created_at);
  if(stillPresent&&cameraRecordingId)recordCameraVerifiedUpload(database,cameraRecordingId,projectId,item.id,receipt.sha256,receipt.sizeBytes,Date.now());
 }).immediate();
 return NextResponse.json({id:item.id,projectId,...receipt},{headers:{'Cache-Control':'no-store'}});
}

export async function POST(req:Request,{params}:Context) {
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id}=await params;
 const recordingId=(req.headers.get('x-recording-id') || '').toLowerCase();
 const rawCameraRecordingId=req.headers.get('x-camera-recording-id');
 const cameraRecordingId=rawCameraRecordingId===null?null:rawCameraRecordingId.toLowerCase();
 const mime=(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
 const length=Number(req.headers.get('content-length') || 0);
 const rawHash=req.headers.get('x-content-sha256');
 const expectedHash=rawHash===null?null:rawHash.trim().toLowerCase();
 if(!isRecordingId(recordingId)||!['video/webm','video/mp4'].includes(mime)||!req.body||!Number.isSafeInteger(length)||length<0||
    (cameraRecordingId!==null&&(!isRecordingId(cameraRecordingId)||cameraUploadIdFor(cameraRecordingId,id)!==recordingId))||
    (cameraRecordingId!==null&&(expectedHash===null||length<=0))||
    (expectedHash!==null&&(!/^[0-9a-f]{64}$/.test(expectedHash)||length<=0)))
  return NextResponse.json({error:'Ungültige Aufnahme.'},{status:400});
 if(length>MAX_RECORDING_SIZE)return NextResponse.json({error:'Die Aufnahme ist größer als 1 GB.'},{status:413});
 if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return NextResponse.json({error:'Skript nicht gefunden'},{status:404});
 let lease;
 try {lease=acquireRecordingUpload(db());}
 catch {return NextResponse.json({error:'Upload-Schutz ist auf diesem Server nicht verfügbar.'},{status:503});}
 if(!lease)return NextResponse.json({error:'Zu viele Uploads laufen. Bitte später erneut versuchen.'},{status:429,headers:{'Retry-After':'10'}});
 try {
 try{
  const database=db();database.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);ensureCameraClaimUploadMappings(database);lease.check();
  lockAndValidateCameraUpload(database,lease.token,recordingId,cameraRecordingId,id,length,expectedHash,lease.check);
 }catch(error){if(error instanceof CameraUploadGateError)return NextResponse.json({code:error.gateCode,error:error.message},{status:409});console.error('Kamera-Aufnahmenachweis konnte nicht geprüft werden:',error);return NextResponse.json({error:'Aufnahmenachweis konnte nicht geprüft werden.'},{status:503});}
 const candidates=db().prepare('SELECT * FROM project_recordings WHERE id=? COLLATE NOCASE').all(recordingId) as Recording[];
 if(candidates.length>1)return NextResponse.json({error:'Mehrdeutige Aufnahme-ID.'},{status:409});
 const existing=candidates[0];
 if(existing) {
  // Consume and hash every retry: this also avoids a premature response while
  // Android is still streaming and prevents a claimed hash masking other bytes.
  if(existing.project_id!==id||existing.mime!==mime||(length>0&&existing.size!==length))return NextResponse.json({error:'Aufnahme-ID bereits für andere Daten vergeben.'},{status:409});
  try {
   const incoming=createHash('sha256');const reader=req.body.getReader();let size=0;
   for(;;){lease.check();const {value,done}=await readRecordingChunk(reader);lease.check();if(done)break;size+=value.byteLength;if(size>MAX_RECORDING_SIZE){await reader.cancel();return NextResponse.json({error:'Die Aufnahme ist größer als 1 GB.'},{status:413});}incoming.update(value);}
   if(!size||(length&&size!==length))return NextResponse.json({error:'Die Aufnahme wurde nicht vollständig übertragen.'},{status:400});
   if(size!==existing.size)return NextResponse.json({error:'Aufnahme-ID bereits für andere Daten vergeben.'},{status:409});
   const digest=incoming.digest('hex');
   if(expectedHash&&digest!==expectedHash)return NextResponse.json({error:'Prüfsumme stimmt nicht. Die Aufnahme wurde nicht übernommen.'},{status:422});
   return await existingReceipt(existing,id,mime,size,digest,lease.check,cameraRecordingId);
  } catch(error) {
   if(error instanceof Error&&['UPLOAD_TIMEOUT','UPLOAD_LEASE_LOST'].includes(error.message))return NextResponse.json({error:'Upload unterbrochen. Bitte erneut versuchen.'},{status:408});
   return NextResponse.json({error:'Die Aufnahme wurde nicht vollständig übertragen.'},{status:400});
  }
 }
 let temporary='';
 try {
  await mkdir(recordingsDir(),{recursive:true,mode:0o700});
  lease.check();
  // Persist the directory itself before acknowledging any file published inside it.
  syncDirectory(path.dirname(recordingsDir()));
  syncDirectory(path.dirname(path.dirname(recordingsDir())));
  await cleanupStaleRecordingUploads(db(),recordingsDir());
  lease.check();
  const free=await recordingFreeBytes(recordingsDir());
  lease.check();lease.reserve(length||MAX_RECORDING_SIZE,free);
  temporary=path.join(recordingsDir(),`.verified-upload-${lease.token}`);
  const file=await open(temporary,'wx',0o600);
  let size=0;const incoming=createHash('sha256');
  try {
   const reader=req.body.getReader();
   for(;;){
    lease.check();const {value,done}=await readRecordingChunk(reader);lease.check();if(done)break;
    size+=value.byteLength;if(size>MAX_RECORDING_SIZE){await reader.cancel();throw new Error('TOO_LARGE');}
    for(let offset=0;offset<value.byteLength;offset+=1024*1024){
     const part=value.subarray(offset,Math.min(value.byteLength,offset+1024*1024));
     await requireRecordingSpace(recordingsDir(),part.byteLength);lease.check();
     incoming.update(part);await file.writeFile(part);lease.check();
    }
   }
   if(!size || (length && size!==length))throw new Error('INCOMPLETE');
   if(expectedHash&&incoming.digest('hex')!==expectedHash)throw new Error('HASH_MISMATCH');
   await file.sync();lease.check();
  } finally {await file.close();}
  const incomingReceipt=await recordingFileReceipt(temporary,size,lease.check);
  if(expectedHash&&incomingReceipt.sha256!==expectedHash)throw new Error('HASH_MISMATCH');
  const target=recordingPath(recordingId,mime);
  const marker=path.join(recordingsDir(),`.upload-intent-${recordingId}.json`);
  if(existsSync(target)&&!existsSync(marker))return NextResponse.json({error:'Unbekannte vorhandene Aufnahmedatei; keine Daten wurden überschrieben.'},{status:409});
  const intent={version:1 as const,recordingId,projectId:id,mime,sizeBytes:size,sha256:incomingReceipt.sha256};
  if(!await ensureRecordingIntent(recordingsDir(),intent,lease.token,lease.check))return NextResponse.json({error:'Aufnahme-ID ist bereits an andere Daten gebunden.'},{status:409});
  lease.check();
  const createdAt=new Date().toISOString();
  const result=db().transaction(()=>{
   lease.check();
   if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return 'missing';
   const old=db().prepare('SELECT * FROM project_recordings WHERE id=? COLLATE NOCASE').all(recordingId) as Recording[];
   if(old.length)return old.length===1&&old[0].project_id===id?'exists':'conflict';
   // Never overwrite an orphaned or pre-existing file, even after a crash.
   if(linkRecordingDurably(temporary,target)==='exists')return 'recover';
   lease.check();
   db().prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(recordingId,id,createdAt,mime,size);
   return 'created';
  })();
  if(result==='missing')return NextResponse.json({error:'Skript wurde gelöscht.'},{status:404});
  if(result==='conflict')return NextResponse.json({error:'Aufnahme-ID bereits vergeben.'},{status:409});
  let created=result==='created';
  if(result==='recover'){
   // A matching durable journal and actual bytes are both required to claim an orphan.
   const orphan=await recordingFileReceipt(target,size,lease.check);
   lease.check();
   if(orphan.sha256!==incomingReceipt.sha256)return NextResponse.json({error:'Vorhandene Aufnahmedatei stimmt nicht überein.'},{status:409});
   const recovered=db().transaction(()=>{
    lease.check();
    if(!db().prepare('SELECT 1 FROM projects WHERE id=?').get(id))return 'missing';
    const old=db().prepare('SELECT * FROM project_recordings WHERE id=? COLLATE NOCASE').all(recordingId) as Recording[];
    if(old.length)return old.length===1&&old[0].project_id===id?'exists':'conflict';
    syncDirectory(recordingsDir());
    lease.check();
    db().prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(recordingId,id,createdAt,mime,size);
    return 'recovered';
   })();
   if(recovered==='missing')return NextResponse.json({error:'Skript wurde gelöscht.'},{status:404});
   if(recovered==='conflict')return NextResponse.json({error:'Aufnahme-ID bereits vergeben.'},{status:409});
   created=recovered==='recovered';
  }
  lease.check();
  const saved=db().prepare('SELECT * FROM project_recordings WHERE id=? COLLATE NOCASE').get(recordingId) as Recording|undefined;
  if(!saved)return NextResponse.json({error:'Aufnahme konnte nicht bestätigt werden.'},{status:500});
  const response=await existingReceipt(saved,id,mime,length,expectedHash ?? incomingReceipt.sha256,lease.check,cameraRecordingId);
  lease.check();
  if(response.status!==200)return response;
  const receipt=await response.json();
  lease.check();
  return NextResponse.json(receipt,{status:created?201:200,headers:{'Cache-Control':'no-store'}});
 } catch(error) {
  if(error instanceof Error && error.message==='TOO_LARGE')return NextResponse.json({error:'Die Aufnahme ist größer als 1 GB.'},{status:413});
  if(error instanceof Error && error.message==='INCOMPLETE')return NextResponse.json({error:'Die Aufnahme wurde nicht vollständig übertragen.'},{status:400});
  if(error instanceof Error && error.message==='HASH_MISMATCH')return NextResponse.json({error:'Prüfsumme stimmt nicht. Die Aufnahme wurde nicht übernommen.'},{status:422});
  if(error instanceof Error && error.message==='UPLOAD_NO_SPACE')return NextResponse.json({error:'Nicht genügend freier Speicher für diese Aufnahme.'},{status:507});
  if(error instanceof Error && ['UPLOAD_TIMEOUT','UPLOAD_LEASE_LOST'].includes(error.message))return NextResponse.json({error:'Upload unterbrochen. Bitte erneut versuchen.'},{status:408});
  console.error('Aufnahme konnte nicht gespeichert werden:',error);
  return NextResponse.json({error:'Speichern fehlgeschlagen. Bitte Speicherplatz und Verbindung prüfen und erneut versuchen.'},{status:500});
 } finally {if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
 } finally {try{releaseCameraUploadLock(db(),lease.token);}catch{/* A stale lock remains fail-closed until a safe retry. */}try{lease.release();}catch{/* A timed-out lease cannot authorize a receipt. */}}
}
