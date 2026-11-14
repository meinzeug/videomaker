import {constants,linkSync,openSync,fsyncSync,closeSync,fstatSync,readSync} from 'node:fs';
import {open,rm} from 'node:fs/promises';
import path from 'node:path';

export type RecordingUploadIntent={version:1;recordingId:string;projectId:string;mime:string;sizeBytes:number;sha256:string};
export function syncDirectory(directory:string):void {
 const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
/** The final name is created atomically and existing bytes are never replaced. */
export function linkRecordingDurably(temporary:string,target:string,sync:(directory:string)=>void=syncDirectory):'created'|'exists' {
 try {linkSync(temporary,target);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return 'exists';throw error;}
 sync(path.dirname(target));
 return 'created';
}
/** Prepare only a temporary file; this does not bind an upload identity. */
export async function prepareRecordingIntent(directory:string,intent:RecordingUploadIntent,token:string,fence:()=>void):Promise<string> {
 const temporary=path.join(directory,`.verified-intent-tmp-${token}`);
 // An EEXIST file is not ours: never unlink it when exclusive creation fails.
 const file=await open(temporary,'wx',0o600);
 try {
  try {await file.writeFile(JSON.stringify(intent));fence();await file.sync();fence();} finally {await file.close();}
  return temporary;
 } catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
}
/** Bind the immutable marker synchronously while the caller holds its DB write lock. */
export function commitRecordingIntent(directory:string,intent:RecordingUploadIntent,temporary:string,fence:()=>void):boolean {
 const marker=path.join(directory,`.upload-intent-${intent.recordingId}.json`);
 fence();try {linkSync(temporary,marker);syncDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 // Do not follow symlinks or block on a FIFO, and never read an unbounded
 // marker while holding SQLite's writer lock. Only a regular file is valid.
 const fd=openSync(marker,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let raw:string;
 try {
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size>4096)return false;
  const bytes=Buffer.alloc(4097);let total=0;
  while(total<bytes.length){const count=readSync(fd,bytes,total,bytes.length-total,null);if(count===0)break;total+=count;}
  if(total>4096)return false;
  raw=bytes.subarray(0,total).toString('utf8');
 } finally {closeSync(fd);}
 fence();
 const stored=JSON.parse(raw) as Partial<RecordingUploadIntent>;
 return stored.version===intent.version&&stored.recordingId===intent.recordingId&&stored.projectId===intent.projectId&&stored.mime===intent.mime&&stored.sizeBytes===intent.sizeBytes&&stored.sha256===intent.sha256;
}
