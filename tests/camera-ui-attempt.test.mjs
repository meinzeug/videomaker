import test from 'node:test';
import assert from 'node:assert/strict';
import {beginCameraUiAttempt,cameraUiAttemptIsCurrent,cameraUiMayStop} from '../lib/camera-ui-attempt.ts';

const start={id:'start',type:'record_start',deviceId:'device',recordingId:'take'};
const stop={id:'stop',type:'record_stop',deviceId:'device',recordingId:'take'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};

test('STOP requires an observed matching active take; an unknown start is insufficient',()=>{
 assert.equal(cameraUiMayStop(undefined,stop),false);
 assert.equal(cameraUiMayStop({id:'device',phase:'idle',recordingId:null},stop),false);
 assert.equal(cameraUiMayStop({id:'device',phase:'recording',recordingId:'other'},stop),false);
 assert.equal(cameraUiMayStop({id:'other',phase:'recording',recordingId:'take'},stop),false);
 assert.equal(cameraUiMayStop({id:'device',phase:'finalizing',recordingId:'take'},stop),false);
 for(const phase of ['preparing','recording'])assert.equal(cameraUiMayStop({id:'device',phase,recordingId:'take'},stop),true);
});

test('late start success or failure cannot overwrite newer STOP state',async()=>{
 for(const startOutcome of ['success','failure']) {
  let active=null,pending=null,status=null;
  const first=deferred(),second=deferred();
  async function request(command,wire) {
   const token=beginCameraUiAttempt(active,command);assert.ok(token);active=token;pending=command.id;
   const result=await wire.promise;
   if(!cameraUiAttemptIsCurrent(active,token))return;
   status=result;if(result==='failure')pending=null;
   if(cameraUiAttemptIsCurrent(active,token))active=null;
  }
  const a=request(start,first),b=request(stop,second);
  first.resolve(startOutcome);await a;
  assert.equal(pending,'stop');assert.equal(status,null);assert.equal(active.command.id,'stop');
  second.resolve('success');await b;assert.equal(status,'success');assert.equal(pending,'stop');assert.equal(active,null);
 }
});

test('late start cannot replace finished STOP; additional simultaneous STOP cannot duplicate',async()=>{
 const first=beginCameraUiAttempt(null,start),stopping=beginCameraUiAttempt(first,stop);
 assert.ok(stopping);assert.equal(beginCameraUiAttempt(stopping,stop),null);
 assert.equal(beginCameraUiAttempt(stopping,start),null);
 assert.equal(cameraUiAttemptIsCurrent(stopping,first),false);
 assert.equal(cameraUiAttemptIsCurrent(null,first),false);
 assert.equal(cameraUiAttemptIsCurrent(null,stopping),false);
});
