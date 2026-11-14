import {readRecordingChunk} from './recording-upload-guard.ts';

export class BoundedBodyError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}

/** Bound both total bytes and total elapsed time; never await an untrusted cancel promise. */
export async function readBoundedRequestBody(stream:ReadableStream<Uint8Array>,maxBytes=1024,timeoutMs=10000):Promise<Buffer> {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new BoundedBodyError('INVALID_LIMIT');
 const reader=stream.getReader(),deadline=performance.now()+timeoutMs;let body=Buffer.alloc(0);
 try{
  for(;;){
   const remaining=deadline-performance.now();if(remaining<=0)throw new BoundedBodyError('TIMEOUT');
   const {done,value}=await readRecordingChunk(reader,remaining);if(done)break;
   if(value.byteLength>maxBytes-body.length)throw new BoundedBodyError('TOO_LARGE');
   body=Buffer.concat([body,Buffer.from(value)]);
  }
  return body;
 }catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{try{reader.releaseLock();}catch{/* A pending cancellation need not settle. */}}
}
