import {NextResponse} from 'next/server';
import {CameraPreviewError} from '@/lib/camera-preview-store';
import {cameraPreviewEnabled} from '@/lib/camera-preview-feature';
import {protectPreviewTransaction} from '@/lib/camera-preview-transaction';
import {cameraTransaction,CameraSessionError} from '@/app/api/camera-devices/_shared';
import type Database from 'better-sqlite3';
export const noStore={'Cache-Control':'private, no-store'};
export const disabled=()=>!cameraPreviewEnabled(process.env.NODE_ENV,process.env.CAMERA_REMOTE_TEST_ENABLE,process.env.CAMERA_PREVIEW_TEST_ENABLE,process.env.NEXT_RUNTIME);
export const notFound=()=>NextResponse.json({error:'Nicht gefunden.'},{status:404,headers:noStore});
export function previewError(error:unknown){
 if(error instanceof CameraSessionError)return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 if(error instanceof CameraPreviewError)return NextResponse.json({error:error.message},{status:error.code==='invalid'?400:error.code==='notfound'?404:409,headers:noStore});
 // Never log raw errors: they could contain SDP, ICE or credentials.
 return NextResponse.json({error:'Vorschau nicht verfügbar.'},{status:500,headers:noStore});
}
/** The preview store is in memory and cannot be rolled back with SQLite.
 * On unexpected failure, discard its signaling generation. The phone must
 * still observe its lease deadline; native media does not stop synchronously. */
export function previewTransaction<T>(database:Database.Database,credential:string,operation:(owner:string)=>T):T {
 return protectPreviewTransaction(work=>cameraTransaction(database,credential,work),operation);
}
/** Strictly bounded body; no SDP, ICE or ticket is ever logged. */
export async function previewJson(req:Request):Promise<unknown>{
 if(req.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'||!req.body)throw new CameraPreviewError('invalid','JSON erforderlich.');
 const limit=96*1024,length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw new CameraPreviewError('invalid','Anfrage zu groß.');
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0,expired=false;const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},10000);
 try{for(;;){const {value,done}=await reader.read();if(expired)throw new CameraPreviewError('invalid','Zeitlimit überschritten.');if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new CameraPreviewError('invalid','Anfrage zu groß.');}chunks.push(Uint8Array.from(value));}}
 finally{clearTimeout(timer);reader.releaseLock();}
 try{const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new CameraPreviewError('invalid','Ungültiges JSON.');}
}
