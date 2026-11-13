import {linkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {open,readFile,rm} from 'node:fs/promises';
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
/** An immutable journal permits safe recovery after a crash between link and DB commit. */
export async function ensureRecordingIntent(directory:string,intent:RecordingUploadIntent,token:string,fence:()=>void):Promise<boolean> {
 const marker=path.join(directory,`.upload-intent-${intent.recordingId}.json`);
 const temporary=path.join(directory,`.verified-intent-tmp-${token}`);
 const file=await open(temporary,'wx',0o600);
 try {await file.writeFile(JSON.stringify(intent));fence();await file.sync();fence();} finally {await file.close();}
 try {
  fence();try {linkSync(temporary,marker);syncDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const raw=await readFile(marker,'utf8');
  fence();
  if(raw.length>4096)return false;
  const stored=JSON.parse(raw) as Partial<RecordingUploadIntent>;
  return stored.version===intent.version&&stored.recordingId===intent.recordingId&&stored.projectId===intent.projectId&&stored.mime===intent.mime&&stored.sizeBytes===intent.sizeBytes&&stored.sha256===intent.sha256;
 } finally {await rm(temporary,{force:true}).catch(()=>{});}
}
