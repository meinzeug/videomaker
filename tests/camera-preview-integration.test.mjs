// Explicit opt-in, local disposable database/server only; never use production.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
const base=process.env.CAMERA_PREVIEW_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3332'&&process.env.CAMERA_PREVIEW_ALLOW_WRITES==='1';
const offer='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=recvonly\r\n';
const answer='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=sendonly\r\n';
test('isolated preview auth, explicit device availability, signaling and revocation',{skip:!enabled,timeout:90000},async()=>{
 let browserCookie='',deviceCookie='';const deviceId=randomUUID(),{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({type:'spki',format:'der'});
 async function request(path,{cookie='',method='POST',body,origin=base,ticket}={}){return fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{origin}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...(ticket?{'x-camera-device-ticket':ticket}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 async function login(){const r=await request('/api/login',{body:{password:'camera-local-test'}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
 async function prove(action){
  let r=await request('/api/camera-devices/pairing/challenge',{cookie:deviceCookie,body:{deviceId,action}});assert.equal(r.status,200);const c=await r.json(),payload=action==='register'?spki:Buffer.alloc(0);
  const message=`videomaker-camera-device-auth/v2\n${deviceId}\n${c.challengeId}\n${c.challenge}\n${action}\n${createHash('sha256').update(payload).digest('hex')}\n`;
  r=await request('/api/camera-devices/pairing/complete',{cookie:deviceCookie,body:{deviceId,action,challengeId:c.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),privateKey).toString('base64url')}});assert.equal(r.status,200);return await r.json();
 }
 browserCookie=await login();deviceCookie=await login();await prove('register');const ticket=(await prove('session')).ticket;
 const heartbeat={id:deviceId,sequence:1,name:'Testkamera',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[]};
 assert.equal((await request('/api/camera-devices/poll',{cookie:deviceCookie,ticket,body:heartbeat})).status,200);
 let r=await request('/api/camera-preview/devices',{method:'GET'});assert.equal(r.status,401);
 r=await request('/api/camera-preview/devices',{method:'GET',cookie:browserCookie});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');const initial=await r.json();assert.deepEqual(initial.devices,[]);
 const sessionId=randomUUID(),create={generation:initial.generation,creationToken:initial.creationToken,sessionId,deviceId,offer};
 assert.equal((await request('/api/camera-preview/sessions',{cookie:browserCookie,body:create,origin:'https://invalid.example'})).status,403);
 assert.equal((await request('/api/camera-preview/sessions',{cookie:browserCookie,body:create})).status,409);
 const discover={deviceId,sessionId:null,after:0,events:[],available:true};
 assert.equal((await request('/api/camera-preview/device',{cookie:deviceCookie,body:discover})).status,403);
 r=await request('/api/camera-preview/device',{cookie:deviceCookie,ticket,body:discover});assert.equal(r.status,200);assert.equal((await r.json()).session,null);
 r=await request('/api/camera-preview/devices',{method:'GET',cookie:browserCookie});assert.equal((await r.json()).devices[0].deviceId,deviceId);
 r=await request('/api/camera-preview/sessions',{cookie:browserCookie,body:create});assert.equal(r.status,201);assert.equal((await r.json()).sessionId,sessionId);
 const intruder=await login();assert.equal((await request(`/api/camera-preview/sessions/${sessionId}/exchange`,{cookie:intruder,body:{after:0,events:[]}})).status,404);
 assert.equal((await request('/api/camera-preview/device',{cookie:deviceCookie,ticket,body:{...discover,deviceId:randomUUID()}})).status,403);
 r=await request('/api/camera-preview/device',{cookie:deviceCookie,ticket,body:discover});assert.equal(r.status,200);const incoming=(await r.json()).session;assert.equal(incoming.events[0].kind,'offer');assert.equal(incoming.events[0].data,offer);
 const reply={id:randomUUID(),kind:'answer',data:answer,mid:null,mLineIndex:null};
 r=await request('/api/camera-preview/device',{cookie:deviceCookie,ticket,body:{deviceId,sessionId,after:1,events:[reply],available:true}});assert.equal(r.status,200);
 r=await request(`/api/camera-preview/sessions/${sessionId}/exchange`,{cookie:browserCookie,body:{after:0,events:[]}});assert.equal(r.status,200);assert.equal((await r.json()).events[0].kind,'answer');
 const ice={id:randomUUID(),kind:'ice',data:'candidate:1 1 udp 2122260223 192.168.1.10 55600 typ host',mid:'0',mLineIndex:0};
 for(let i=0;i<2;i++)assert.equal((await request(`/api/camera-preview/sessions/${sessionId}/exchange`,{cookie:browserCookie,body:{after:1,events:[ice]}})).status,200);
 r=await request('/api/camera-preview/device',{cookie:deviceCookie,ticket,body:{deviceId,sessionId,after:1,events:[],available:true}});assert.equal((await r.json()).session.events.length,1);
 assert.equal((await request('/api/camera-preview/device',{cookie:deviceCookie,ticket,body:{deviceId,sessionId,after:1,events:[],available:false}})).status,200);
 assert.equal((await request(`/api/camera-preview/sessions/${sessionId}/exchange`,{cookie:browserCookie,body:{after:1,events:[]}})).status,404);
});
