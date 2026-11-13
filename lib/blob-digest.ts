import {sha256} from '@noble/hashes/sha2.js';

/** Bounded-memory digest of a browser recording; never duplicates the full blob. */
export async function sha256Blob(blob:Blob, shouldStop:()=>boolean=()=>false):Promise<string> {
 const hash=sha256.create();const chunkSize=1024*1024;
 for(let offset=0;offset<blob.size;offset+=chunkSize){
  if(shouldStop())throw new Error('Aufnahmeprüfung abgebrochen.');
  hash.update(new Uint8Array(await blob.slice(offset,offset+chunkSize).arrayBuffer()));
 }
 if(shouldStop())throw new Error('Aufnahmeprüfung abgebrochen.');
 return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function recordingReceiptMatches(value:unknown, expected:{id:string;projectId:string;sizeBytes:number;sha256:string}):boolean {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const receipt=value as Record<string,unknown>;
 return receipt.id===expected.id&&receipt.projectId===expected.projectId&&receipt.sizeBytes===expected.sizeBytes&&receipt.sha256===expected.sha256;
}
