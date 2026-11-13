import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCameraCommand,cameraCommandIsFresh,decideCameraCommand,cameraAck,emptyCameraJournal,advanceCameraJournal} from '../lib/camera-recording-protocol.ts';
const commandId='1d64e51f-a90a-4528-b4b1-e15957f4c7b8';
const recordingId='541ec694-0997-4f90-8959-41a34ded9537';
const projectId='7797881c-cba8-4cb8-9737-5e206fd6598b';
const otherId='ae81642a-2451-4800-bfe2-31dd48ef287f';
const start={id:commandId,type:'record_start',recordingId,projectId,remainingMs:8000};
const stop={id:commandId,type:'record_stop',recordingId,remainingMs:8000};
const retry={id:commandId,type:'upload_retry',recordingId,remainingMs:8000};
const media={sizeBytes:123456,sha256:'a'.repeat(64),durationMs:2000,hasVideo:true,hasAudio:true};
const step=(state,event)=>advanceCameraJournal(state,event);
function recording(){let j=emptyCameraJournal();j=step(j,{type:'begin',recordingId,projectId});return step(j,{type:'capture_started',recordingId});}
function finalized(){let j=recording();j=step(j,{type:'stop_accepted',recordingId});return step(j,{type:'file_finalized',recordingId,media});}

test('command schema rejects malformed IDs, payload and unsafe expiry',()=>{
 assert.deepEqual(parseCameraCommand(start),start);
 assert.deepEqual(parseCameraCommand({...stop,projectId:null}),stop);
 for(const input of [{...start,recordingId:'../x'},{...start,projectId:null},{...start,remainingMs:10001},{...stop,projectId},{...start,type:'delete'},null])assert.throws(()=>parseCameraCommand(input));
 assert.equal(cameraCommandIsFresh(start,1000,8999),true);
 assert.equal(cameraCommandIsFresh(start,1000,9000),false);
 assert.equal(cameraCommandIsFresh(start,1000,999),false);
});
test('start and stop are idempotent; IDs remain bound to their original project',()=>{
 let j=emptyCameraJournal();assert.deepEqual(decideCameraCommand(j,start),{kind:'apply',action:'start'});
 j=step(j,{type:'begin',recordingId,projectId});assert.equal(j.current.phase,'preparing');
 assert.equal(decideCameraCommand(j,start).kind,'duplicate');assert.equal(decideCameraCommand(j,stop).kind,'defer');
 assert.equal(decideCameraCommand(j,{...start,projectId:otherId}).reason,'project_mismatch');
 j=step(j,{type:'capture_started',recordingId});assert.deepEqual(decideCameraCommand(j,stop),{kind:'apply',action:'stop'});
 j=step(j,{type:'stop_accepted',recordingId});assert.equal(decideCameraCommand(j,stop).kind,'duplicate');
 assert.equal(decideCameraCommand(j,{...stop,recordingId:otherId}).kind,'reject');
});
test('UUID letter case cannot bypass idempotency or project binding',()=>{
 const upper={...start,id:commandId.toUpperCase(),recordingId:recordingId.toUpperCase(),projectId:projectId.toUpperCase()};
 assert.deepEqual(parseCameraCommand(upper),start);
 let j=step(emptyCameraJournal(),{type:'begin',recordingId:upper.recordingId,projectId:upper.projectId});
 assert.equal(j.current.recordingId,recordingId);
 assert.equal(j.current.projectId,projectId);
 assert.equal(decideCameraCommand(j,upper).kind,'duplicate');
 assert.throws(()=>step(j,{type:'begin',recordingId:upper.recordingId,projectId:upper.projectId}));
 j=step(j,{type:'capture_started',recordingId:upper.recordingId});
 assert.equal(decideCameraCommand(j,{...stop,recordingId:upper.recordingId}).kind,'apply');
 j=step(j,{type:'stop_accepted',recordingId:upper.recordingId});
 j=step(j,{type:'file_finalized',recordingId:upper.recordingId,media});
 j=step(j,{type:'upload_started',recordingId:upper.recordingId});
 j=step(j,{type:'upload_confirmed',recordingId:upper.recordingId,projectId:upper.projectId,sizeBytes:media.sizeBytes,sha256:media.sha256});
 assert.equal(j.current.phase,'saved');
 assert.throws(()=>step(j,{type:'begin',recordingId:upper.recordingId,projectId:upper.projectId}));
 assert.equal(decideCameraCommand(j,{...upper,projectId:otherId}).reason,'project_mismatch');
});
test('ACK never claims recording merely because a command was queued',()=>{
 const j=emptyCameraJournal(),decision=decideCameraCommand(j,start);
 assert.equal(cameraAck(start,decision,false,true),null);
 assert.deepEqual(cameraAck(start,decision,true,true),{commandId,result:'accepted'});
 assert.deepEqual(cameraAck(start,decision,false,false),{commandId,result:'expired'});
 assert.equal(cameraAck(stop,{kind:'defer'},true,true),null);
 assert.equal(j.current,null);
});
test('network loss does not stop recording; interrupted upload retains verified file',()=>{
 let j=recording();assert.strictEqual(step(j,{type:'network_lost'}),j);
 j=finalized();assert.equal(j.current.phase,'upload_pending');assert.deepEqual(decideCameraCommand(j,retry),{kind:'apply',action:'upload'});
 j=step(j,{type:'upload_started',recordingId});j=step(j,{type:'upload_progress',recordingId,percent:50});
 assert.throws(()=>step(j,{type:'upload_progress',recordingId,percent:49}));
 j=step(j,{type:'network_lost'});assert.equal(j.current.phase,'upload_pending');assert.deepEqual(j.current.media,media);
 j=step(j,{type:'upload_started',recordingId});assert.equal(decideCameraCommand(j,retry).kind,'duplicate');
});
test('saved requires matching identity, size and SHA-256 proof; no missing audio',()=>{
 let j=recording();j=step(j,{type:'stop_accepted',recordingId});
 assert.throws(()=>step(j,{type:'file_finalized',recordingId,media:{...media,hasAudio:false}}));
 j=step(j,{type:'file_finalized',recordingId,media});j=step(j,{type:'upload_started',recordingId});
 const receipt={type:'upload_confirmed',recordingId,projectId,sizeBytes:media.sizeBytes,sha256:media.sha256};
 assert.throws(()=>step(j,{...receipt,projectId:otherId}));assert.throws(()=>step(j,{...receipt,sizeBytes:1}));assert.throws(()=>step(j,{...receipt,sha256:'b'.repeat(64)}));
 j=step(j,receipt);assert.equal(j.current.phase,'saved');assert.equal(j.history[recordingId].result,'saved');
 assert.equal(decideCameraCommand(j,start).kind,'duplicate');assert.equal(decideCameraCommand(j,{...start,recordingId:otherId}).kind,'apply');
});
test('restart never claims an unfinalized file is saved, and only verified files may recover',()=>{
 let j=recording();j=step(j,{type:'process_restarted'});assert.equal(j.current.phase,'error');assert.equal(j.current.error,'interrupted');assert.equal(j.current.media,null);
 assert.throws(()=>step(j,{type:'recovered_file',recordingId,media:{...media,sha256:'bad'}}));
 j=step(j,{type:'recovered_file',recordingId,media});assert.equal(j.current.phase,'upload_pending');
 assert.throws(()=>step(j,{type:'dismiss_error',recordingId}));
 let interrupted=recording();interrupted=step(interrupted,{type:'process_restarted'});interrupted=step(interrupted,{type:'dismiss_error',recordingId});
 assert.equal(interrupted.current,null);assert.equal(decideCameraCommand(interrupted,start).kind,'duplicate');
});
test('a valid partial take survives camera failure but is not declared saved',()=>{
 let j=recording();j=step(j,{type:'failure',recordingId,code:'camera'});
 assert.equal(j.current.phase,'error');
 assert.throws(()=>step(j,{type:'recovered_file',recordingId,media:{...media,hasAudio:false}}));
 j=step(j,{type:'recovered_file',recordingId,media});
 assert.equal(j.current.phase,'upload_pending');assert.equal(j.history[recordingId].result,'active');
});
