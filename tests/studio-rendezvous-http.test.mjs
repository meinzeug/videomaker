import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';
import {initializeStudioRendezvousFixture} from '../experiments/studio-rendezvous/core.mjs';
import {createStudioRendezvousHttpFixture} from '../experiments/studio-rendezvous/http-fixture.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
const origin='https://videomaker.dorfspy.de';
async function setup(ratePolicy){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);
 const ownerHash='a'.repeat(64),camera={cookie:'cam',sessionHash:'b'.repeat(64),deviceId:randomUUID(),role:'camera'},prompter={cookie:'pro',sessionHash:'c'.repeat(64),deviceId:randomUUID(),role:'prompter'},third={cookie:'third',sessionHash:'d'.repeat(64),deviceId:randomUUID(),role:'prompter'};
 const identities=new Map([camera,prompter,third].map(x=>[x.cookie,{ownerHash,sessionHash:x.sessionHash}])),active=new Set([camera,prompter,third].map(x=>x.sessionHash));
 const runtimeId=randomUUID(),clock=()=>({runtimeId,wall:1000,tick:1000}),secret=randomBytes(32),authorize=(o,s)=>o===ownerHash&&active.has(s);
 const server=createStudioRendezvousHttpFixture({db,getPrincipal:req=>identities.get(req.headers.cookie),authorize,clock,serverSecret:secret,ratePolicy});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(client,path,data,extra={})=>{const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin,cookie:client.cookie,...extra},body:JSON.stringify(data)});return {status:res.status,value:await res.json()};};
 const close=()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}));
 return {db,camera,prompter,third,active,request,close};
}

test('real localhost HTTP: paired sessions exchange HMAC-authenticated binary data and logout stops both', {timeout:10000},async()=>{
 const f=await setup();try{
  let r=await f.request(f.camera,'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()});assert.equal(r.status,200);const room=r.value,base=`/fixture/rooms/${room.roomId}`;
  assert.equal((await f.request(f.prompter,'/fixture/rooms/join',{roomId:room.roomId,joinCode:room.joinCode,deviceId:f.prompter.deviceId})).status,200);
  const member=x=>({role:x.role,deviceId:x.deviceId});
  assert.equal((await f.request(f.camera,base+'/key',member(f.camera))).status,403);
  await f.request(f.camera,base+'/approve',member(f.camera));await f.request(f.prompter,base+'/approve',member(f.prompter));
  const cameraKey=(await f.request(f.camera,base+'/key',member(f.camera))).value.token,prompterKey=(await f.request(f.prompter,base+'/key',member(f.prompter))).value.token;assert.equal(cameraKey,prompterKey);
  const payload=Buffer.from([0,1,2,255,128]),mac=createHmac('sha256',Buffer.from(cameraKey,'hex')).update(payload).digest();
  const data=Buffer.concat([payload,mac]).toString('base64'),send={...member(f.camera),sequence:1,data};
  assert.equal((await f.request(f.camera,base+'/send',send)).value.created,true);assert.equal((await f.request(f.camera,base+'/send',send)).value.created,false);
  const recv=(await f.request(f.prompter,base+'/peek',member(f.prompter))).value,bytes=Buffer.from(recv.data,'base64');assert.equal(recv.sequence,1);assert.deepEqual(bytes.subarray(payload.length),createHmac('sha256',Buffer.from(prompterKey,'hex')).update(bytes.subarray(0,payload.length)).digest());
  assert.equal((await f.request(f.prompter,base+'/ack',{...member(f.prompter),sequence:1})).status,200);
  assert.equal((await f.request(f.prompter,base+'/send',{...member(f.prompter),sequence:1,data:Buffer.from('return').toString('base64')})).status,200);
  assert.equal(Buffer.from((await f.request(f.camera,base+'/peek',member(f.camera))).value.data,'base64').toString(),'return');
  assert.equal((await f.request(f.camera,base+'/ack',{...member(f.camera),sequence:1})).status,200);
  f.active.delete(f.camera.sessionHash);assert.equal((await f.request(f.prompter,base+'/peek',member(f.prompter))).status,403);f.active.add(f.camera.sessionHash);assert.equal((await f.request(f.camera,base+'/key',member(f.camera))).status,403);
 }finally{await f.close();}
});

test('HTTP rejects missing login, wrong origin, malformed payload and competing join', {timeout:10000},async()=>{
 const f=await setup();try{
  assert.equal((await f.request({cookie:'wrong'},'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()})).status,403);
  assert.equal((await f.request(f.camera,'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()},{origin:'https://evil.test'})).status,403);
  const room=(await f.request(f.camera,'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()})).value;
  const join=x=>f.request(x,'/fixture/rooms/join',{roomId:room.roomId,joinCode:room.joinCode,deviceId:x.deviceId});
  const results=await Promise.all([join(f.prompter),join(f.third)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,403]);
  assert.equal((await f.request(f.camera,`/fixture/rooms/${room.roomId}/send`,{deviceId:f.camera.deviceId,role:'camera',sequence:1,data:'?',ownerHash:'attacker'})).status,403);
 }finally{await f.close();}
});

test('fixture refuses non-loopback listener and production activation',()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);
 const args={db,getPrincipal:()=>null,authorize:()=>false,clock:()=>({runtimeId:randomUUID(),wall:0,tick:0}),serverSecret:Buffer.alloc(32)};
 try{const server=createStudioRendezvousHttpFixture(args);assert.throws(()=>server.listen(0,'0.0.0.0'),/LOOPBACK_REQUIRED/);process.env.NODE_ENV='production';assert.throws(()=>createStudioRendezvousHttpFixture(args),/FIXTURE_DISABLED/);}finally{process.env.NODE_ENV='test';db.close();}
});

test('a full queue produces recoverable backpressure and resumes after ACK', {timeout:10000},async()=>{
 const f=await setup();try{
  const room=(await f.request(f.camera,'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()})).value,base=`/fixture/rooms/${room.roomId}`,member=x=>({role:x.role,deviceId:x.deviceId});
  await f.request(f.prompter,'/fixture/rooms/join',{roomId:room.roomId,joinCode:room.joinCode,deviceId:f.prompter.deviceId});await f.request(f.camera,base+'/approve',member(f.camera));await f.request(f.prompter,base+'/approve',member(f.prompter));
  const data=Buffer.from('x').toString('base64');for(let sequence=1;sequence<=16;sequence++)assert.equal((await f.request(f.camera,base+'/send',{...member(f.camera),sequence,data})).status,200);
  const send={...member(f.camera),sequence:17,data};assert.equal((await f.request(f.camera,base+'/send',send)).status,429);
  assert.equal((await f.request(f.prompter,base+'/ack',{...member(f.prompter),sequence:1})).status,200);assert.equal((await f.request(f.camera,base+'/send',send)).status,200);
 }finally{await f.close();}
});

test('long poll wakes on a frame and bounds simultaneous polls per role', {timeout:10000},async()=>{
 const f=await setup();try{
  const room=(await f.request(f.camera,'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()})).value,base=`/fixture/rooms/${room.roomId}`,member=x=>({role:x.role,deviceId:x.deviceId});
  await f.request(f.prompter,'/fixture/rooms/join',{roomId:room.roomId,joinCode:room.joinCode,deviceId:f.prompter.deviceId});await f.request(f.camera,base+'/approve',member(f.camera));await f.request(f.prompter,base+'/approve',member(f.prompter));
  const waiting=f.request(f.prompter,base+'/peek',member(f.prompter));await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await f.request(f.prompter,base+'/peek',member(f.prompter))).status,429);
  assert.equal((await f.request(f.camera,base+'/send',{...member(f.camera),sequence:1,data:Buffer.from('wake').toString('base64')})).status,200);
  const result=await waiting;assert.equal(result.status,200);assert.equal(Buffer.from(result.value.data,'base64').toString(),'wake');
 }finally{await f.close();}
});

test('HTTP create retries recover the same room and code without consuming extra room slots', {timeout:10000},async()=>{
 const f=await setup();try{
  const body={deviceId:f.camera.deviceId,attemptId:randomUUID()},first=await f.request(f.camera,'/fixture/rooms',body),retry=await f.request(f.camera,'/fixture/rooms',body);
  assert.equal(first.status,200);assert.equal(retry.status,200);assert.equal(retry.value.created,false);assert.equal(retry.value.roomId,first.value.roomId);assert.equal(retry.value.joinCode,first.value.joinCode);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rooms').get().n,1);
 }finally{await f.close();}
});


test('unauthenticated HTTP attempts are rate-limited before session or request parsing', {timeout:10000},async()=>{
 const f=await setup({ip:3,owner:3,session:3});try{
  for(let i=0;i<3;i++)assert.equal((await f.request({cookie:'wrong'},'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()})).status,403);
  const limited=await f.request({cookie:'wrong'},'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()});assert.equal(limited.status,429);assert.equal(limited.value.error,'rate');
 }finally{await f.close();}
});

test('logout during a pending long poll prevents the later response from delivering data', {timeout:10000},async()=>{
 const f=await setup();try{
  const room=(await f.request(f.camera,'/fixture/rooms',{deviceId:f.camera.deviceId,attemptId:randomUUID()})).value,base=`/fixture/rooms/${room.roomId}`,member=x=>({role:x.role,deviceId:x.deviceId});
  await f.request(f.prompter,'/fixture/rooms/join',{roomId:room.roomId,joinCode:room.joinCode,deviceId:f.prompter.deviceId});await f.request(f.camera,base+'/approve',member(f.camera));await f.request(f.prompter,base+'/approve',member(f.prompter));
  const waiting=f.request(f.prompter,base+'/peek',member(f.prompter));await new Promise(resolve=>setTimeout(resolve,50));f.active.delete(f.camera.sessionHash);
  const result=await waiting;assert.equal(result.status,403);assert.equal(result.value.error,'denied');
 }finally{await f.close();}
});


test('logout from a second process fences an already waiting HTTP poll', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-studio-poll-')),path=join(directory,'state.sqlite'),db=new Database(path);db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);
 const ownerHash='a'.repeat(64),camera={cookie:'cam',sessionHash:'b'.repeat(64),deviceId:randomUUID(),role:'camera'},prompter={cookie:'pro',sessionHash:'c'.repeat(64),deviceId:randomUUID(),role:'prompter'};
 db.exec('CREATE TABLE synthetic_sessions(session_hash TEXT PRIMARY KEY,active INTEGER NOT NULL)');const insert=db.prepare('INSERT INTO synthetic_sessions VALUES(?,1)');insert.run(camera.sessionHash);insert.run(prompter.sessionHash);
 const identities=new Map([[camera.cookie,camera],[prompter.cookie,prompter]]),runtimeId=randomUUID(),clock=()=>({runtimeId,wall:1000,tick:1000});
 const auth=(owner,session)=>owner===ownerHash&&db.prepare('SELECT active FROM synthetic_sessions WHERE session_hash=?').get(session)?.active===1;
 const server=createStudioRendezvousHttpFixture({db,getPrincipal:req=>{const item=identities.get(req.headers.cookie);return item?{ownerHash,sessionHash:item.sessionHash}:null;},authorize:auth,clock,serverSecret:randomBytes(32)});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(client,path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie:client.cookie},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 try{
  const room=(await req(camera,'/fixture/rooms',{deviceId:camera.deviceId,attemptId:randomUUID()})).value,url=`/fixture/rooms/${room.roomId}`,member=x=>({deviceId:x.deviceId,role:x.role});
  await req(prompter,'/fixture/rooms/join',{roomId:room.roomId,joinCode:room.joinCode,deviceId:prompter.deviceId});await req(camera,url+'/approve',member(camera));await req(prompter,url+'/approve',member(prompter));
  const pending=req(prompter,url+'/peek',member(prompter));await delay(50);
  const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/studio-revoke-worker.mjs',import.meta.url).pathname],{stdio:['pipe','ignore','ignore']});child.stdin.end(JSON.stringify({path,sessionHash:camera.sessionHash}));const [exitCode]=await once(child,'exit');assert.equal(exitCode,0);
  const result=await pending;assert.equal(result.status,403);assert.equal(result.value.error,'denied');assert.equal(db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
 }finally{await new Promise(resolve=>server.close(resolve));db.close();rmSync(directory,{recursive:true,force:true});}
});
