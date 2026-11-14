// Only run against a disposable local dev server and empty DATA_DIR.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';

const base=process.env.CAMERA_AUTH_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3332'&&process.env.CAMERA_AUTH_TEST_ALLOW_WRITES==='1';
const headers={origin:base,'content-type':'application/json'};
const post=(path,cookie,body,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...(cookie?{cookie}:{}),...extra},body:JSON.stringify(body)});
async function login(){const response=await post('/api/login','',{password:'camera-local-test'});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
async function logout(cookie){const result=await fetch(base+'/api/logout',{method:'POST',headers:{origin:base,cookie}});assert.equal(result.status,200);assert.equal((await fetch(base+'/api/projects',{headers:{cookie}})).status,401);}

// Begin sending a valid request but withhold its final JSON bytes until after
// logout. The warm request compiles the route, and the open-stream check ensures
// the request was not already completed. The delay is a scheduling aid, not a
// proof of every possible multi-worker interleaving.
async function delayedRequest(path,cookie,body){
 let finish,responded=false;
 const response=new Promise((resolve,reject)=>{
  const req=http.request(base+path,{method:'POST',headers:{...headers,cookie}},res=>{
   responded=true;let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,data}));
  });
  req.on('error',reject);req.write('{');finish=()=>req.end(JSON.stringify(body).slice(1));
 });
 await new Promise(resolve=>setTimeout(resolve,1500));
 assert.equal(responded,false,'request must still be waiting for its body');
 return {response,finish};
}

test('a delayed pairing challenge cannot succeed after logout', {skip:!enabled,timeout:90000},async()=>{
 const cookie=await login(),path='/api/camera-devices/pairing/challenge';
 assert.equal((await post(path,cookie,{})).status,400); // warm route
 const pending=await delayedRequest(path,cookie,{deviceId:randomUUID(),action:'register'});
 await logout(cookie);pending.finish();assert.equal((await pending.response).status,403);
});

test('a delayed START after logout is not delivered to another logged-in camera', {skip:!enabled,timeout:90000},async()=>{
 const browser=await login(),phone=await login(),id=randomUUID(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const spki=keys.publicKey.export({format:'der',type:'spki'});
 async function pair(action){
  let response=await post('/api/camera-devices/pairing/challenge',phone,{deviceId:id,action});assert.equal(response.status,200);const challenge=await response.json();
  const payload=action==='register'?spki:Buffer.alloc(0),hash=createHash('sha256').update(payload).digest('hex');
  const message=`videomaker-camera-device-auth/v2\n${id}\n${challenge.challengeId}\n${challenge.challenge}\n${action}\n${hash}\n`;
  response=await post('/api/camera-devices/pairing/complete',phone,{deviceId:id,action,challengeId:challenge.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),keys.privateKey).toString('base64url')});
  assert.equal(response.status,200);return response.json();
 }
 await pair('register');const {ticket}=await pair('session');
 const project=await post('/api/projects',browser,{title:'TEST logout race',script:'test',sources:[],titles:[],thumbnail:'',broll:[]});assert.equal(project.status,201);const projectId=(await project.json()).id;
 const path=`/api/camera-devices/${id}/commands`;assert.equal((await post(path,browser,{})).status,400); // warm route
 const heartbeat=sequence=>({id,sequence,name:'Dummy',capability:'remote-record-v1',phase:'idle',recordingId:null,projectId:null,ack:[]});
 assert.equal((await post('/api/camera-devices/poll',phone,heartbeat(1),{'x-camera-device-ticket':ticket})).status,200);
 const pending=await delayedRequest(path,browser,{id:randomUUID(),type:'record_start',recordingId:randomUUID(),projectId});
 await logout(browser);pending.finish();assert.equal((await pending.response).status,403);
 const result=await post('/api/camera-devices/poll',phone,heartbeat(2),{'x-camera-device-ticket':ticket});
 assert.equal(result.status,200);assert.deepEqual((await result.json()).commands,[]);
});
