import path from 'node:path';

export const MAX_RECORDING_SIZE=1024*1024*1024;
export const isRecordingId=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const recordingsDir=()=>path.join(process.env.DATA_DIR || './data','recordings');
export const recordingPath=(id:string,mime:string)=>path.join(recordingsDir(),`${id}.${mime==='video/mp4'?'mp4':'webm'}`);
export type Recording={id:string;project_id:string;created_at:string;mime:string;size:number};
export function parseRange(range:string,size:number):{start:number;end:number}|null {
 const match=/^bytes=(\d*)-(\d*)$/.exec(range);
 if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(size)||size<=0)return null;
 let start=0,end=size-1;
 if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);}
 else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}
 return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end&&start<size?{start,end}:null;
}
