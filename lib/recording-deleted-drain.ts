/** Discard only a known deleted recording's stream; never write its bytes to disk. */
export async function drainDeletedRecording(
 reader:ReadableStreamDefaultReader<Uint8Array>, length:number, maxBytes:number,
 checkLease:()=>void, checkSession:()=>boolean,
 options:{idleMs?:number;totalMs?:number;pollMs?:number}={},
):Promise<'complete'|'incomplete'|'too_large'|'unauthorized'|'timeout'> {
 const idleMs=options.idleMs??30_000,totalMs=options.totalMs??600_000,pollMs=options.pollMs??1_000;
 if(!Number.isSafeInteger(length)||length<0||!Number.isSafeInteger(maxBytes)||maxBytes<=0||
   !Number.isFinite(idleMs)||idleMs<=0||!Number.isFinite(totalMs)||totalMs<=0||!Number.isFinite(pollMs)||pollMs<=0)throw new Error('INVALID_DRAIN_LIMIT');
 const now=()=>performance.now();const end=now()+totalMs;let size=0;
 let finished=false;
 try{
  for(;;){
   checkLease();if(!checkSession())return 'unauthorized';
   let timer:ReturnType<typeof setInterval>|undefined;
   const idleEnd=now()+idleMs;
   let result:ReadableStreamReadResult<Uint8Array>;
   try{
    result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
     timer=setInterval(()=>{
      try{checkLease();if(!checkSession())throw new Error('DRAIN_UNAUTHORIZED');if(now()>=end||now()>=idleEnd)throw new Error('DRAIN_TIMEOUT');}
      catch(error){reject(error);}
     },Math.min(pollMs,idleMs,totalMs));
    })]);
   }finally{if(timer!==undefined)clearInterval(timer);}
   checkLease();if(!checkSession())return 'unauthorized';
   if(now()>=end||now()>=idleEnd)return 'timeout';
   if(result.done){finished=true;return size>0&&(!length||size===length)?'complete':'incomplete';}
   size+=result.value.byteLength;
   if(size>maxBytes||(length>0&&size>length))return 'too_large';
  }
 }catch(error){
  if(error instanceof Error&&error.message==='DRAIN_UNAUTHORIZED')return 'unauthorized';
  if(error instanceof Error&&error.message==='DRAIN_TIMEOUT')return 'timeout';
  throw error;
 }finally{if(!finished)void reader.cancel().catch(()=>{});}
}
