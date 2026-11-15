import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createStudioDeviceAuth,initializeStudioDeviceAuth} from '../lib/studio-device-auth-core.mjs';
import {commitSyntheticUpload} from '../experiments/studio-device-http/fixture-commit-fence.mjs';

function setup(scope=['recordings:upload']){
 const db=new Database(':memory:');initializeStudioDeviceAuth(db);
 db.exec('CREATE TABLE fixture_projects(id TEXT PRIMARY KEY); CREATE TABLE fixture_upload_publications(recording_id TEXT PRIMARY KEY,project_id TEXT,size INTEGER,sha256 TEXT)');
 let now=1_000_000;const auth=createStudioDeviceAuth(db,()=>now,randomBytes(32));
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),device=randomUUID(),publicKey=keys.publicKey.export({format:'der',type:'spki'}),owner='a'.repeat(64);
 const enrollment=auth.beginEnrollment(device,publicKey,scope,owner,()=>true);
 assert.ok(auth.completeEnrollment(device,enrollment.challengeId,sign('sha256',enrollment.message,keys.privateKey),owner,()=>true));
 const challenge=auth.beginLogin(device),ticket=auth.completeLogin(device,challenge.challengeToken,sign('sha256',challenge.message,keys.privateKey));
 const project=randomUUID();db.prepare('INSERT INTO fixture_projects VALUES(?)').run(project);
 return {db,auth,device,project,ticket:ticket.ticket,now:()=>now,at(value){now=value;},close(){db.close();}};
}
test('scoped ticket gates one immutable synthetic mutation and revoke blocks retries',()=>{
 const f=setup(),recording=randomUUID(),checksum='a'.repeat(64);try{
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,recording,123,checksum,f.now),'created');
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,recording,123,checksum,f.now),'replayed');
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,recording,124,checksum,f.now),'conflict');
  assert.throws(()=>f.db.transaction(()=>commitSyntheticUpload(f.db,f.ticket,f.project,recording,123,checksum,f.now))(),/outer transaction forbidden/);
  assert.equal(f.auth.revoke(f.device,()=>true),true);
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,recording,123,checksum,f.now),'denied');
  assert.equal(f.db.prepare('SELECT count(*) n FROM fixture_upload_publications').get().n,1);
 }finally{f.close();}
});
test('read-only scope and absent/expired ticket cannot publish',()=>{
 const f=setup(['projects:read']);try{
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,randomUUID(),123,'a'.repeat(64),f.now),'denied');
  assert.equal(f.db.prepare('SELECT count(*) n FROM fixture_upload_publications').get().n,0);
 }finally{f.close();}
});
test('expiry during synthetic commit rolls back row and persists clock floor across rollback',()=>{
 const f=setup(),recording=randomUUID(),expires=1_300_000;let calls=0;
 try{
  const clock=()=>++calls===1?expires-1:expires+1;
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,recording,123,'a'.repeat(64),clock),'denied');
  assert.equal(f.db.prepare('SELECT count(*) n FROM fixture_upload_publications').get().n,0);
  assert.equal(f.db.prepare('SELECT floor_ms FROM studio_auth_clock WHERE id=1').get().floor_ms,expires+1);
  f.at(expires-1);
  assert.equal(commitSyntheticUpload(f.db,f.ticket,f.project,recording,123,'a'.repeat(64),f.now),'denied');
 }finally{f.close();}
});

test('two processes serialize synthetic commit against device revocation',{timeout:15000},async()=>{
 const root=mkdtempSync('/dev/shm/studio-commit-race.'),file=join(root,'synthetic.sqlite'),db=new Database(file);
 db.pragma('synchronous=FULL');initializeStudioDeviceAuth(db);
 db.exec('CREATE TABLE fixture_projects(id TEXT PRIMARY KEY); CREATE TABLE fixture_upload_publications(recording_id TEXT PRIMARY KEY,project_id TEXT,size INTEGER,sha256 TEXT)');
 const secret=randomBytes(32),auth=createStudioDeviceAuth(db,Date.now,secret),device=randomUUID(),project=randomUUID(),recording=randomUUID();
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=keys.publicKey.export({format:'der',type:'spki'}),owner='a'.repeat(64);
 const enrollment=auth.beginEnrollment(device,publicKey,['recordings:upload'],owner,()=>true);
 assert.ok(auth.completeEnrollment(device,enrollment.challengeId,sign('sha256',enrollment.message,keys.privateKey),owner,()=>true));
 const challenge=auth.beginLogin(device),ticket=auth.completeLogin(device,challenge.challengeToken,sign('sha256',challenge.message,keys.privateKey)).ticket;
 db.prepare('INSERT INTO fixture_projects VALUES(?)').run(project);
 const workers=['commit','revoke'].map(mode=>fork(new URL('./fixtures/studio-device-commit-race-worker.mjs',import.meta.url),[file,mode,ticket,project,recording,device,secret.toString('hex')],{stdio:['ignore','ignore','pipe','ipc']}));
 const exits=workers.map(w=>new Promise(resolve=>w.once('exit',(code,signal)=>resolve({code,signal}))));
 try{
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);})));
  const replies=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));
  for(const w of workers)w.send('go');const [commit,revoke]=await Promise.all(replies);
  assert.equal(revoke.result,true);assert.ok(['created','denied'].includes(commit.result),JSON.stringify(commit));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_upload_publications').get().n,commit.result==='created'?1:0);
  assert.equal(commitSyntheticUpload(db,ticket,project,recording,123,'a'.repeat(64)),'denied');
 }finally{
  for(const w of workers)if(w.connected)w.disconnect();
  const stopped=await Promise.all(exits);assert.ok(stopped.every(x=>x.code===0),JSON.stringify(stopped));db.close();
  for(const suffix of ['','-journal','-wal','-shm']){const p=file+suffix;if(existsSync(p))unlinkSync(p);}rmdirSync(root);
 }
});
