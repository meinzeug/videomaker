import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,sign} from 'node:crypto';
import {createRequire} from 'node:module';
import Database from 'better-sqlite3';
import {createServer as createHttpsServer} from 'node:https';
import {createServer as createTcpServer,createConnection} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './fixtures/relay-delivery-fixture.mjs';
import {revokeRelayPairing,revokeRelayDevice} from '../lib/relay-pairing-registry.ts';
import {revokeSession} from '../lib/session-revocations.ts';
import {createBoundTurnFixture} from '../experiments/turn-wss/bound-bridge.mjs';
import {initializeDeviceAuthFixture,reconnectTranscript,beginDeviceReconnect,completeDeviceReconnect,deviceRequestTranscript,authorizeDeviceRequest} from '../experiments/device-auth/core.mjs';
import {createDeviceBoundTurnFixture} from '../experiments/turn-wss/device-bound-bridge.mjs';
import {createBoundedFixtureServer} from '../experiments/turn-wss/bridge.mjs';

process.env.NODE_ENV='test';process.env.VIDEOMAKER_TURN_WSS_FIXTURE='1';process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE='1';
const require=createRequire(process.env.VIDEOMAKER_TEST_REQUIRE_FROM||import.meta.url);
const {WebSocket,WebSocketServer,createWebSocketStream}=require('next/dist/compiled/ws');
const waitFor=async(fn,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(10);}throw Error('fixture timeout');};
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const closeServer=async server=>{if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));};
function setup(f,changes={}){
 const runtimeId=f.db.prepare('SELECT runtime_id FROM relay_session_tokens LIMIT 1').get().runtime_id;
 const device=f.camera,identity={owner:f.owner,session:device.session,deviceId:device.deviceId};
 const options={db:f.db,secret:f.secret,owner:f.owner,session:device.session,request:device.participant.request,credential:device.participant.credential,
  clock:()=>({runtimeId,wall:1023,tick:1023}),wallClock:()=>1023,authenticatedPrincipal:()=>identity,pollMs:20,...changes};
 return {options,identity,create:()=>createBoundTurnFixture(options)};
}
const temp=mkdtempSync(join(tmpdir(),'vm-bound-turn-fixture-'));const keyPath=join(temp,'key.pem'),certPath=join(temp,'cert.pem');
const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
if(generated.status!==0)throw Error('openssl fixture setup failed');const key=readFileSync(keyPath),cert=readFileSync(certPath);
process.once('exit',()=>rmSync(temp,{recursive:true,force:true}));
async function harness(guard,{revokeBeforeAttach}={}){
 let received=0,peer,peerClosed=false;const upstream=createTcpServer(socket=>{peer=socket;socket.on('data',chunk=>{received+=chunk.length;socket.write(chunk);});socket.on('error',()=>{});socket.on('close',()=>{peerClosed=true;});});const upstreamPort=await listen(upstream);
 const server=createHttpsServer({key,cert});const wss=createBoundedFixtureServer(WebSocketServer);const sockets=new Set(),handles=[];let denied=0;
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('upgrade',(req,socket,head)=>{
  if(!guard.checkBeforeUpgrade()){denied++;socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  socket.pause();const tcp=createConnection({host:'127.0.0.1',port:upstreamPort});tcp.once('error',()=>socket.destroy());
  tcp.once('connect',()=>{
   if(revokeBeforeAttach)revokeBeforeAttach();
   wss.handleUpgrade(req,socket,head,ws=>{try{handles.push(guard.attach({websocket:ws,upstream:tcp,createWebSocketStream}));}catch{}socket.resume();});
  });
 });
 const port=await listen(server);
 const connect=()=>{const ws=new WebSocket(`wss://127.0.0.1:${port}/fixture`,{ca:cert,servername:'localhost',perMessageDeflate:false,maxPayload:64*1024});ws.on('error',()=>{});return ws;};
 return {connect,handles,get received(){return received;},get denied(){return denied;},get peerClosed(){return peerClosed;},sendPeer(data){peer.write(data);},async close(){await guard.close();for(const socket of sockets)socket.destroy();await closeServer(server);wss.close();await closeServer(upstream);}};
}

test('only the bound authenticated tenant, session, device and pairing can create a guard',()=>{
 const f=fixture();try{
  const good=setup(f);assert.equal(good.create().checkBeforeUpgrade(),true);
  for(const invalid of [
   {authenticatedPrincipal:()=>({owner:'b'.repeat(64),session:f.camera.session,deviceId:f.camera.deviceId})},
   {authenticatedPrincipal:()=>({owner:f.owner,session:f.prompter.session,deviceId:f.camera.deviceId})},
   {authenticatedPrincipal:()=>({owner:f.owner,session:f.camera.session,deviceId:f.prompter.deviceId})},
   {credential:randomBytes(32).toString('base64url')},
   {request:{...f.camera.participant.request,role:'prompter'}},
   {request:{...f.camera.participant.request,roomId:randomBytes(16).toString('base64url')}},
   {authenticatedPrincipal:()=>{throw Error('fixture error');}},
  ])assert.throws(()=>setup(f,invalid).create(),/TURN_BOUND_DENIED/);
 }finally{f.db.close();}
});

test('mutable request data cannot change an existing bound identity',()=>{
 const f=fixture();try{
  const input={...f.camera.participant.request};const x=setup(f,{request:input});const guard=x.create();input.role='prompter';input.deviceId=f.prompter.deviceId;
  assert.equal(guard.checkBeforeUpgrade(),true);x.identity.deviceId=f.prompter.deviceId;assert.equal(guard.recheckNow(),false);
 }finally{f.db.close();}
});

test('revocation before upgrade or between upgrade and attach never forwards bytes', {timeout:10000},async()=>{
 for(const mode of ['before','during']){
  const f=fixture();let h;try{
   const guard=setup(f).create();const revoke=()=>revokeRelayPairing(f.db,f.owner,f.camera.participant.request.pairId,1025,()=>true);
   h=await harness(guard,mode==='during'?{revokeBeforeAttach:revoke}:{});if(mode==='before')revoke();
   const ws=h.connect();const closed=new Promise(resolve=>ws.once('close',resolve));await closed;
   assert.equal(h.received,0);if(mode==='before')assert.equal(h.denied,1);
  }finally{if(h)await h.close();f.db.close();}
 }
});

test('pair revocation immediately closes a local active connection after notification', {timeout:10000},async()=>{
 const f=fixture();let h;try{
  const guard=setup(f).create();h=await harness(guard);const ws=h.connect();await once(ws,'open');await waitFor(()=>h.handles.length===1);
  const got=once(ws,'message');ws.send(Buffer.from('before'));assert.equal((await got)[0].toString(),'before');assert.equal(h.received,6);
  const closed=new Promise(resolve=>ws.once('close',resolve));revokeRelayPairing(f.db,f.owner,f.camera.participant.request.pairId,1025,()=>true);
  assert.equal(guard.recheckNow(),false);await closed;assert.equal(await h.handles[0].closed,'aborted');await waitFor(()=>h.peerClosed);assert.equal(h.received,6);
 }finally{if(h)await h.close();f.db.close();}
});

test('peer logout or device revocation closes even an idle active connection', {timeout:10000},async()=>{
 for(const mode of ['peer-logout','device']){
  const f=fixture();let h;try{
   const guard=setup(f).create();h=await harness(guard);const ws=h.connect();await once(ws,'open');await waitFor(()=>h.handles.length===1);
   const closed=new Promise(resolve=>ws.once('close',resolve));
   if(mode==='peer-logout')revokeSession(f.db,f.secret,f.prompter.cookie,1025);else revokeRelayDevice(f.db,f.owner,f.camera.deviceId,1025,()=>true);
   await closed;assert.equal(await h.handles[0].closed,'aborted');await waitFor(()=>h.peerClosed);
  }finally{if(h)await h.close();f.db.close();}
 }
});

test('revocation from a separate process closes an idle connection on the next poll', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-bound-cross-process-'));const path=join(directory,'sessions.sqlite');
 const f=fixture(new Database(path));let h;
 try{
  const guard=setup(f).create();h=await harness(guard);const ws=h.connect();await once(ws,'open');await waitFor(()=>h.handles.length===1);
  const closed=new Promise(resolve=>ws.once('close',resolve));
  const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/revoke-relay-worker.mjs',import.meta.url).pathname,path,f.owner,f.camera.participant.request.pairId],{stdio:'ignore'});
  const [status]=await once(child,'exit');assert.equal(status,0);await closed;assert.equal(await h.handles[0].closed,'aborted');await waitFor(()=>h.peerClosed);
 }finally{if(h)await h.close();f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('every data direction is rechecked after revocation before forwarding a new chunk', {timeout:10000},async()=>{
 for(const direction of ['incoming','outgoing']){
  const f=fixture();let h;try{
   const guard=setup(f,{pollMs:5000}).create();h=await harness(guard);const ws=h.connect();await once(ws,'open');await waitFor(()=>h.handles.length===1);
   const closed=new Promise(resolve=>ws.once('close',resolve));revokeSession(f.db,f.secret,f.prompter.cookie,1025);
   if(direction==='incoming')ws.send(Buffer.from('must-not-arrive'));else h.sendPeer(Buffer.from('must-not-arrive'));
   let receivedAtClient=false;ws.on('message',()=>{receivedAtClient=true;});await closed;assert.equal(await h.handles[0].closed,'aborted');
   assert.equal(h.received,0);assert.equal(receivedAtClient,false);
  }finally{if(h)await h.close();f.db.close();}
 }
});

test('expired browser session remains denied after clock rollback',()=>{
 const f=fixture();try{
  let wall=1023;const guard=setup(f,{wallClock:()=>wall}).create();wall=10001;assert.equal(guard.recheckNow(),false);wall=1023;
  assert.throws(()=>setup(f,{wallClock:()=>wall}).create(),/TURN_BOUND_DENIED/);
 }finally{f.db.close();}
});

const digest=value=>createHash('sha256').update(value).digest('hex');
function deviceSetup(f){
 initializeDeviceAuthFixture(f.db);const runtimeId=f.db.prepare('SELECT runtime_id FROM relay_session_tokens LIMIT 1').get().runtime_id;
 let time=1023;const clock=()=>({runtimeId,wall:time,tick:time});const device=f.camera,pairId=device.participant.request.pairId;
 const clientChallenge=randomBytes(32).toString('hex');const attempt={clientChallenge,...beginDeviceReconnect(f.db,{deviceId:device.deviceId,pairId,clientChallenge},clock)};
 const signature=sign('sha256',reconnectTranscript(attempt),device.keys.privateKey);
 const session=completeDeviceReconnect(f.db,{attemptId:attempt.attemptId,clientChallenge,signature},clock);
 const grant=(changes={})=>{
  const requestNonce=randomBytes(32).toString('hex');const fields={ownerHash:f.owner,deviceId:device.deviceId,pairId,role:'camera',sessionHash:digest(Buffer.from(session.sessionCredential,'base64url')),requestNonce,method:'GET',path:'/api/relay/connect',bodySha256:digest(''),...changes};
  return authorizeDeviceRequest(f.db,{sessionCredential:session.sessionCredential,requestNonce,signature:sign('sha256',deviceRequestTranscript(fields),device.keys.privateKey)},{method:fields.method,path:fields.path,bodySha256:fields.bodySha256},clock);
 };
 return {clock,grant,setTime:value=>{time=value;},guard:identity=>createDeviceBoundTurnFixture({db:f.db,identity,clock,pollMs:20})};
}

test('only an unmodified, once-consumed device proof authorizes the relay',()=>{
 const f=fixture();try{
  const x=deviceSetup(f),identity=x.grant();assert.throws(()=>x.guard({...identity}),/DEVICE_TURN_DENIED/);
  const guard=x.guard(identity);assert.equal(guard.checkBeforeUpgrade(),true);assert.throws(()=>x.guard(identity),/DEVICE_TURN_DENIED/);
  assert.throws(()=>x.guard(x.grant({method:'POST'})),/DEVICE_TURN_DENIED/);guard.close();
 }finally{f.db.close();}
});

test('device-bound connection rejects revocation before and during upgrade', {timeout:10000},async()=>{
 for(const mode of ['before','during']){
  const f=fixture();let h;try{
   const x=deviceSetup(f),guard=x.guard(x.grant()),revoke=()=>revokeRelayPairing(f.db,f.owner,f.camera.participant.request.pairId,1025,()=>true);
   h=await harness(guard,mode==='during'?{revokeBeforeAttach:revoke}:{});if(mode==='before')revoke();
   const ws=h.connect();await new Promise(resolve=>ws.once('close',resolve));assert.equal(h.received,0);if(mode==='before')assert.equal(h.denied,1);
  }finally{if(h)await h.close();f.db.close();}
 }
});

test('verified device connection closes on external revocation and no further bytes are forwarded', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-device-turn-'));const path=join(directory,'state.sqlite'),f=fixture(new Database(path));let h;
 try{
  const x=deviceSetup(f),guard=x.guard(x.grant());h=await harness(guard);const ws=h.connect();await once(ws,'open');await waitFor(()=>h.handles.length===1);
  const echo=once(ws,'message');ws.send(Buffer.from('before'));assert.equal((await echo)[0].toString(),'before');
  const closed=new Promise(resolve=>ws.once('close',resolve));const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/revoke-relay-worker.mjs',import.meta.url).pathname,path,f.owner,f.camera.participant.request.pairId],{stdio:'ignore'});
  const [status]=await once(child,'exit');assert.equal(status,0);await closed;assert.equal(await h.handles[0].closed,'aborted');await waitFor(()=>h.peerClosed);assert.equal(h.received,6);
 }finally{if(h)await h.close();f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('device relay expiry destroys the session and cannot be revived by clock rollback',()=>{
 const f=fixture();try{
  const x=deviceSetup(f),guard=x.guard(x.grant());x.setTime(1023+59990);assert.equal(guard.recheckNow(),false);x.setTime(1023);
  assert.throws(()=>x.guard(x.grant()),/DENIED/);
 }finally{f.db.close();}
});

test('device-bound relay rejects another database and rechecks both data directions', {timeout:10000},async()=>{
 for(const direction of ['incoming','outgoing']){
  const f=fixture(),other=fixture();let h;try{
   const x=deviceSetup(f),identity=x.grant();initializeDeviceAuthFixture(other.db);
   assert.throws(()=>createDeviceBoundTurnFixture({db:other.db,identity,clock:x.clock,pollMs:20}),/DEVICE_TURN_DENIED/);
   const guard=createDeviceBoundTurnFixture({db:f.db,identity,clock:x.clock,pollMs:5000});h=await harness(guard);const ws=h.connect();await once(ws,'open');await waitFor(()=>h.handles.length===1);
   const closed=new Promise(resolve=>ws.once('close',resolve));let got=false;ws.on('message',()=>{got=true;});revokeRelayDevice(f.db,f.owner,f.camera.deviceId,1025,()=>true);
   if(direction==='incoming')ws.send(Buffer.from('must-not-arrive'));else h.sendPeer(Buffer.from('must-not-arrive'));
   await closed;assert.equal(h.received,0);assert.equal(got,false);
  }finally{if(h)await h.close();f.db.close();other.db.close();}
 }
});
