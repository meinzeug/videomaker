import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {isRecordingId,MAX_RECORDING_SIZE,recordingPath,recordingsDir,type Recording} from '@/lib/recordings';
import {parseTrimRange,parseTrimProbe,isTrimComplete} from '@/lib/video-trim';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync,linkSync,statSync,unlinkSync} from 'node:fs';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {NextResponse} from 'next/server';

export const runtime='nodejs';
// One job per process; flock additionally serializes work across Node processes on this host.
declare global { var __videomakerTrimBusy: boolean | undefined; }
class MediaError extends Error { constructor(readonly kind:'busy'|'timeout'|'unavailable'|'failed'){super(kind);} }

function run(program:string,args:string[],timeout:number):Promise<string>{
 return new Promise((resolve,reject)=>{
  const child=spawn(program,args,{stdio:['ignore','pipe','pipe'],shell:false});
  let stdout='',settled=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  function finish(error?:MediaError){if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(stdout);}
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(0,16384);});
  // Drain stderr to avoid blocking without exposing paths or media metadata in logs.
  child.stderr.on('data',()=>{});
  child.on('error',()=>finish(new MediaError('unavailable')));
  child.on('close',code=>{if(timedOut)finish(new MediaError('timeout'));else if(code===75)finish(new MediaError('busy'));else if(code!==0)finish(new MediaError('failed'));else finish();});
 });
}
function locked(lock:string,program:string,args:string[],timeout:number){
 // --no-fork makes the locked process itself the child, so timeout kills it and releases the lock.
 return run('flock',['--nonblock','--no-fork','--conflict-exit-code','75',lock,program,...args],timeout);
}
function probeArgs(file:string,mime:string){
 const format=mime==='video/mp4'?'mov':'matroska';
 // Force the declared container and deny network protocols / MOV external data references.
 const input=['-v','error','-protocol_whitelist','file,pipe','-f',format];
 if(format==='mov')input.push('-enable_drefs','0','-use_absolute_path','0');
 return [...input,'-show_entries','format=duration:stream=codec_type,width,height,avg_frame_rate,duration','-of','json',file];
}
export async function POST(req:Request,{params}:{params:Promise<{id:string;recordingId:string}>}){
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 const {id,recordingId}=await params;let range;
 try{range=parseTrimRange(await req.json());}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ungültiger Schnittbereich.'},{status:400});}
 if(!isRecordingId(recordingId))return NextResponse.json({error:'Aufnahme nicht gefunden.'},{status:404});
 const database=db();const source=database.prepare('SELECT * FROM project_recordings WHERE project_id=? AND id=?').get(id,recordingId) as Recording|undefined;
 if(!source)return NextResponse.json({error:'Aufnahme nicht gefunden.'},{status:404});
 if(!['video/mp4','video/webm'].includes(source.mime))return NextResponse.json({error:'Dieses Videoformat wird nicht unterstützt.'},{status:415});
 if(globalThis.__videomakerTrimBusy)return NextResponse.json({error:'Ein Video wird bereits bearbeitet. Bitte später erneut versuchen.'},{status:429});
 globalThis.__videomakerTrimBusy=true;
 const newId=randomUUID(),directory=recordingsDir(),temporary=path.join(directory,`.edit-${randomUUID()}.mp4`),final=recordingPath(newId,'video/mp4'),lock=path.join(directory,'.edit.lock');
 let linked=false,saved=false;
 try{
  await mkdir(directory,{recursive:true,mode:0o700});
  const input=recordingPath(source.id,source.mime),initial=statSync(input);
  if(!initial.isFile()||initial.size<=0||initial.size>MAX_RECORDING_SIZE)throw new MediaError('failed');
  const sourceInfo=parseTrimProbe(await locked(lock,'ffprobe',probeArgs(input,source.mime),30000),source.mime==='video/webm');
  // MediaRecorder WebM can omit duration. Never perform an unbounded pre-scan:
  // render only the requested bounded interval and strictly verify its output below.
  if(sourceInfo.duration!==null&&range.end>sourceInfo.duration+0.05)return NextResponse.json({error:'Der Schnittbereich liegt außerhalb der Aufnahme.'},{status:400});
  const format=source.mime==='video/mp4'?'mov':'matroska';
  const inputArgs=['-protocol_whitelist','file,pipe','-f',format];
  if(format==='mov')inputArgs.push('-enable_drefs','0','-use_absolute_path','0');
  const seconds=range.end-range.start;
  await locked(lock,'ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-n','-filter_threads','1',...inputArgs,'-threads','2','-ss',range.start.toFixed(3),'-i',input,'-t',seconds.toFixed(3),'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-threads','2','-movflags','+faststart','-fs',String(MAX_RECORDING_SIZE),temporary],300000);
  const size=statSync(temporary).size;
  if(!size||size>=MAX_RECORDING_SIZE)throw new MediaError('failed');
  // Never silently save a truncated clip or drop the original audio track.
  const outputInfo=parseTrimProbe(await run('ffprobe',probeArgs(temporary,'video/mp4'),30000));
  if(!isTrimComplete(sourceInfo,outputInfo,seconds))return NextResponse.json({error:'Der Ausschnitt ist unvollständig oder liegt außerhalb der Aufnahme. Das Original bleibt erhalten.'},{status:422});
  chmodSync(temporary,0o600);
  const result=database.transaction(()=>{
   if(!database.prepare('SELECT 1 FROM projects WHERE id=?').get(id)||!database.prepare('SELECT 1 FROM project_recordings WHERE project_id=? AND id=?').get(id,recordingId))return false;
   let current;try{current=statSync(input);}catch{return false;}
   if(current.dev!==initial.dev||current.ino!==initial.ino||current.size!==initial.size||current.mtimeMs!==initial.mtimeMs)return false;
   // An atomic hard link fails if the destination already exists; never overwrite an existing file.
   linkSync(temporary,final);linked=true;
   database.prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(newId,id,new Date().toISOString(),'video/mp4',size);
   return true;
  })();
  if(!result)return NextResponse.json({error:'Skript oder Aufnahme wurde während der Bearbeitung verändert oder entfernt.'},{status:409});
  saved=true;
  return NextResponse.json({id:newId},{status:201});
 }catch(error){
  if(error instanceof MediaError&&error.kind==='busy')return NextResponse.json({error:'Ein Video wird bereits bearbeitet. Bitte später erneut versuchen.'},{status:429});
  if(error instanceof MediaError&&error.kind==='timeout')return NextResponse.json({error:'Der Schnitt hat zu lange gedauert. Bitte einen kürzeren Bereich wählen.'},{status:504});
  console.error('Video-Schnitt fehlgeschlagen:',error instanceof MediaError?error.kind:'Datei- oder Datenbankfehler');
  return NextResponse.json({error:'Video konnte nicht geschnitten werden. Bitte Format und Server-Speicher prüfen.'},{status:500});
 } finally {
  // A database commit failure must not leave an unindexed final recording.
  if(linked&&!saved)try{unlinkSync(final);}catch{}
  await rm(temporary,{force:true}).catch(()=>{});globalThis.__videomakerTrimBusy=false;
 }
}
