import {NextResponse} from 'next/server';
import {createHmac} from 'node:crypto';
import type Database from 'better-sqlite3';
import {sessionAuthorized,sessionValue} from '@/lib/auth';
import {CameraRemoteError} from '@/lib/camera-remote-store';
import {cameraRemoteEnabled} from '@/lib/camera-remote-feature';
export const noStore={'Cache-Control':'private, no-store'};
export function cameraRemoteDisabled(){return !cameraRemoteEnabled(process.env.NODE_ENV,process.env.CAMERA_REMOTE_TEST_ENABLE);}
export function cameraNotFound(){return NextResponse.json({error:'Nicht gefunden.'},{status:404,headers:noStore});}
export class CameraSessionError extends Error {}
/** Read only after parsing the request; never log or persist this credential. */
export async function cameraCredential(){return sessionValue();}
/** Hold the SQLite writer lock across the final session check and operation. */
export function cameraTransaction<T>(database:Database.Database,credential:string,operation:(owner:string)=>T):T {
 return database.transaction(()=>{
  const secret=process.env.SESSION_SECRET;
  if(!secret||!sessionAuthorized(database,credential))throw new CameraSessionError();
  const owner=createHmac('sha256',secret).update('camera-session/v1\0').update(credential).digest('hex');
  return operation(owner);
 }).immediate();
}
export async function cameraJson(req:Request):Promise<unknown>{
 if(req.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'||!req.body)throw new CameraRemoteError('invalid','JSON erforderlich.');
 const length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>8192))throw new CameraRemoteError('invalid','Anfrage zu groß.');
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},10000);
 try{for(;;){const {value,done}=await reader.read();if(expired)throw new CameraRemoteError('invalid','Zeitlimit der Anfrage überschritten.');if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();throw new CameraRemoteError('invalid','Anfrage zu groß.');}chunks.push(Uint8Array.from(value));}}finally{clearTimeout(timer);reader.releaseLock();}
 try{const bytes=new Uint8Array(size);let pos=0;for(const part of chunks){bytes.set(part,pos);pos+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new CameraRemoteError('invalid','Ungültiges JSON.');}
}
export function cameraError(error:unknown){
 if(error instanceof CameraSessionError)return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 if(error instanceof CameraRemoteError)return NextResponse.json({error:error.message},{status:error.code==='invalid'?400:error.code==='project'?404:409,headers:noStore});
 console.error('Kamerasteuerung fehlgeschlagen.');return NextResponse.json({error:'Kamerasteuerung nicht verfügbar.'},{status:500,headers:noStore});
}
