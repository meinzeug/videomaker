// Opt in only for a disposable local server, never a public or production host.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base=process.env.CAMERA_REMOTE_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3331'&&process.env.CAMERA_REMOTE_TEST_ALLOW_WRITES==='1';
test('camera API separates command receipts from actual device telemetry', {skip:!enabled,timeout:90000}, async()=>{
 let cookie='',projectId='';
 const req=(path,{method='GET',body,origin=base,auth=true}={})=>fetch(base+path,{method,headers:{...(auth&&cookie?{cookie}:{}),...(method!=='GET'?{origin}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  assert.equal((await req('/api/camera-devices',{auth:false})).status,401);
  let response=await req('/api/login',{method:'POST',body:{password:'camera-local-test'}});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];
  const device=randomUUID(),take=randomUUID(),command=randomUUID();let sequence=0;
  const heart=(patch={})=>({id:device,sequence:++sequence,name:'Kamera Test',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[],...patch});
  assert.equal((await req('/api/camera-devices/poll',{method:'POST',origin:'https://invalid.example',body:heart()})).status,403);
  response=await req('/api/projects',{method:'POST',body:{title:'Kamera-Test',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]}});assert.equal(response.status,201);projectId=(await response.json()).id;
  let first=heart();response=await req('/api/camera-devices/poll',{method:'POST',body:first});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual((await response.json()).commands,[]);
  const deviceCookie=cookie;response=await req('/api/login',{method:'POST',body:{password:'camera-local-test'}});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];assert.notEqual(cookie,deviceCookie);
  response=await req('/api/camera-devices/poll',{method:'POST',body:heart()});assert.equal(response.status,409);cookie=deviceCookie;
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
  response=await req(path,{method:'POST',body:{id:randomUUID(),type:'record_stop',recordingId:take}});assert.equal(response.status,201);
  const earlier=heart({phase:'recording',recordingId:take,projectId}),later=heart({phase:'finalizing',recordingId:take,projectId});
  const raced=await Promise.all([req('/api/camera-devices/poll',{method:'POST',body:earlier}),req('/api/camera-devices/poll',{method:'POST',body:later})]);assert.equal(raced[1].status,200);assert.ok([200,409].includes(raced[0].status));
  assert.equal((await (await req('/api/camera-devices')).json()).devices.find(item=>item.id===device).phase,'finalizing');
  assert.equal((await req('/api/camera-devices/poll',{method:'POST',body:earlier})).status,409);
  response=await fetch(base+'/api/camera-devices/poll',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:' '.repeat(8193)});assert.equal(response.status,400);
 } finally {if(projectId){const deleted=await req(`/api/projects/${projectId}`,{method:'DELETE'});assert.ok(deleted.ok);}}
});
