import {readRecordingChunk,RECORDING_READ_TIMEOUT_MS} from './recording-upload-guard.ts';

const TOTAL_BODY_MS=120_000;
export class LiveBodyError extends Error {
 readonly code:'TOO_LARGE'|'INCOMPLETE'|'TIMEOUT';
 constructor(code:'TOO_LARGE'|'INCOMPLETE'|'TIMEOUT'){super(code);this.code=code;}
}

/** A monotonic deadline bounds the entire body, even when bytes arrive slowly. */
export async function readLiveRecordingBody(reader:ReadableStreamDefaultReader<Uint8Array>,length:number,check:()=>void,now:()=>number=()=>performance.now(),totalMs=TOTAL_BODY_MS):Promise<Buffer>{
 const start=now(),bytes=Buffer.alloc(length);let total=0;
 for(;;){
  check();const elapsed=now()-start,remaining=totalMs-elapsed;
  if(!Number.isFinite(remaining)||remaining<=0||elapsed<0){void reader.cancel().catch(()=>{});throw new LiveBodyError('TIMEOUT');}
  let result:ReadableStreamReadResult<Uint8Array>;
  try{result=await readRecordingChunk(reader,Math.min(RECORDING_READ_TIMEOUT_MS,remaining));}
  catch(error){if(error instanceof Error&&error.message==='UPLOAD_TIMEOUT')throw new LiveBodyError('TIMEOUT');throw error;}
  check();
  if(now()-start>=totalMs){void reader.cancel().catch(()=>{});throw new LiveBodyError('TIMEOUT');}
  if(result.done)break;
  if(result.value.byteLength>length-total){void reader.cancel().catch(()=>{});throw new LiveBodyError('TOO_LARGE');}
  bytes.set(result.value,total);total+=result.value.byteLength;
 }
 if(total!==length)throw new LiveBodyError('INCOMPLETE');
 return bytes;
}
