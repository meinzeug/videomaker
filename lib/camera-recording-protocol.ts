/**
 * Proposed camera recording protocol. This module is deliberately NOT wired to
 * the live device API: native capture, persistence, receipt verification and
 * end-to-end testing must exist before it can be advertised or enabled.
 *
 * The native owner must persist the journal, its recording-ID history and each
 * command decision atomically. A queue ACK only confirms a committed command
 * decision; it never proves camera, microphone, muxer or upload success.
 */
export const CAMERA_COMMAND_TTL_MS=10_000;
export const MAX_CAMERA_MEDIA_BYTES=1024*1024*1024;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export type CameraCommand =
 | {id:string;type:'record_start';recordingId:string;projectId:string;remainingMs:number}
 | {id:string;type:'record_stop'|'upload_retry';recordingId:string;remainingMs:number};
export type MediaManifest={sizeBytes:number;sha256:string;durationMs:number;hasVideo:true;hasAudio:true};
export type CameraError='permission'|'camera'|'audio'|'storage'|'encoder'|'upload'|'interrupted';
export type CameraPhase='preparing'|'recording'|'finalizing'|'upload_pending'|'uploading'|'saved'|'error';
export type CameraTake={recordingId:string;projectId:string;phase:CameraPhase;media:MediaManifest|null;uploadPercent:number|null;error:CameraError|null};
export type CameraJournal={current:CameraTake|null;history:Record<string,{projectId:string;result:'active'|'failed'|'saved'}>};
export type CameraDecision={kind:'apply';action:'start'|'stop'|'upload'}|{kind:'duplicate'}|{kind:'defer'}|{kind:'reject';reason:'busy'|'recording_mismatch'|'project_mismatch'|'invalid_state'};
export type CameraAck={commandId:string;result:'accepted'|'duplicate'|'rejected'|'expired';reason?:string};
export type CameraEvent =
 | {type:'begin';recordingId:string;projectId:string}
 | {type:'capture_started';recordingId:string}
 | {type:'stop_accepted';recordingId:string}
 | {type:'file_finalized';recordingId:string;media:MediaManifest}
 | {type:'upload_started';recordingId:string}
 | {type:'upload_progress';recordingId:string;percent:number}
 | {type:'upload_confirmed';recordingId:string;projectId:string;sizeBytes:number;sha256:string}
 | {type:'failure';recordingId:string;code:CameraError}
 | {type:'network_lost'}
 | {type:'process_restarted'}
 | {type:'recovered_file';recordingId:string;media:MediaManifest}
 | {type:'dismiss_error';recordingId:string};

export function parseCameraCommand(input:unknown):CameraCommand {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Ungültiger Kamerabefehl.');
 const item=input as Record<string,unknown>;
 if(!uuid(item.id)||!uuid(item.recordingId)||!Number.isSafeInteger(item.remainingMs)||Number(item.remainingMs)<0||Number(item.remainingMs)>CAMERA_COMMAND_TTL_MS)throw new Error('Ungültiger Kamerabefehl.');
 if(item.type==='record_start'){
  if(!uuid(item.projectId))throw new Error('Ungültiges Projekt.');
  return {id:item.id,type:'record_start',recordingId:item.recordingId,projectId:item.projectId,remainingMs:Number(item.remainingMs)};
 }
 if((item.type==='record_stop'||item.type==='upload_retry')&&(item.projectId===undefined||item.projectId===null))return {id:item.id,type:item.type,recordingId:item.recordingId,remainingMs:Number(item.remainingMs)};
 throw new Error('Unbekannter Kamerabefehl.');
}
/** remainingMs is measured on the server when responding. Subtracting the full
 * client request duration conservatively avoids device/server wall-clock drift. */
export function cameraCommandIsFresh(command:CameraCommand,requestStartedMs:number,nowMs:number):boolean {
 return Number.isSafeInteger(requestStartedMs)&&Number.isSafeInteger(nowMs)&&requestStartedMs>=0&&nowMs>=requestStartedMs&&nowMs-requestStartedMs<command.remainingMs;
}
export function decideCameraCommand(journal:CameraJournal,command:CameraCommand):CameraDecision {
 const current=journal.current;
 if(command.type==='record_start'){
  const old=journal.history[command.recordingId];
  if(old)return old.projectId===command.projectId?{kind:'duplicate'}:{kind:'reject',reason:'project_mismatch'};
  if(current&&current.phase!=='saved')return {kind:'reject',reason:'busy'};
  return {kind:'apply',action:'start'};
 }
 if(!current||current.recordingId!==command.recordingId)return {kind:'reject',reason:'recording_mismatch'};
 if(command.type==='record_stop'){
  if(current.phase==='recording')return {kind:'apply',action:'stop'};
  if(current.phase==='preparing')return {kind:'defer'};
  if(['finalizing','upload_pending','uploading','saved'].includes(current.phase))return {kind:'duplicate'};
  return {kind:'reject',reason:'invalid_state'};
 }
 if(current.phase==='upload_pending'||(current.phase==='error'&&current.media!==null))return {kind:'apply',action:'upload'};
 if(current.phase==='uploading'||current.phase==='saved')return {kind:'duplicate'};
 return {kind:'reject',reason:'invalid_state'};
}
/** A committed decision acknowledges acceptance, never recording success. */
export function cameraAck(command:CameraCommand,decision:CameraDecision,committed:boolean,fresh:boolean):CameraAck|null {
 if(!fresh)return {commandId:command.id,result:'expired'};
 if(decision.kind==='defer')return null;
 if(decision.kind==='apply')return committed?{commandId:command.id,result:'accepted'}:null;
 if(decision.kind==='duplicate')return {commandId:command.id,result:'duplicate'};
 return {commandId:command.id,result:'rejected',reason:decision.reason};
}
function verifiedMedia(media:MediaManifest):MediaManifest {
 if(!media||!Number.isSafeInteger(media.sizeBytes)||media.sizeBytes<=0||media.sizeBytes>MAX_CAMERA_MEDIA_BYTES||!digest(media.sha256)||!Number.isSafeInteger(media.durationMs)||media.durationMs<=0||media.hasVideo!==true||media.hasAudio!==true)throw new Error('Aufnahme ist nicht vollständig geprüft.');
 return {...media};
}
const validError=(code:unknown):code is CameraError=>['permission','camera','audio','storage','encoder','upload','interrupted'].includes(String(code));
export function emptyCameraJournal():CameraJournal{return {current:null,history:{}};}
/** Caller persists each transition before emitting an acknowledgement. */
export function advanceCameraJournal(journal:CameraJournal,event:CameraEvent):CameraJournal {
 const current=journal.current;
 if(event.type==='begin'){
  if(!uuid(event.recordingId)||!uuid(event.projectId)||journal.history[event.recordingId]||(current&&current.phase!=='saved'))throw new Error('Aufnahme kann nicht begonnen werden.');
  return {current:{recordingId:event.recordingId,projectId:event.projectId,phase:'preparing',media:null,uploadPercent:null,error:null},history:{...journal.history,[event.recordingId]:{projectId:event.projectId,result:'active'}}};
 }
 if(event.type==='network_lost'){
  if(current?.phase==='uploading')return {...journal,current:{...current,phase:'upload_pending',uploadPercent:null}};
  return journal; // Recording is deliberately not tied to network availability.
 }
 if(event.type==='process_restarted'){
  if(!current||current.phase==='saved'||current.phase==='error')return journal;
  if(current.media)return {...journal,current:{...current,phase:'upload_pending',uploadPercent:null,error:null}};
  return {...journal,current:{...current,phase:'error',uploadPercent:null,error:'interrupted'},history:{...journal.history,[current.recordingId]:{projectId:current.projectId,result:'failed'}}};
 }
 if(!current||current.recordingId!==event.recordingId)throw new Error('Aufnahme stimmt nicht überein.');
 const withCurrent=(next:CameraTake):CameraJournal=>({...journal,current:next});
 switch(event.type){
  case 'capture_started':
   if(current.phase!=='preparing')break;
   return withCurrent({...current,phase:'recording'});
  case 'stop_accepted':
   if(current.phase!=='recording')break;
   return withCurrent({...current,phase:'finalizing'});
  case 'file_finalized':
   if(current.phase!=='finalizing')break;
   return withCurrent({...current,phase:'upload_pending',media:verifiedMedia(event.media),uploadPercent:null,error:null});
  case 'upload_started':
   if(!current.media||!(current.phase==='upload_pending'||current.phase==='error'))break;
   return withCurrent({...current,phase:'uploading',uploadPercent:0,error:null});
  case 'upload_progress':
   if(current.phase!=='uploading'||!Number.isInteger(event.percent)||event.percent<0||event.percent>99||event.percent<(current.uploadPercent??0))break;
   return withCurrent({...current,uploadPercent:event.percent});
  case 'upload_confirmed':
   if(current.phase!=='uploading'||!current.media||event.projectId!==current.projectId||event.sizeBytes!==current.media.sizeBytes||event.sha256!==current.media.sha256)break;
   return {...journal,current:{...current,phase:'saved',uploadPercent:100,error:null},history:{...journal.history,[current.recordingId]:{projectId:current.projectId,result:'saved'}}};
  case 'failure':
   if(current.phase==='saved'||!validError(event.code))break;
   return {...journal,current:{...current,phase:'error',uploadPercent:null,error:event.code},history:{...journal.history,[current.recordingId]:{projectId:current.projectId,result:'failed'}}};
  case 'recovered_file':
   // Camera/audio/encoder failure can still leave a valid finalized partial take.
   if(current.phase!=='error'||current.media)break;
   return {...journal,current:{...current,phase:'upload_pending',media:verifiedMedia(event.media),uploadPercent:null,error:null},history:{...journal.history,[current.recordingId]:{projectId:current.projectId,result:'active'}}};
  case 'dismiss_error':
   if(current.phase!=='error'||current.media)break;
   return {...journal,current:null};
 }
 throw new Error('Ungültiger Aufnahmezustand.');
}
