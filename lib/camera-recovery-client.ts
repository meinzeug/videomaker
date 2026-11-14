import {sha256} from '@noble/hashes/sha2.js';
import {recordingReceiptMatches,sha256Blob} from './blob-digest.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Proof={sizeBytes:number;sha256:string};

/** Same stable upload identity as the Android app and the server. */
export function cameraRecoveryUploadId(recordingId:string,projectId:string):string{
 if(!uuid.test(recordingId)||!uuid.test(projectId))throw new Error('Ungültige Aufnahmezuordnung.');
 const bytes=sha256(new TextEncoder().encode(`kontraprompter-upload-v1\0${recordingId}\0${projectId}`)).slice(0,16);
 bytes[6]=(bytes[6]&15)|0x80;bytes[8]=(bytes[8]&63)|0x80;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Upload only an exact copy of a previously authenticated READY manifest. */
export async function uploadCameraRecovery(file:Blob,projectId:string,recordingId:string,proof:Proof,signal:AbortSignal,request:typeof fetch=fetch){
 const uploadId=cameraRecoveryUploadId(recordingId,projectId);
 if(!Number.isSafeInteger(proof.sizeBytes)||proof.sizeBytes<=0||proof.sizeBytes>1024*1024*1024||!/^[0-9a-f]{64}$/.test(proof.sha256))throw new Error('Der Gerätenachweis ist ungültig.');
 if(file.size!==proof.sizeBytes)throw new Error('Die Dateigröße stimmt nicht mit dem Gerätenachweis überein.');
 const digest=await sha256Blob(file,()=>signal.aborted);
 if(digest!==proof.sha256)throw new Error('Die Datei stimmt nicht mit der Aufnahme des Smartphones überein.');
 if(signal.aborted)throw new Error('Die Wiederherstellung wurde abgebrochen.');
 const response=await request(`/api/projects/${encodeURIComponent(projectId)}/recordings`,{
  method:'POST',headers:{'Content-Type':'video/mp4','X-Recording-Id':uploadId,'X-Camera-Recording-Id':recordingId,'X-Content-SHA256':digest},body:file,signal,
 });
 if(!response.ok)throw new Error('Der Upload wurde nicht bestätigt. Bitte prüfe die Verbindung und versuche es erneut.');
 const receipt:unknown=await response.json();
 if(!recordingReceiptMatches(receipt,{id:uploadId,projectId,sizeBytes:file.size,sha256:digest}))throw new Error('Der Serverbeleg stimmt nicht überein. Der Upload ist nicht bestätigt.');
 return {uploadId,projectId,sizeBytes:file.size,sha256:digest};
}
