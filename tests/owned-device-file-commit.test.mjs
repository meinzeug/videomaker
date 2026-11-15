import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,rmdirSync,unlinkSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createOwnedDeviceAuth,createSyntheticOwnedProject,initializeOwnedDeviceAuth} from '../experiments/studio-device-http/owned-device-auth-core.mjs';
import {commitOwnedSyntheticFile} from '../experiments/studio-device-http/owned-fixture-file-commit.mjs';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64),hash=x=>createHash('sha256').update(x).digest('hex');
function setup(){
 const root=mkdtempSync('/dev/shm/studio-file-commit.'),file=join(root,'synthetic.sqlite');writeFileSync(join(root,'.fixture'),'synthetic-device-file-commit\n');
 const db=new Database(file);db.pragma('synchronous=FULL');initializeOwnedDeviceAuth(db);
 db.exec('CREATE TABLE fixture_file_publications(recording_id TEXT PRIMARY KEY,project_id TEXT,size INTEGER,sha256 TEXT,owner_hash TEXT,workspace_hash TEXT,project_epoch TEXT); CREATE TABLE fixture_file_tombstones(recording_id TEXT PRIMARY KEY)');
 const secret=randomBytes(32),auth=createOwnedDeviceAuth(db,Date.now,secret),device=randomUUID(),project=randomUUID(),foreign=randomUUID(),recording=randomUUID(),session=randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO fixture_owned_auth_sessions VALUES(?,?,?,?,0)').run(hash(session),a,b,Date.now()+600_000);
 createSyntheticOwnedProject(db,project,a,b);createSyntheticOwnedProject(db,foreign,c,d);
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=keys.publicKey.export({format:'der',type:'spki'});
 const e=auth.beginEnrollment(device,publicKey,['recordings:upload'],session);assert.ok(e);assert.ok(auth.completeEnrollment(device,e.challengeId,sign('sha256',e.message,keys.privateKey),session));
 const challenge=auth.beginLogin(device),ticket=auth.completeLogin(device,challenge.challengeToken,sign('sha256',challenge.message,keys.privateKey)).ticket;
 return {root,db,secret,auth,device,project,foreign,recording,session,ticket,bytes:Buffer.from('synthetic recording'),
 close(){db.close();for(const name of readdirSync(root)){if(!/^((\.fixture)|(synthetic\.sqlite(-journal|-wal|-shm)?)|(stage-[0-9a-f-]{36})|([0-9a-f-]{36}\.fixture))$/.test(name))throw Error(`unknown fixture file ${name}`);unlinkSync(join(root,name));}rmdirSync(root);}};
}
const args=(f,extra={})=>({root:f.root,ticket:f.ticket,project:f.project,recording:f.recording,bytes:f.bytes,...extra});
const grant=f=>assert.equal(f.auth.grantProject(f.device,f.project,f.session),true);
const target=f=>join(f.root,`${f.recording}.fixture`);
function worker(f,mode){const process=fork(new URL('./fixtures/owned-device-file-race-worker.mjs',import.meta.url),[f.root,mode,f.ticket,f.project,f.recording,f.device,f.secret.toString('hex'),f.session],{stdio:['ignore','ignore','pipe','ipc']});return {process,ready:new Promise((resolve,reject)=>{process.once('message',resolve);process.once('error',reject);}),exited:new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal})))};}

test('publication requires exact live device grant and retains project epoch on receipt',()=>{
 const f=setup();try{
  assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'denied');assert.equal(commitOwnedSyntheticFile(f.db,args(f,{project:f.foreign})),'denied');grant(f);
  assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'created');assert.deepEqual(readFileSync(target(f)),f.bytes);assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'replayed');
  f.db.prepare('DELETE FROM fixture_owned_auth_projects WHERE project_id=?').run(f.project);createSyntheticOwnedProject(f.db,f.project,a,b);
  assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'denied');assert.deepEqual(readFileSync(target(f)),f.bytes);
 }finally{f.close();}
});
test('invalid tickets, tombstones and changed bytes fail closed without overwriting',()=>{
 const f=setup();try{grant(f);
  assert.equal(commitOwnedSyntheticFile(f.db,args(f,{ticket:randomBytes(32).toString('base64url')})),'denied');
  f.db.prepare('INSERT INTO fixture_file_tombstones VALUES(?)').run(f.recording);
  assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'deleted');assert.equal(existsSync(target(f)),false);
  f.db.prepare('DELETE FROM fixture_file_tombstones WHERE recording_id=?').run(f.recording);
  assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'created');
  writeFileSync(target(f),'changed synthetic bytes');assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'uncertain');
  assert.equal(readFileSync(target(f),'utf8'),'changed synthetic bytes');
 }finally{f.close();}
});
test('expiry or project revocation after link denies and removes only own link',()=>{
 for(const change of ['expiry','grant','device','delete-project']){const f=setup();try{grant(f);let calls=0;const expiry=f.db.prepare('SELECT expires_ms FROM fixture_owned_auth_tickets WHERE ticket_hash=?').get(hash(f.ticket)).expires_ms;
  const clock=()=>{if(++calls===2){if(change==='grant')f.db.prepare('UPDATE fixture_owned_auth_grants SET revoked=1 WHERE device_id=? AND project_id=?').run(f.device,f.project);if(change==='device')f.db.prepare('UPDATE fixture_owned_auth_devices SET revoked=1 WHERE device_id=?').run(f.device);if(change==='delete-project')f.db.prepare('DELETE FROM fixture_owned_auth_projects WHERE project_id=?').run(f.project);return change==='expiry'?expiry+1:Date.now();}return Date.now();};
  assert.equal(commitOwnedSyntheticFile(f.db,args(f,{clock})),'denied');assert.equal(existsSync(target(f)),false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_file_publications').get().n,0);
 }finally{f.close();}}
});
test('device and project revocation serialize with commit across processes',{timeout:15000},async()=>{
 for(const mode of ['revoke-device','revoke-project']){const f=setup();grant(f);const workers=[worker(f,'commit'),worker(f,mode)];try{
  await Promise.all(workers.map(w=>w.ready));const replies=workers.map(w=>new Promise((resolve,reject)=>{w.process.once('message',resolve);w.process.once('error',reject);}));for(const w of workers)w.process.send('go');
  const [commit,revoke]=await Promise.all(replies);assert.equal(revoke.result,true);assert.ok(['created','denied'].includes(commit.result),JSON.stringify(commit));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_file_publications').get().n,commit.result==='created'?1:0);assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'denied');
 }finally{for(const w of workers)if(w.process.connected)w.process.disconnect();await Promise.all(workers.map(w=>w.exited));f.close();}}
});
test('crash after file link never automatically adopts an uncommitted file',{timeout:15000},async()=>{
 const f=setup();grant(f);const w=worker(f,'crash');try{await w.ready;w.process.send('go');assert.equal((await w.exited).signal,'SIGKILL');assert.deepEqual(readFileSync(target(f)),f.bytes);assert.equal(commitOwnedSyntheticFile(f.db,args(f)),'uncertain');assert.deepEqual(readFileSync(target(f)),f.bytes);}finally{if(w.process.connected)w.process.disconnect();f.close();}
});
