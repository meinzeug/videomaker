// Opt in only for a disposable local server, never a public or production host.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
import {cameraUploadIdFor} from '../lib/camera-project-claims.ts';
const base=process.env.CAMERA_REMOTE_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3331'&&process.env.CAMERA_REMOTE_TEST_ALLOW_WRITES==='1';
test('camera API separates command receipts from actual device telemetry', {skip:!enabled,timeout:90000}, async()=>{
 let cookie='',projectId='',ticket='';
 const req=(path,{method='GET',body,origin=base,auth=true}={})=>fetch(base+path,{method,headers:{...(auth&&cookie?{cookie}:{}),...(ticket?{'x-camera-device-ticket':ticket}:{}),...(method!=='GET'?{origin}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  assert.equal((await req('/api/camera-devices',{auth:false})).status,401);
  let response=await req('/api/login',{method:'POST',body:{password:'camera-local-test'}});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];
  const device=randomUUID(),take=randomUUID(),command=randomUUID();let sequence=0;
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({type:'spki',format:'der'});
  for(const action of ['register','session']){
   let result=await req('/api/camera-devices/pairing/challenge',{method:'POST',body:{deviceId:device,action}});assert.equal(result.status,200);const challenge=await result.json(),bytes=action==='register'?spki:Buffer.alloc(0);
   const message=`videomaker-camera-device-auth/v2\n${device}\n${challenge.challengeId}\n${challenge.challenge}\n${action}\n${createHash('sha256').update(bytes).digest('hex')}\n`;
   result=await req('/api/camera-devices/pairing/complete',{method:'POST',body:{deviceId:device,action,challengeId:challenge.challengeId,payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.from(message),privateKey).toString('base64url')}});assert.equal(result.status,200);const completed=await result.json();if(action==='session')ticket=completed.ticket;
  }
  const heart=(patch={})=>({id:device,sequence:++sequence,name:'Kamera Test',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[],...patch});
  assert.equal((await req('/api/camera-devices/poll',{method:'POST',origin:'https://invalid.example',body:heart()})).status,403);
  response=await req('/api/projects',{method:'POST',body:{title:'Kamera-Test',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]}});assert.equal(response.status,201);projectId=(await response.json()).id;
  let first=heart();response=await req('/api/camera-devices/poll',{method:'POST',body:first});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual((await response.json()).commands,[]);
  const deviceCookie=cookie;response=await req('/api/login',{method:'POST',body:{password:'camera-local-test'}});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];assert.notEqual(cookie,deviceCookie);
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart()});assert.equal(response.status,403);cookie=deviceCookie;
  const payload={id:command,type:'record_start',recordingId:take,projectId};const path=`/api/camera-devices/${device}/commands`;
  response=await req(path,{method:'POST',body:payload});assert.equal(response.status,201);assert.equal((await response.json()).result,'queued');
  response=await req(path,{method:'POST',body:payload});assert.equal(response.status,200);assert.equal((await response.json()).created,false);
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart()});assert.equal(response.status,200);assert.equal((await response.json()).commands[0].id,command);
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart({ack:[{id:command,result:'accepted'}]})});assert.equal(response.status,200);assert.deepEqual((await response.json()).commands,[]);
  response=await req('/api/camera-devices');const before=(await response.json()).devices.find(item=>item.id===device);assert.equal(before.phase,'idle');assert.equal(before.lastCommand.result,'accepted');
  response=await req('/api/camera-devices/poll',{method:'POST',body:first});assert.equal(response.status,409);
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart({phase:'recording',recordingId:take,projectId})});assert.equal(response.status,200);
  response=await req('/api/camera-devices');assert.equal((await response.json()).devices.find(item=>item.id===device).phase,'recording');
  response=await req(path,{method:'POST',body:{id:randomUUID(),type:'record_stop',recordingId:randomUUID()}});assert.equal(response.status,409);
  response=await req(path,{method:'POST',body:{id:randomUUID(),type:'record_stop',recordingId:take}});assert.equal(response.status,201);const stop=(await response.json()).id;
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart({phase:'recording',recordingId:take,projectId,ack:[{id:stop,result:'expired'}]})});assert.equal((await response.json()).commands[0].id,stop);
  response=await req(path,{method:'POST',body:{id:randomUUID(),type:'record_stop',recordingId:take}});assert.equal((await response.json()).id,stop);
  response=await req(`/api/projects/${projectId}`,{method:'DELETE'});assert.equal(response.status,409);
  const earlier=heart({phase:'recording',recordingId:take,projectId}),later=heart({phase:'finalizing',recordingId:take,projectId});
  const raced=await Promise.all([req('/api/camera-devices/poll',{method:'POST',body:earlier}),req('/api/camera-devices/poll',{method:'POST',body:later})]);assert.equal(raced[1].status,200);assert.ok([200,409].includes(raced[0].status));
  assert.equal((await (await req('/api/camera-devices')).json()).devices.find(item=>item.id===device).phase,'finalizing');
  assert.equal((await req('/api/camera-devices/poll',{method:'POST',body:earlier})).status,409);
  response=await req(`/api/projects/${projectId}`,{method:'DELETE'});assert.equal(response.status,409);
  const bytes=Buffer.from('synthetic local fixture, no media or production data');
  const uploadHeaders={origin:base,cookie,'content-type':'video/mp4','content-length':String(bytes.length),'x-recording-id':cameraUploadIdFor(take,projectId),'x-camera-recording-id':take,'x-content-sha256':createHash('sha256').update(bytes).digest('hex')};
  response=await fetch(`${base}/api/projects/${projectId}/recordings`,{method:'POST',headers:uploadHeaders,body:bytes});assert.equal(response.status,409);assert.equal((await response.json()).code,'camera_manifest_pending');
  const withoutCameraHeader={...uploadHeaders};delete withoutCameraHeader['x-camera-recording-id'];
  response=await fetch(`${base}/api/projects/${projectId}/recordings`,{method:'POST',headers:withoutCameraHeader,body:bytes});assert.equal(response.status,409);assert.equal((await response.json()).code,'camera_manifest_required');
  response=await req(`/api/projects/${projectId}`,{method:'DELETE'});assert.equal(response.status,409);
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart({phase:'ready',recordingId:take,projectId,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})});assert.equal(response.status,200);
  response=await fetch(`${base}/api/projects/${projectId}/recordings`,{method:'POST',headers:{...uploadHeaders,'x-content-sha256':'0'.repeat(64)},body:bytes});assert.equal(response.status,409);assert.equal((await response.json()).code,'camera_manifest_mismatch');
  response=await fetch(`${base}/api/projects/${projectId}/recordings`,{method:'POST',headers:uploadHeaders,body:bytes});assert.equal(response.status,201);
  response=await req(`/api/projects/${projectId}`,{method:'DELETE'});assert.equal(response.status,200);projectId='';
  response=await fetch(base+'/api/camera-devices/poll',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:' '.repeat(8193)});assert.equal(response.status,400);
 } finally {if(projectId){const deleted=await req(`/api/projects/${projectId}`,{method:'DELETE'});assert.ok(deleted.ok||deleted.status===409);}}
});
