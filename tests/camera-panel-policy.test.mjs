import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraControlAvailability as availability,cameraControlCompletion as completion,beginCameraUiAttempt,cameraUiAttemptIsCurrent,cameraUiMayStop,cameraHttpOutcome} from '../app/camera-panel-policy.ts';
const recording={id:'camera',phase:'recording',recordingId:'take',projectId:'project',pendingStart:false,uncertain:false,lastControl:null,capability:'remote-record-v4',paused:false,cameraFront:false,cameraCanSwitch:true};
const pause={id:'pause',type:'record_pause',recordingId:'take',expectedProjectId:'project',deviceId:'camera'};
test('v4 controls are available only for matching known states',()=>{
 assert.deepEqual(availability(recording,'project',false,false),{supported:true,pause:true,resume:false,switchCamera:false});
 assert.equal(availability({...recording,paused:true},'project',false,false).resume,true);
 assert.equal(availability({...recording,phase:'idle',recordingId:null,projectId:null},'project',false,false).switchCamera,true);
 for(const variant of [{capability:null},{capability:'remote-record-v3'},{capability:'remote-record-v2'},{uncertain:true},{uncertain:undefined},{pendingStart:true},{paused:null},{projectId:'other'}]) assert.equal(availability({...recording,...variant},'project',false,false).pause,false);
 assert.equal(availability(recording,'project',true,false).pause,false);
 assert.equal(availability(recording,'project',false,true).pause,false);
 assert.equal(availability({...recording,phase:'idle',cameraFront:null},'project',false,false).switchCamera,false);
});
test('control acknowledgement must match command, device, take, project and actual state',()=>{
 const done={...recording,paused:true,lastControl:{id:'pause',type:'record_pause',recordingId:'take',result:'accepted'}};
 assert.equal(completion(done,pause),'confirmed');
 for(const variant of [{id:'other'},{recordingId:'new'},{projectId:'other'},{paused:false},{lastControl:{...done.lastControl,id:'old'}},{lastControl:{...done.lastControl,result:'queued'}}])assert.equal(completion({...done,...variant},pause),'pending');
 assert.equal(completion({...done,lastControl:{...done.lastControl,result:'rejected'}},pause),'rejected');
 assert.equal(completion({...done,lastControl:{...done.lastControl,result:'server_expired'}},pause),'pending');
 const resume={...pause,id:'resume',type:'record_resume'};
 assert.equal(completion({...recording,lastControl:{id:'resume',type:'record_resume',recordingId:'take',result:'duplicate'}},resume),'confirmed');
});
test('camera switch requires correlated receipt and actual opposite lens',()=>{
 const command={id:'switch',type:'camera_switch',recordingId:'switch',cameraFrom:false,deviceId:'camera'};
 const device={...recording,phase:'idle',recordingId:null,projectId:null,cameraFront:true,lastControl:{id:'switch',type:'camera_switch',recordingId:'switch',result:'accepted'}};
 assert.equal(completion(device,command),'confirmed');
 assert.equal(completion({...device,cameraFront:false},command),'pending');
 assert.equal(completion({...device,phase:'recording'},command),'pending');
});
test('a stop for an observed take preempts a hanging request, but not another stop',()=>{
 const start={id:'start',type:'record_start',recordingId:'take',deviceId:'camera'};
 const stop={id:'stop',type:'record_stop',recordingId:'take',deviceId:'camera'};
 const first=beginCameraUiAttempt(null,start), second=beginCameraUiAttempt(first,stop);
 assert.ok(second);assert.equal(cameraUiAttemptIsCurrent(second,first),false);assert.equal(cameraUiAttemptIsCurrent(second,second),true);
 assert.equal(beginCameraUiAttempt(second,stop),null);
 assert.equal(cameraUiMayStop(recording,stop),true);
 assert.equal(cameraUiMayStop({...recording,recordingId:'other'},stop),false);
 assert.equal(cameraUiMayStop({...recording,phase:'idle'},stop),false);
 assert.ok(beginCameraUiAttempt(beginCameraUiAttempt(null,pause),stop));
});
test('reload blocks new controls for a queued or ambiguous earlier command, but stop remains possible',()=>{
 const stop={id:'stop',type:'record_stop',recordingId:'take',deviceId:'camera'};
 for(const result of ['queued','server_expired','unknown']) {
  const camera={...recording,lastControl:{id:'previous',type:'record_pause',recordingId:'take',result}};
  assert.equal(availability(camera,'project',false,false).pause,false);
  assert.equal(cameraUiMayStop(camera,stop),true);
 }
 const staleAck={...recording,lastControl:{id:'previous',type:'record_pause',recordingId:'take',result:'accepted'}};
 assert.equal(availability(staleAck,'project',false,false).pause,false);
 assert.equal(availability({...staleAck,paused:true},'project',false,false).resume,true);
 assert.equal(availability({...recording,lastControl:undefined},'project',false,false).pause,false);
 const idle={...recording,phase:'idle',recordingId:null,projectId:null,lastControl:{id:'switch',type:'camera_switch',recordingId:'switch',result:'accepted'}};
 assert.equal(availability(idle,'project',false,false).switchCamera,false);
 assert.equal(availability({...idle,lastControl:{...idle.lastControl,cameraFrom:true}},'project',false,false).switchCamera,true);
});

test('HTTP errors including proxy 408 and 429 never prove non-delivery',()=>{
 for(const status of [400,401,403,404,408,409,429,500,503])assert.equal(cameraHttpOutcome(status>=200&&status<300),'uncertain');
 assert.equal(cameraHttpOutcome(true),'queued');
});
