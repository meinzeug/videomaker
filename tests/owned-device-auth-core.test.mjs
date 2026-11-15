import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createOwnedDeviceAuth,initializeOwnedDeviceAuth} from '../experiments/studio-device-http/owned-device-auth-core.mjs';

const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64),ok=()=>true;
function init(db,secret=randomBytes(32)){
 initializeOwnedDeviceAuth(db);const auth=createOwnedDeviceAuth(db,Date.now,secret),device=randomUUID(),project=randomUUID(),foreign=randomUUID();
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pub=keys.publicKey.export({type:'spki',format:'der'});
 db.prepare('INSERT INTO fixture_owned_auth_projects VALUES(?,?,?,?)').run(project,a,b,randomUUID());
 db.prepare('INSERT INTO fixture_owned_auth_projects VALUES(?,?,?,?)').run(foreign,c,d,randomUUID());
 return {db,secret,auth,device,project,foreign,keys,pub};
}
function enroll(f){
 const e=f.auth.beginEnrollment(f.device,f.pub,['projects:read','recordings:upload'],a,b,ok);assert.ok(e);
 const sig=sign('sha256',e.message,f.keys.privateKey);
 assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,c,b,ok),null);
 assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,a,d,ok),null);
 assert.deepEqual(f.auth.completeEnrollment(f.device,e.challengeId,sig,a,b,ok),{enrolled:true});
 assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,a,b,ok),null);
}
function login(f){const challenge=f.auth.beginLogin(f.device);assert.ok(challenge);const proof=sign('sha256',challenge.message,f.keys.privateKey);return {challenge,proof,ticket:f.auth.completeLogin(f.device,challenge.challengeToken,proof)};}

test('owner and workspace bind signed enrollment, revocation and project grants',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  enroll(f);const {challenge,proof,ticket}=login(f);assert.ok(ticket);
  assert.equal(f.auth.completeLogin(f.device,challenge.challengeToken,proof),null);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project,a,b),false);
  assert.equal(f.auth.grantProject(f.device,f.project,c,b,ok),false);
  assert.equal(f.auth.grantProject(f.device,f.project,a,d,ok),false);
  assert.equal(f.auth.grantProject(f.device,f.foreign,a,b,ok),false);
  assert.equal(f.auth.grantProject(f.device,f.project,a,b,ok),true);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project,a,b),true);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project,a,b),true);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.foreign,a,b),false);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project,c,b),false);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project,a,d),false);
  assert.equal(f.auth.permits(ticket.ticket,'admin',f.project,a,b),false);
  assert.equal(f.auth.revoke(f.device,c,b,ok),false);
  assert.equal(f.auth.revoke(f.device,a,d,ok),false);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project,a,b),true);
  assert.equal(f.auth.revokeProject(f.device,f.project,c,b,ok),false);
  assert.equal(f.auth.revokeProject(f.device,f.project,a,b,ok),true);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project,a,b),false);
  assert.equal(f.auth.grantProject(f.device,f.project,a,b,ok),false);
  assert.equal(f.auth.revoke(f.device,a,b,ok),true);
  assert.equal(f.auth.beginLogin(f.device),null);
  assert.throws(()=>db.prepare('UPDATE fixture_owned_auth_devices SET revoked=0 WHERE device_id=?').run(f.device),/revocation retained/);
 }finally{db.close();}
});

test('unbound old fixture identities are not imported or accepted',()=>{
 const db=new Database(':memory:');try{
  db.exec('CREATE TABLE studio_auth_devices(device_id TEXT PRIMARY KEY,public_key BLOB,capabilities TEXT,revoked INTEGER)');
  const id=randomUUID(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pub=keys.publicKey.export({type:'spki',format:'der'});
  db.prepare('INSERT INTO studio_auth_devices VALUES(?,?,?,0)').run(id,pub,'projects:read');
  initializeOwnedDeviceAuth(db);const auth=createOwnedDeviceAuth(db,Date.now,randomBytes(32));
  assert.equal(auth.beginLogin(id),null);assert.equal(db.prepare('SELECT COUNT(*) n FROM studio_auth_devices').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_devices').get().n,0);
 }finally{db.close();}
 const old=new Database(':memory:');try{
  old.exec('CREATE TABLE fixture_owned_auth_devices(device_id TEXT PRIMARY KEY,public_key BLOB,capabilities TEXT,revoked INTEGER)');
  assert.throws(()=>initializeOwnedDeviceAuth(old),/UNOWNED_FIXTURE_SCHEMA_REVIEW_REQUIRED/);
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='fixture_owned_auth_clock'").get().n,0);
 }finally{old.close();}
 const nullable=new Database(':memory:');try{
  nullable.exec('CREATE TABLE fixture_owned_auth_devices(device_id TEXT PRIMARY KEY,public_key BLOB UNIQUE,capabilities TEXT,owner_hash TEXT,workspace_hash TEXT,revoked INTEGER)');
  const device=randomUUID(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  nullable.prepare('INSERT INTO fixture_owned_auth_devices VALUES(?,?,?,NULL,NULL,0)').run(device,keys.publicKey.export({type:'spki',format:'der'}),'projects:read');
  initializeOwnedDeviceAuth(nullable);const auth=createOwnedDeviceAuth(nullable,Date.now,randomBytes(32));
  assert.equal(auth.beginLogin(device),null);assert.equal(auth.revoke(device,a,b,ok),false);
  assert.deepEqual(nullable.prepare('SELECT owner_hash,workspace_hash,revoked FROM fixture_owned_auth_devices WHERE device_id=?').get(device),{owner_hash:null,workspace_hash:null,revoked:0});
 }finally{nullable.close();}
});

test('recreated project does not inherit old grant; revocation works even after project deletion',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  enroll(f);const {ticket}=login(f);assert.equal(f.auth.grantProject(f.device,f.project,a,b,ok),true);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project,a,b),true);
  db.prepare('DELETE FROM fixture_owned_auth_projects WHERE project_id=?').run(f.project);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project,a,b),false);
  db.prepare('INSERT INTO fixture_owned_auth_projects VALUES(?,?,?,?)').run(f.project,a,b,randomUUID());
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project,a,b),false);
  assert.equal(f.auth.grantProject(f.device,f.project,a,b,ok),false);
  db.prepare('DELETE FROM fixture_owned_auth_projects WHERE project_id=?').run(f.project);
  assert.equal(f.auth.revokeProject(f.device,f.project,a,b,ok),true);
 }finally{db.close();}
});

test('reentrant authorization cannot grant a project that changed owner',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  enroll(f);let calls=0;
  const mutate=()=>{if(++calls===3)db.prepare('UPDATE fixture_owned_auth_projects SET owner_hash=? WHERE project_id=?').run(c,f.project);return true;};
  assert.equal(f.auth.grantProject(f.device,f.project,a,b,mutate),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_grants').get().n,0);
 }finally{db.close();}
});

test('two processes consume one owner-bound login proof only once',{timeout:15000},async()=>{
 const root=mkdtempSync('/dev/shm/studio-owned-auth.'),file=join(root,'synthetic.sqlite'),db=new Database(file);db.pragma('synchronous=FULL');
 const f=init(db);enroll(f);const challenge=f.auth.beginLogin(f.device),sig=sign('sha256',challenge.message,f.keys.privateKey);
 const workers=[0,1].map(()=>fork(new URL('./fixtures/owned-device-login-race-worker.mjs',import.meta.url),[file,f.secret.toString('hex'),f.device,challenge.challengeToken,sig.toString('base64url')],{stdio:['ignore','ignore','pipe','ipc']}));
 const exits=workers.map(w=>new Promise(resolve=>w.once('exit',(code,signal)=>resolve({code,signal}))));
 try{
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);} )));
  const replies=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));
  for(const w of workers)w.send('go');const results=await Promise.all(replies);
  assert.equal(results.filter(x=>x.issued===true).length,1);assert.equal(results.filter(x=>x.issued===false).length,1);
 }finally{
  for(const w of workers)if(w.connected)w.disconnect();const stopped=await Promise.all(exits);assert.ok(stopped.every(x=>x.code===0));db.close();
  for(const suffix of ['','-journal','-wal','-shm']){const path=file+suffix;if(existsSync(path))unlinkSync(path);}rmdirSync(root);
 }
});
