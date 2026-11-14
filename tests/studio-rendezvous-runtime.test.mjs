import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {initializeStudioRendezvousFixture,createStudioRoomFixture,joinStudioRoomFixture,approveStudioRoomFixture,sendStudioFrameFixture,peekStudioFrameFixture} from '../experiments/studio-rendezvous/core.mjs';
import {initializeStudioRateFixture,admitStudioRateFixture} from '../experiments/studio-rendezvous/rate-limit.mjs';
import {prepareStudioRuntimeFixture,cleanupStudioAttemptsFixture} from '../experiments/studio-rendezvous/runtime.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
function setup(db=new Database(':memory:')){
 db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);initializeStudioRateFixture(db);let boot=randomUUID(),tick=1000;const clock=()=>({runtimeId:boot,tick,wall:tick});prepareStudioRuntimeFixture(db,clock);
 const ownerHash='a'.repeat(64),camera={ownerHash,sessionHash:'b'.repeat(64),deviceId:randomUUID(),attemptId:randomUUID(),role:'camera'},prompter={ownerHash,sessionHash:'c'.repeat(64),deviceId:randomUUID(),role:'prompter'},secret=randomBytes(32),auth=()=>true;
 const ready=()=>{const room=createStudioRoomFixture(db,camera,secret,clock,auth);camera.roomId=room.roomId;prompter.roomId=room.roomId;joinStudioRoomFixture(db,{...prompter,joinCode:room.joinCode},clock,auth);approveStudioRoomFixture(db,camera,clock,auth);approveStudioRoomFixture(db,prompter,clock,auth);return room;};
 return {db,clock,camera,prompter,secret,auth,ready,setBoot:(b,t)=>{boot=b;tick=t;},setTick:t=>{tick=t;}};
}

test('boot transition invalidates rooms, quarantines admission and clears old ephemeral state in batches',()=>{
 const f=setup();try{
  f.ready();sendStudioFrameFixture(f.db,{...f.camera,sequence:1,data:Buffer.from('old')},f.clock,f.auth);assert.equal(admitStudioRateFixture(f.db,{ip:'127.0.0.1'},f.secret,f.clock),true);
  const previous=f.clock(),next=randomUUID();f.setBoot(next,50);const first=prepareStudioRuntimeFixture(f.db,f.clock);assert.equal(first.transitioned,true);assert.equal(first.ready,false);
  assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms').get().closed,1);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_messages').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_attempts').get().n,1);
  assert.equal(admitStudioRateFixture(f.db,{ip:'127.0.0.1'},f.secret,f.clock),false);assert.throws(()=>peekStudioFrameFixture(f.db,f.camera,()=>previous,f.auth));
  f.setTick(10049);assert.equal(prepareStudioRuntimeFixture(f.db,f.clock).ready,false);f.setTick(10050);const recovered=prepareStudioRuntimeFixture(f.db,f.clock);assert.equal(recovered.ready,true);assert.equal(recovered.removedRooms,1);assert.equal(recovered.removedRates,1);
  assert.equal(admitStudioRateFixture(f.db,{ip:'127.0.0.1'},f.secret,f.clock),true);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_attempts').get().n,1);
 }finally{f.db.close();}
});

test('runtime migration refuses unmarked preexisting state without altering it',()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');initializeStudioRendezvousFixture(db);initializeStudioRateFixture(db);
 try{db.prepare('INSERT INTO studio_signal_rates VALUES(?,?,?,?,1,0)').run('ip','a'.repeat(64),randomUUID(),1);assert.throws(()=>prepareStudioRuntimeFixture(db,()=>({runtimeId:randomUUID(),tick:2})),/UNKNOWN_RUNTIME_STATE/);assert.equal(db.prepare('SELECT count(*) n FROM studio_signal_rates').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM studio_signal_runtime').get().n,0);}finally{db.close();}
});

test('foreign runtime cleanup is bounded and does not touch current runtime rows',()=>{
 const f=setup();try{const old=f.clock().runtimeId,insert=f.db.prepare('INSERT INTO studio_signal_rates VALUES(?,?,?,?,1,0)');for(let i=0;i<300;i++)insert.run('ip',i.toString(16).padStart(64,'0'),old,1);
  const boot=randomUUID();f.setBoot(boot,10);assert.equal(prepareStudioRuntimeFixture(f.db,f.clock).ready,false);f.setTick(10010);
  assert.equal(prepareStudioRuntimeFixture(f.db,f.clock).removedRates,128);assert.equal(prepareStudioRuntimeFixture(f.db,f.clock).removedRates,128);assert.equal(prepareStudioRuntimeFixture(f.db,f.clock).removedRates,44);
  assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates WHERE runtime_id=?').get(old).n,0);
 }finally{f.db.close();}
});

test('attempt cleanup requires a permanent session tombstone and no active matching room',()=>{
 const f=setup();try{
  f.db.exec('CREATE TABLE relay_browser_sessions(session_hash TEXT PRIMARY KEY,owner_hash TEXT,revocation_hash TEXT,expired INTEGER); CREATE TABLE auth_session_revocations(session_hash TEXT PRIMARY KEY,revoked_at INTEGER)');
  const room=f.ready(),insertSession=f.db.prepare('INSERT INTO relay_browser_sessions VALUES(?,?,?,?)'),insertAttempt=f.db.prepare('INSERT INTO studio_signal_attempts VALUES(?,?,?,?)'),owner=f.camera.ownerHash;
  insertSession.run(f.camera.sessionHash,owner,'d'.repeat(64),1);const extraSession='e'.repeat(64),activeSession='f'.repeat(64),revokedSession='1'.repeat(64);
  insertSession.run(extraSession,owner,'2'.repeat(64),1);insertSession.run(activeSession,owner,'3'.repeat(64),0);insertSession.run(revokedSession,owner,'4'.repeat(64),0);f.db.prepare('INSERT INTO auth_session_revocations VALUES(?,1)').run('4'.repeat(64));
  insertAttempt.run(owner,extraSession,randomUUID(),randomUUID());insertAttempt.run(owner,activeSession,randomUUID(),randomUUID());insertAttempt.run(owner,revokedSession,randomUUID(),randomUUID());
  assert.equal(cleanupStudioAttemptsFixture(f.db,f.clock,1),1);assert.equal(cleanupStudioAttemptsFixture(f.db,f.clock,32),1);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_attempts').get().n,2);
  assert.ok(f.db.prepare('SELECT 1 FROM studio_signal_attempts WHERE session_hash=?').get(f.camera.sessionHash));assert.ok(f.db.prepare('SELECT 1 FROM studio_signal_attempts WHERE session_hash=?').get(activeSession));assert.equal(f.db.prepare('SELECT closed FROM studio_signal_rooms WHERE room_id=?').get(room.roomId).closed,0);
 }finally{f.db.close();}
});

test('multiple workers adopt one boot transition without extending its quarantine', {timeout:10000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vm-studio-boot-')),path=join(dir,'state.sqlite'),f=setup(new Database(path));
 try{const clock={runtimeId:randomUUID(),tick:50,wall:50},payload=JSON.stringify({path,clock});
  const run=()=>{const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/studio-runtime-worker.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','ignore']});let out='';child.stdout.on('data',x=>{out+=x;});child.stdin.end(payload);return once(child,'exit').then(([code])=>({code,result:code===0?JSON.parse(out):null}));};
  const results=await Promise.all([run(),run(),run()]);assert.ok(results.every(x=>x.code===0&&!x.result.ready));assert.equal(results.filter(x=>x.result.transitioned).length,1);assert.equal(f.db.prepare('SELECT ready_tick FROM studio_signal_runtime').get().ready_tick,10050);
 }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});
