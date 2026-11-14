import type Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
import {existsSync,lstatSync} from 'node:fs';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,ensureCameraClaimUploadMappings,lockAndValidateCameraUpload,releaseCameraUploadLock} from '@/lib/camera-project-claims';
import {acquireAuthorizedLiveLease} from '@/lib/live-recording-lease';
import {commitRecordingIntent,linkRecordingDurably,prepareRecordingIntent,syncDirectory} from '@/lib/recording-upload-intent';
import {recordingFileReceipt} from '@/lib/recording-receipt';
import {parseTrimProbe} from '@/lib/video-trim';
import {LiveStagingError,type createLiveStaging} from '@/lib/live-recording-staging';

type Store=ReturnType<typeof createLiveStaging>;
type Item={id:string;project_id:string;created_at:string;mime:string;size:number};
const fail=(code:string):never=>{throw new LiveStagingError(code);};

/** Probe only the sealed local MP4; never permit network protocols or external MOV references. */
function probe(filename:string,lock:string):Promise<void>{
 return new Promise((resolve,reject)=>{
  const child=spawn('flock',['--nonblock','--no-fork','--conflict-exit-code','75',lock,'ffprobe','-v','error','-protocol_whitelist','file,pipe','-f','mov','-enable_drefs','0','-use_absolute_path','0','-show_entries','format=duration:stream=codec_type,width,height,avg_frame_rate,duration','-of','json',filename],{stdio:['ignore','pipe','pipe'],shell:false});
  let output='',failed=false,settled=false;const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},30000);
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>16384){failed=true;child.kill('SIGKILL');}});
  child.stderr.on('data',()=>{});child.on('error',()=>finish(new LiveStagingError('PROBE_UNAVAILABLE')));
  child.on('close',code=>{if(failed||code!==0)return finish(new LiveStagingError(code===75?'PROBE_BUSY':'INVALID_MP4'));try{parseTrimProbe(output);finish();}catch{finish(new LiveStagingError('INVALID_MP4'));}});
 });
}

/** Reuses the existing durable recording intent and upload lock; never overwrites a target. */
export async function publishLiveRecording(options:{database:Database.Database;store:Store;root:string;id:string;project:string;recording:string;size:number;sha256:string;authorize:()=>void}){
 const {database,store,root,id,project,recording,size,sha256,authorize}=options;
 const directory=path.join(root,'recordings'),target=path.join(directory,`${id}.mp4`),marker=path.join(directory,`.upload-intent-${id}.json`);
 const lease=acquireAuthorizedLiveLease(database,authorize);if(!lease)return fail('CAPACITY');
 let temporary='';
 try{
  await mkdir(directory,{recursive:true,mode:0o700});syncDirectory(path.dirname(directory));
  database.transaction(()=>{
   authorize();lease.check();database.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);ensureCameraClaimUploadMappings(database);
   lockAndValidateCameraUpload(database,lease.token,id,null,project,size,sha256,lease.check);
  }).immediate();
  const existing=database.prepare('SELECT * FROM project_recordings WHERE id=? COLLATE NOCASE').all(id) as Item[];
  if(existing.length>1)fail('BINDING_CONFLICT');
  if(existing.length){
   const item=existing[0];if(item.project_id!==project||item.mime!=='video/mp4'||item.size!==size)fail('BINDING_CONFLICT');
   const receipt=await recordingFileReceipt(target,size,lease.check);if(receipt.sha256!==sha256)fail('FINAL_CONFLICT');
   database.transaction(()=>{authorize();const current=database.prepare('SELECT * FROM project_recordings WHERE id=?').get(id) as Item|undefined;if(!current||current.project_id!==project||current.size!==size||current.created_at!==item.created_at)fail('BINDING_CONFLICT');}).immediate();
   store.markPublished(id,project,recording);
   return {id,projectId:project,...receipt};
  }
  const staged=store.sealedPath(id,project,recording);if(staged.sizeBytes!==size||staged.sha256!==sha256)fail('FINAL_CONFLICT');
  const original=await recordingFileReceipt(staged.path,size,lease.check);if(original.sha256!==sha256)fail('STAGE_CHANGED');
  await probe(staged.path,path.join(directory,'.live-recording-probe.lock'));lease.check();
  const after=await recordingFileReceipt(staged.path,size,lease.check);if(after.sha256!==sha256)fail('STAGE_CHANGED');
  let prior:{dev:number;ino:number;size:number;mtimeMs:number}|null=null;
  if(existsSync(target)){
   if(!existsSync(marker))fail('PUBLISH_UNCERTAIN');
   const receipt=await recordingFileReceipt(target,size,lease.check);if(receipt.sha256!==sha256)fail('PUBLISH_UNCERTAIN');
   prior=lstatSync(target);
  }
  const intent={version:1 as const,recordingId:id,projectId:project,mime:'video/mp4',sizeBytes:size,sha256};
  temporary=await prepareRecordingIntent(directory,intent,lease.token,lease.check);
  const outcome=database.transaction(()=>{
   lease.check();authorize();const current=store.sealedPath(id,project,recording);
   if(current.path!==staged.path||current.dev!==staged.dev||current.ino!==staged.ino||current.sizeBytes!==size||current.sha256!==sha256)fail('STAGE_CHANGED');
   if(database.prepare('SELECT 1 FROM project_recordings WHERE id=? COLLATE NOCASE').get(id))return 'retry';
   if(existsSync(target)){
    if(!prior||!existsSync(marker))return 'retry';
    const currentTarget=lstatSync(target);if(!currentTarget.isFile()||currentTarget.dev!==prior.dev||currentTarget.ino!==prior.ino||currentTarget.size!==prior.size||currentTarget.mtimeMs!==prior.mtimeMs)fail('PUBLISH_UNCERTAIN');
   }
   if(!commitRecordingIntent(directory,intent,temporary,lease.check))fail('PUBLISH_UNCERTAIN');
   if(linkRecordingDurably(staged.path,target)==='exists'&&!prior)return 'retry';
   // Matching orphan bytes are accepted only when they are the same staged inode.
   const final=lstatSync(target);if(!final.isFile()||String(final.dev)!==staged.dev||String(final.ino)!==staged.ino||final.size!==size)fail('PUBLISH_UNCERTAIN');
   syncDirectory(directory);lease.check();
   database.prepare('INSERT INTO project_recordings(id,project_id,created_at,mime,size) VALUES(?,?,?,?,?)').run(id,project,new Date().toISOString(),'video/mp4',size);
   return 'created';
  }).immediate();
  if(outcome==='retry')fail('RETRY');
  const receipt=await recordingFileReceipt(target,size,lease.check);if(receipt.sha256!==sha256)fail('STAGE_CHANGED');
  database.transaction(()=>authorize()).immediate();store.markPublished(id,project,recording);
  return {id,projectId:project,...receipt};
 }finally{
  if(temporary)await rm(temporary,{force:true}).catch(()=>{});
  try{releaseCameraUploadLock(database,lease.token);}catch{/* Keep an uncertain lock closed. */}
  try{lease.release();}catch{/* A timed-out lease cannot authorize a receipt. */}
 }
}
