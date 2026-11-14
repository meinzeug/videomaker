import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {homedir} from 'node:os';
const base=process.env.CAMERA_V2_HTTP_SERVER;
const enabled=base==='http://127.0.0.1:3392'&&process.env.CAMERA_V2_HTTP_ALLOW_WRITES==='1';
const headers={origin:base,'content-type':'application/json'};
const post=(path,cookie,body,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...(cookie?{cookie}:{}),...extra},body:JSON.stringify(body)});
async function login(){const r=await post('/api/login','',{password:'camera-v2-local-test'});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
test('isolated paired camera v2 HTTP controls and telemetry',{skip:!enabled,timeout:120000},async()=>{
 const root=realpathSync(process.env.CAMERA_V2_HTTP_FIXTURE||'');assert.equal(dirname(root),realpathSync(homedir()));assert.match(basename(root),/^\.videomaker-camera-v2-http\.[a-zA-Z0-9]+$/);assert.equal(readFileSync(join(root,'.fixture'),'utf8'),'isolated-camera-v2-http\n');
 const browser=await login(),phone=await login(),id=randomUUID(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=keys.publicKey.export({format:'der',type:'spki'});
 async function pair(action){
  let r=await post('/api/camera-devices/pairing/challenge',phone,{deviceId:id,action});assert.equal(r.status,200);const c=await r.json();
  const payload=action==='register'?spki:Buffer.alloc(0),hash=createHash('sha256').update(payload).digest('hex');
  const message=`videomaker-camera-device-auth/v2\n${id}\n${c.challengeId}\n${c.challenge}\n${action}\n${hash}\n`;
  r=await post('/api/camera-devices/pairing/complete',phone,{deviceId:id,action,challengeId:c.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),keys.privateKey).toString('base64url')});assert.equal(r.status,200);return r.json();
 }
 await pair('register');const {ticket}=await pair('session');let sequence=0;
 const poll=(phase,recordingId=null,projectId=null,paused=null,front=false,canSwitch=false,ack=[])=>post('/api/camera-devices/poll',phone,{id,sequence:++sequence,name:'Fixture camera',capability:'remote-record-v2',phase,paused,cameraFront:front,cameraCanSwitch:canSwitch,recordingId,projectId,sizeBytes:null,sha256:null,ack},{'x-camera-device-ticket':ticket});
 const path=`/api/camera-devices/${id}/commands`;
 assert.equal((await poll('idle',null,null,null,false,true)).status,200);
 const unauthorized=await post('/api/camera-devices/poll',phone,{id,sequence:++sequence,name:'Fake',capability:'remote-record-v2',phase:'idle',paused:null,cameraFront:false,cameraCanSwitch:true,recordingId:null,projectId:null,ack:[]});assert.equal(unauthorized.status,403);
 const switchId=randomUUID(),switchCommand={id:switchId,type:'camera_switch',recordingId:switchId,projectId:null,cameraFrom:false};
 assert.equal((await post(path,browser,switchCommand,{origin:'https://wrong.invalid'})).status,403);
 assert.equal((await post(path,browser,switchCommand)).status,201);
 let r=await poll('idle',null,null,null,false,true);assert.equal(r.status,200);const switchDelivery=(await r.json()).commands[0];assert.equal(switchDelivery.type,'camera_switch');assert.equal(switchDelivery.cameraFrom,false);
 assert.equal((await poll('idle',null,null,null,true,true,[{id:switchId,result:'accepted'}])).status,200);
 r=await fetch(base+'/api/camera-devices',{headers:{cookie:browser}});assert.equal((await r.json()).devices[0].cameraFront,true);
 r=await post('/api/projects',browser,{title:'Synthetic camera test',script:'fixture',sources:[],titles:[],thumbnail:'',broll:[]});assert.equal(r.status,201);const project=(await r.json()).id,recording=randomUUID(),startId=randomUUID();
 assert.equal((await post(path,browser,{id:startId,type:'record_start',recordingId:recording,projectId:project})).status,201);
 r=await poll('idle',null,null,null,true,true);assert.equal((await r.json()).commands[0].id,startId);
 assert.equal((await poll('recording',recording,project,false,true,false,[{id:startId,result:'accepted'}])).status,200);
 const pause=randomUUID(),pauseBody={id:pause,type:'record_pause',recordingId:recording,projectId:null};
 assert.equal((await post(path,browser,pauseBody)).status,201);assert.equal((await post(path,browser,pauseBody)).status,200);
 r=await poll('recording',recording,project,false,true,false);assert.equal((await r.json()).commands[0].id,pause);
 assert.equal((await poll('recording',recording,project,true,true,false,[{id:pause,result:'accepted'}])).status,200);
 r=await fetch(base+'/api/camera-devices',{headers:{cookie:browser}});assert.equal((await r.json()).devices[0].paused,true);
 const resume=randomUUID();assert.equal((await post(path,browser,{id:resume,type:'record_resume',recordingId:recording,projectId:null})).status,201);
 r=await poll('recording',recording,project,true,true,false);assert.equal((await r.json()).commands[0].id,resume);
 assert.equal((await poll('recording',recording,project,false,true,false,[{id:resume,result:'accepted'}])).status,200);
 const stop=randomUUID();assert.equal((await post(path,browser,{id:stop,type:'record_stop',recordingId:recording,projectId:null})).status,201);
 r=await poll('recording',recording,project,false,true,false);assert.equal((await r.json()).commands[0].type,'record_stop');
 assert.equal((await poll('finalizing',recording,project,null,true,false)).status,200);
 assert.equal((await post('/api/logout',browser,{})).status,200);assert.equal((await post(path,browser,pauseBody)).status,403);
});
