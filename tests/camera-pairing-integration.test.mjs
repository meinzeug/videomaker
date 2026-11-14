// Only against a disposable local development server; never a public host.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
const base=process.env.CAMERA_REMOTE_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3331'&&process.env.CAMERA_REMOTE_TEST_ALLOW_WRITES==='1';
test('paired device proves identity across login renewal and rejects legacy impersonation', {skip:!enabled,timeout:90000}, async()=>{
 let cookie='';const deviceId=randomUUID(),{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({type:'spki',format:'der'});let sequence=0;
 const req=(path,body,extra={})=>fetch(base+path,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 async function login(){const response=await req('/api/login',{password:'camera-local-test'});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];}
 async function prove(action){
  let response=await req('/api/camera-devices/pairing/challenge',{deviceId,action});assert.equal(response.status,200);const challenge=await response.json();
  const payload=action==='register'?spki:Buffer.alloc(0),hash=createHash('sha256').update(payload).digest('hex');
  const message=`videomaker-camera-device-auth/v2\n${deviceId}\n${challenge.challengeId}\n${challenge.challenge}\n${action}\n${hash}\n`;
  const data={deviceId,action,challengeId:challenge.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),privateKey).toString('base64url')};
  response=await req('/api/camera-devices/pairing/complete',data);assert.equal(response.status,200);const result=await response.json();
  assert.notEqual((await req('/api/camera-devices/pairing/complete',data)).status,200);return result;
 }
 function heartbeat(patch={}){return {id:deviceId,sequence:++sequence,name:'Testkamera',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[],...patch};}
 await login();assert.equal((await req('/api/camera-devices/poll',heartbeat())).status,403); // unregistered legacy device is disabled by default
 assert.equal((await prove('register')).registered,true);const first=(await prove('session')).ticket;
 assert.equal((await req('/api/camera-devices/poll',heartbeat())).status,403);
 assert.equal((await req('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':first})).status,200);
 await login();assert.equal((await req('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':first})).status,403);
 const second=(await prove('session')).ticket;assert.notEqual(first,second);
 assert.equal((await req('/api/camera-devices/poll',heartbeat(),{'x-camera-device-ticket':second})).status,200);
 assert.equal((await req('/api/camera-devices/poll',heartbeat())).status,403);
 const project=await req('/api/projects',{title:'Kamera-Auflösungstest',script:'Lokale Testaufnahme',sources:[],titles:[],thumbnail:'',broll:[]});assert.equal(project.status,201);const projectId=(await project.json()).id,recordingId=randomUUID(),commandId=randomUUID();
 const path=`/api/camera-devices/${deviceId}`,headers={'x-camera-device-ticket':second};
 assert.equal((await req(`${path}/commands`,{id:commandId,type:'record_start',recordingId,projectId})).status,201);
 assert.equal((await req('/api/camera-devices/poll',heartbeat(),headers)).status,200);
 assert.equal((await req('/api/camera-devices/poll',heartbeat({phase:'recording',recordingId,projectId,ack:[{id:commandId,result:'accepted'}]}),headers)).status,200);
 assert.equal((await req(`${path}/resolve`,{recordingId,projectId,confirm:'retain-local-file'})).status,409);
 assert.equal((await req('/api/camera-devices/poll',heartbeat({phase:'error',recordingId,projectId}),headers)).status,200);
 assert.equal((await req('/api/camera-devices/poll',heartbeat(),headers)).status,200);
 assert.equal((await req(`${path}/resolve`,{recordingId,projectId})).status,400);
 assert.equal((await req(`${path}/resolve`,{recordingId,projectId,confirm:'retain-local-file'})).status,200);
 assert.equal((await req(`${path}/resolve`,{recordingId,projectId,confirm:'retain-local-file'})).status,200);
 assert.equal((await fetch(base+`/api/projects/${projectId}`,{method:'DELETE',headers:{origin:base,cookie}})).status,200);
});
