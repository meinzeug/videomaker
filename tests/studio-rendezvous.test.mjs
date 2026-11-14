import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {initializeStudioRendezvousFixture,createStudioRoomFixture,joinStudioRoomFixture,approveStudioRoomFixture,studioPairingKeyFixture,sendStudioFrameFixture,peekStudioFrameFixture,acknowledgeStudioFrameFixture,closeStudioRoomFixture,deliverStudioPeekFixture,deliverStudioResultFixture} from '../experiments/studio-rendezvous/core.mjs';
import {fixture} from './fixtures/relay-delivery-fixture.mjs';
import {resolveRelayBrowserSession} from '../lib/relay-browser-sessions.ts';
import {revokeSession} from '../lib/session-revocations.ts';
import {prepareStudioRuntimeFixture} from '../experiments/studio-rendezvous/runtime.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
function setup(db=new Database(':memory:')){
 db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);
 const ownerHash='a'.repeat(64),camera={ownerHash,sessionHash:'b'.repeat(64),deviceId:randomUUID(),role:'camera',attemptId:randomUUID()},prompter={ownerHash,sessionHash:'c'.repeat(64),deviceId:randomUUID(),role:'prompter'},secret=randomBytes(32),runtimeId=randomUUID();let now=1000;const active=new Set([camera.sessionHash,prompter.sessionHash]);
 const clock=()=>({runtimeId,wall:now,tick:now}),auth=(o,s)=>o===ownerHash&&active.has(s);prepareStudioRuntimeFixture(db,clock);
 const open=()=>{camera.attemptId=randomUUID();const room=createStudioRoomFixture(db,camera,secret,clock,auth);camera.roomId=room.roomId;prompter.roomId=room.roomId;return room;};
 const join=room=>joinStudioRoomFixture(db,{...prompter,joinCode:room.joinCode},clock,auth);
 const approve=who=>approveStudioRoomFixture(db,who,clock,auth);
 const key=who=>studioPairingKeyFixture(db,who,secret,clock,auth);
 const send=(who,sequence,data)=>sendStudioFrameFixture(db,{...who,sequence,data:Buffer.from(data)},clock,auth);
 const peek=who=>peekStudioFrameFixture(db,who,clock,auth);
 const ack=(who,sequence)=>acknowledgeStudioFrameFixture(db,{...who,sequence},clock,auth);
 return {db,ownerHash,camera,prompter,clock,auth,secret,active,open,join,approve,key,send,peek,ack,setTime:t=>{now=t;}};
}
function ready(f){const room=f.open();f.join(room);f.approve(f.camera);f.approve(f.prompter);return room;}

test('both distinct authenticated roles must explicitly approve before key or frames',()=>{
 const f=setup();try{const room=f.open();assert.throws(()=>f.key(f.camera));assert.equal(f.join(room).created,true);
  assert.throws(()=>f.send(f.camera,1,'early'));assert.deepEqual(f.approve(f.camera),{ready:false});assert.throws(()=>f.key(f.prompter));
  assert.deepEqual(f.approve(f.prompter),{ready:true});assert.match(f.key(f.camera).token,/^[a-f0-9]{32}$/);assert.equal(f.key(f.camera).token,f.key(f.prompter).token);
 }finally{f.db.close();}
});

test('join code has one owner; exact lost ACK retry is safe, foreign session and role denied',()=>{
 const f=setup();try{const room=f.open();assert.equal(f.join(room).created,true);assert.equal(f.join(room).created,false);
  assert.throws(()=>joinStudioRoomFixture(f.db,{...f.prompter,sessionHash:'d'.repeat(64),joinCode:room.joinCode},f.clock,f.auth));
  assert.throws(()=>joinStudioRoomFixture(f.db,{...f.prompter,deviceId:randomUUID(),joinCode:room.joinCode},f.clock,f.auth));
  assert.throws(()=>f.approve({...f.camera,role:'prompter'}));assert.throws(()=>f.approve({...f.prompter,ownerHash:'e'.repeat(64)}));
 }finally{f.db.close();}
});

test('ordered bounded byte delivery and exact retransmission in both directions',()=>{
 const f=setup();try{ready(f);
  assert.deepEqual(f.send(f.camera,1,'hello'),{sequence:1,created:true});assert.deepEqual(f.send(f.camera,1,'hello'),{sequence:1,created:false});
  assert.throws(()=>f.send(f.camera,1,'changed'));assert.throws(()=>f.send(f.camera,3,'skip'));
  assert.equal(f.peek(f.prompter).data.toString(),'hello');assert.throws(()=>f.ack(f.prompter,2));assert.equal(f.ack(f.prompter,1).created,true);assert.equal(f.ack(f.prompter,1).created,false);assert.deepEqual(f.peek(f.prompter),{empty:true});
  f.send(f.prompter,1,'back');assert.equal(f.peek(f.camera).data.toString(),'back');f.ack(f.camera,1);
  assert.throws(()=>f.send(f.camera,2,Buffer.alloc(16385)));for(let i=2;i<18;i++)f.send(f.camera,i,'x');assert.throws(()=>f.send(f.camera,18,'full'));f.ack(f.prompter,2);assert.equal(f.send(f.camera,18,'space').created,true);
 }finally{f.db.close();}
});

test('either logout closes the room permanently and drains queued bytes',()=>{
 const f=setup();try{ready(f);f.send(f.camera,1,'private');f.active.delete(f.prompter.sessionHash);assert.throws(()=>f.peek(f.camera));assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_messages').get().n,0);
  f.active.add(f.prompter.sessionHash);assert.throws(()=>f.peek(f.prompter));
 }finally{f.db.close();}
});

test('join deadline, room deadline, close and clock rollback do not revive room',()=>{
 for(const mode of ['join','room','close']){
  const f=setup();try{const room=f.open();if(mode==='join'){f.setTime(61000);assert.throws(()=>f.join(room));}else{f.join(room);if(mode==='room'){f.setTime(7_201_000);assert.throws(()=>f.approve(f.camera));}else closeStudioRoomFixture(f.db,f.camera,f.clock,f.auth);}
   f.setTime(1000);assert.throws(()=>f.approve(f.camera));
  }finally{f.db.close();}
 }
});

test('session is rechecked after reentrant callbacks before any key is returned',()=>{
 const f=setup();try{ready(f);let calls=0;const auth=(owner,session)=>{calls++;return calls<3&&f.auth(owner,session);};
  assert.throws(()=>studioPairingKeyFixture(f.db,f.camera,f.secret,f.clock,auth));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
 }finally{f.db.close();}
});

test('caps rooms per owner and cannot run in production',()=>{
 const f=setup();try{f.open();f.open();assert.throws(()=>f.open());process.env.NODE_ENV='production';assert.throws(()=>f.open(),/FIXTURE_DISABLED/);}finally{process.env.NODE_ENV='test';f.db.close();}
});

test('existing browser session resolver enforces completed logout',()=>{
 const f=fixture();try{initializeStudioRendezvousFixture(f.db);const runtimeId=f.db.prepare('SELECT runtime_id FROM relay_session_tokens LIMIT 1').get().runtime_id,clock=()=>({runtimeId,wall:1023,tick:1023});
  prepareStudioRuntimeFixture(f.db,clock);const auth=(owner,session)=>resolveRelayBrowserSession(f.db,f.secret,owner,session,()=>1023),camera={ownerHash:f.owner,sessionHash:f.camera.session,deviceId:randomUUID(),role:'camera',attemptId:randomUUID()},prompter={ownerHash:f.owner,sessionHash:f.prompter.session,deviceId:randomUUID(),role:'prompter'};
  const room=createStudioRoomFixture(f.db,camera,Buffer.alloc(32,1),clock,auth);camera.roomId=room.roomId;prompter.roomId=room.roomId;joinStudioRoomFixture(f.db,{...prompter,joinCode:room.joinCode},clock,auth);approveStudioRoomFixture(f.db,camera,clock,auth);approveStudioRoomFixture(f.db,prompter,clock,auth);
  revokeSession(f.db,f.secret,f.camera.cookie,1024);assert.throws(()=>peekStudioFrameFixture(f.db,prompter,clock,auth));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
 }finally{f.db.close();}
});


test('two processes cannot join one room with different device identities', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-studio-join-')),path=join(directory,'state.sqlite'),f=setup(new Database(path));
 try{
  const room=f.open();const run=()=>{const fields={...f.prompter,deviceId:randomUUID(),joinCode:room.joinCode};const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/studio-join-worker.mjs',import.meta.url).pathname],{stdio:['pipe','ignore','ignore']});child.stdin.end(JSON.stringify({path,fields,clock:f.clock()}));return once(child,'exit').then(([code])=>code);};
  const results=await Promise.all([run(),run()]);assert.equal(results.filter(x=>x===0).length,1);assert.equal(results.filter(x=>x===2).length,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rooms WHERE prompter_session IS NOT NULL').get().n,1);
 }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});


test('secret rotation cannot silently yield different keys to both devices',()=>{
 const f=setup();try{ready(f);const first=f.key(f.camera);assert.throws(()=>studioPairingKeyFixture(f.db,f.prompter,Buffer.alloc(32,9),f.clock,f.auth));assert.equal(f.key(f.prompter).token,first.token);}finally{f.db.close();}
});

test('browser expiry tombstone commits with room closure and cannot revive on clock rollback',()=>{
 const f=fixture();try{
  initializeStudioRendezvousFixture(f.db);const runtimeId=f.db.prepare('SELECT runtime_id FROM relay_session_tokens LIMIT 1').get().runtime_id;let wall=1023;
  const clock=()=>({runtimeId,wall,tick:1023}),auth=(owner,session)=>resolveRelayBrowserSession(f.db,f.secret,owner,session,()=>wall);prepareStudioRuntimeFixture(f.db,clock);
  const camera={ownerHash:f.owner,sessionHash:f.camera.session,deviceId:randomUUID(),role:'camera',attemptId:randomUUID()},secret=Buffer.alloc(32,1),room=createStudioRoomFixture(f.db,camera,secret,clock,auth);camera.roomId=room.roomId;
  wall=10000;assert.throws(()=>peekStudioFrameFixture(f.db,camera,clock,auth));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
  assert.equal(f.db.prepare('SELECT expired FROM relay_browser_sessions WHERE session_hash=?').get(f.camera.session).expired,1);
  wall=1023;assert.throws(()=>peekStudioFrameFixture(f.db,camera,clock,auth));
 }finally{f.db.close();}
});

test('resolver exception fails closed and commits room shutdown',()=>{
 const f=setup();try{ready(f);assert.throws(()=>studioPairingKeyFixture(f.db,f.camera,f.secret,f.clock,()=>{throw Error('resolver error');}));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);assert.throws(()=>f.key(f.camera));}finally{f.db.close();}
});


test('lost create response is idempotently recoverable without extending QR expiry',()=>{
 const f=setup();try{
  const original=f.open(),same=()=>createStudioRoomFixture(f.db,f.camera,f.secret,f.clock,f.auth);f.setTime(11000);const retry=same();
  assert.equal(retry.roomId,original.roomId);assert.equal(retry.joinCode,original.joinCode);assert.equal(retry.created,false);assert.equal(retry.expiresInMs,50000);
  assert.throws(()=>createStudioRoomFixture(f.db,{...f.camera,deviceId:randomUUID()},f.secret,f.clock,f.auth));
  f.setTime(61000);assert.throws(same);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rooms').get().n,0);
  assert.throws(same);assert.notEqual(f.open().roomId,original.roomId);
 }finally{f.db.close();}
});

test('slow create authorization cannot extend its QR lease',()=>{
 const f=setup();try{
  const attempt={...f.camera,attemptId:randomUUID()};let calls=0;const slowly=()=>{calls++;return {...f.clock(),wall:1000+calls*1000,tick:1000+calls*1000};};
  const created=createStudioRoomFixture(f.db,attempt,f.secret,slowly,f.auth);assert.ok(created.expiresInMs<60000&&created.expiresInMs>0);
 }finally{f.db.close();}
});

test('a late replayed join cannot close an already joined active room',()=>{
 const f=setup();try{const room=ready(f);f.setTime(61000);assert.throws(()=>f.join(room));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,0);assert.equal(f.send(f.camera,1,'still-alive').created,true);}finally{f.db.close();}
});

test('a foreign runtime cannot close or mutate an existing room',()=>{
 const f=setup();try{ready(f);const foreign=()=>({...f.clock(),runtimeId:randomUUID()});assert.throws(()=>peekStudioFrameFixture(f.db,f.camera,foreign,f.auth));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,0);assert.equal(f.send(f.camera,1,'still-alive').created,true);}finally{f.db.close();}
});

test('logout between queue insertion and final authorization discards data and closes room',()=>{
 const f=setup();try{ready(f);let calls=0;const auth=(owner,session)=>++calls<=4&&f.auth(owner,session);
  assert.throws(()=>sendStudioFrameFixture(f.db,{...f.camera,sequence:1,data:Buffer.from('private')},f.clock,auth));
  assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_messages').get().n,0);assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
 }finally{f.db.close();}
});

test('concurrent identical create retries yield one room and the same code', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-studio-create-')),path=join(directory,'state.sqlite'),f=setup(new Database(path));
 try{
  f.camera.attemptId=randomUUID();const payload=JSON.stringify({path,camera:f.camera,secret:f.secret.toString('base64'),clock:f.clock()});
  const run=()=>{const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/studio-create-worker.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','ignore']});let out='';child.stdout.on('data',block=>{out+=block;});child.stdin.end(payload);return once(child,'exit').then(([code])=>({code,out:code===0?JSON.parse(out):null}));};
  const result=await Promise.all([run(),run(),run()]);assert.ok(result.every(x=>x.code===0));assert.equal(new Set(result.map(x=>x.out.roomId)).size,1);assert.equal(new Set(result.map(x=>x.out.codeHash)).size,1);assert.equal(result.filter(x=>x.out.created).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rooms').get().n,1);
 }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});


test('fenced peek rechecks both sessions and never calls the writer after logout',()=>{
 const f=setup();try{ready(f);f.send(f.camera,1,'sensitive');f.active.delete(f.camera.sessionHash);let called=false;
  assert.throws(()=>deliverStudioPeekFixture(f.db,f.prompter,f.clock,f.auth,()=>{called=true;return true;}));assert.equal(called,false);assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
 }finally{f.db.close();}
});

test('fenced peek refuses an asynchronous delivery callback',()=>{
 const f=setup();try{ready(f);assert.throws(()=>deliverStudioPeekFixture(f.db,f.prompter,f.clock,f.auth,()=>Promise.resolve(true)));}finally{f.db.close();}
});


test('a computed key is never written if either session logs out before the response fence',()=>{
 const f=setup();try{ready(f);const value=f.key(f.camera);assert.ok(value.token);f.active.delete(f.prompter.sessionHash);let delivered=false;
  assert.throws(()=>deliverStudioResultFixture(f.db,f.camera,f.clock,f.auth,()=>{delivered=true;return true;}));assert.equal(delivered,false);assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);
 }finally{f.db.close();}
});

test('fault injection documents that queued bytes cannot be retracted after a commit failure',()=>{
 const f=setup();try{
  ready(f);f.db.exec('CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(parent INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED)');let queued=false;
  assert.throws(()=>deliverStudioResultFixture(f.db,f.camera,f.clock,f.auth,()=>{f.db.prepare('INSERT INTO fixture_child VALUES(42)').run();queued=true;return true;}));
  assert.equal(queued,true);assert.equal(f.db.prepare('SELECT count(*) n FROM fixture_child').get().n,0);
 }finally{f.db.close();}
});
