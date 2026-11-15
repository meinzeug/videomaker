import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createOwnedDeviceAuth,createSyntheticOwnedProject,initializeOwnedDeviceAuth} from '../experiments/studio-device-http/owned-device-auth-core.mjs';

const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64);
const hash=x=>createHash('sha256').update(x).digest('hex');
function init(db,secret=randomBytes(32),clock=Date.now,sessionExpiry=Date.now()+600_000){
 initializeOwnedDeviceAuth(db);const auth=createOwnedDeviceAuth(db,clock,secret),device=randomUUID(),project=randomUUID(),foreign=randomUUID();
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pub=keys.publicKey.export({type:'spki',format:'der'});
 createSyntheticOwnedProject(db,project,a,b);
 createSyntheticOwnedProject(db,foreign,c,d);
 const primary=randomBytes(32).toString('base64url'),wrongOwner=randomBytes(32).toString('base64url'),wrongWorkspace=randomBytes(32).toString('base64url');
 const add=db.prepare('INSERT INTO fixture_owned_auth_sessions VALUES(?,?,?,?,0)');
 for(const [token,owner,workspace] of [[primary,a,b],[wrongOwner,c,b],[wrongWorkspace,a,d]])add.run(hash(token),owner,workspace,sessionExpiry);
 return {db,secret,auth,device,project,foreign,keys,pub,primary,wrongOwner,wrongWorkspace};
}
function enroll(f){
 const e=f.auth.beginEnrollment(f.device,f.pub,['projects:read','recordings:upload'],f.primary);assert.ok(e);
 const sig=sign('sha256',e.message,f.keys.privateKey);
 assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.wrongOwner),null);
 assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.wrongWorkspace),null);
 assert.deepEqual(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.primary),{enrolled:true});
 assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.primary),null);
}
function login(f){const challenge=f.auth.beginLogin(f.device);assert.ok(challenge);const proof=sign('sha256',challenge.message,f.keys.privateKey);return {challenge,proof,ticket:f.auth.completeLogin(f.device,challenge.challengeToken,proof)};}

test('owner and workspace bind signed enrollment, revocation and project grants',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  enroll(f);const {challenge,proof,ticket}=login(f);assert.ok(ticket);
  assert.equal(f.auth.completeLogin(f.device,challenge.challengeToken,proof),null);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project),false);
  assert.equal(f.auth.grantProject(f.device,f.project,f.wrongOwner),false);
  assert.equal(f.auth.grantProject(f.device,f.project,f.wrongWorkspace),false);
  assert.equal(f.auth.grantProject(f.device,f.foreign,f.primary),false);
  assert.equal(f.auth.grantProject(f.device,f.project,f.primary),true);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project),true);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project),true);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.foreign),false);
  assert.equal(f.auth.permits(ticket.ticket,'admin',f.project),false);
  assert.equal(f.auth.revoke(f.device,f.wrongOwner),false);
  assert.equal(f.auth.revoke(f.device,f.wrongWorkspace),false);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project),true);
  assert.equal(f.auth.revokeProject(f.device,f.project,f.wrongOwner),false);
  assert.equal(f.auth.revokeProject(f.device,f.project,f.primary),true);
  assert.equal(f.auth.permits(ticket.ticket,'recordings:upload',f.project),false);
  assert.equal(f.auth.grantProject(f.device,f.project,f.primary),false);
  assert.equal(f.auth.revoke(f.device,f.primary),true);
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
  assert.equal(auth.beginLogin(device),null);assert.equal(auth.revoke(device,randomBytes(32).toString('base64url')),false);
  assert.deepEqual(nullable.prepare('SELECT owner_hash,workspace_hash,revoked FROM fixture_owned_auth_devices WHERE device_id=?').get(device),{owner_hash:null,workspace_hash:null,revoked:0});
 }finally{nullable.close();}
});

test('recreated project does not inherit old grant; revocation works even after project deletion',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  enroll(f);const {ticket}=login(f);assert.equal(f.auth.grantProject(f.device,f.project,f.primary),true);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project),true);
  const oldEpoch=db.prepare('SELECT project_epoch FROM fixture_owned_auth_projects WHERE project_id=?').get(f.project).project_epoch;
  db.prepare('DELETE FROM fixture_owned_auth_projects WHERE project_id=?').run(f.project);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project),false);
  assert.throws(()=>db.prepare('INSERT INTO fixture_owned_auth_projects VALUES(?,?,?,?)').run(f.project,a,b,oldEpoch),/project epoch invalid/);
  assert.throws(()=>db.prepare('UPDATE fixture_owned_auth_project_epochs SET used=0 WHERE project_epoch=?').run(oldEpoch),/project epoch consumed/);
  assert.throws(()=>db.prepare('DELETE FROM fixture_owned_auth_project_epochs WHERE project_epoch=?').run(oldEpoch),/project epoch retained/);
  const rowid=db.prepare('SELECT rowid FROM fixture_owned_auth_project_epochs WHERE project_epoch=?').get(oldEpoch).rowid;
  assert.throws(()=>db.prepare('INSERT OR REPLACE INTO fixture_owned_auth_project_epochs(rowid,project_epoch,project_id,owner_hash,workspace_hash,used) VALUES(?,?,?,?,?,0)').run(rowid,randomUUID(),f.project,a,b),/project epoch exists/);
  createSyntheticOwnedProject(db,f.project,a,b);
  assert.equal(f.auth.permits(ticket.ticket,'projects:read',f.project),false);
  assert.equal(f.auth.grantProject(f.device,f.project,f.primary),false);
  db.prepare('DELETE FROM fixture_owned_auth_projects WHERE project_id=?').run(f.project);
  assert.equal(f.auth.revokeProject(f.device,f.project,f.primary),true);
 }finally{db.close();}
});

test('project owner and epoch cannot be altered after creation',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  enroll(f);
  assert.throws(()=>db.prepare('UPDATE fixture_owned_auth_projects SET owner_hash=? WHERE project_id=?').run(c,f.project),/project identity immutable/);
  assert.throws(()=>db.prepare('UPDATE fixture_owned_auth_projects SET project_epoch=? WHERE project_id=?').run(randomUUID(),f.project),/project identity immutable/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_grants').get().n,0);
 }finally{db.close();}
});

test('enrollment expires during final work and cannot be revived by clock rollback',()=>{
 const db=new Database(':memory:');let now=1000,calls=0,advance=false;
 try{
  const f=init(db,randomBytes(32),()=>{calls++;if(advance&&calls===3)now=61001;return now;},100_000);
  const e=f.auth.beginEnrollment(f.device,f.pub,['projects:read'],f.primary);assert.ok(e);
  const sig=sign('sha256',e.message,f.keys.privateKey);calls=0;advance=true;
  assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.primary),null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_devices').get().n,0);
  assert.equal(db.prepare('SELECT floor_ms FROM fixture_owned_auth_clock').get().floor_ms,61001);
  advance=false;now=1000;assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.primary),null);
 }finally{db.close();}
});

test('session expiry during grant rolls back the grant and persists observed time',()=>{
 const db=new Database(':memory:');let now=1000,calls=0,advance=false;
 try{
  const f=init(db,randomBytes(32),()=>{calls++;if(advance&&calls===2)now=2001;return now;},2000);
  enroll(f);calls=0;advance=true;
  assert.equal(f.auth.grantProject(f.device,f.project,f.primary),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_grants').get().n,0);
  assert.equal(db.prepare('SELECT floor_ms FROM fixture_owned_auth_clock').get().floor_ms,2001);
 }finally{db.close();}
});

test('session expiry during device or grant revoke rolls back the attempted mutation',()=>{
 for(const mode of ['device','project']){
  const db=new Database(':memory:');let now=1000,calls=0,advance=false;
  try{
   const f=init(db,randomBytes(32),()=>{calls++;if(advance&&calls===2)now=2001;return now;},2000);
   enroll(f);assert.equal(f.auth.grantProject(f.device,f.project,f.primary),true);const {ticket}=login(f);assert.ok(ticket);
   calls=0;advance=true;
   assert.equal(mode==='device'?f.auth.revoke(f.device,f.primary):f.auth.revokeProject(f.device,f.project,f.primary),false);
   assert.equal(db.prepare('SELECT revoked FROM fixture_owned_auth_devices WHERE device_id=?').get(f.device).revoked,0);
   assert.equal(db.prepare('SELECT revoked FROM fixture_owned_auth_grants WHERE device_id=? AND project_id=?').get(f.device,f.project).revoked,0);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_tickets').get().n,1);
   assert.equal(db.prepare('SELECT floor_ms FROM fixture_owned_auth_clock').get().floor_ms,2001);
  }finally{db.close();}
 }
});

test('session expiry during enrollment completion leaves no bound device',()=>{
 const db=new Database(':memory:');let now=1000,calls=0,advance=false;
 try{
  const f=init(db,randomBytes(32),()=>{calls++;if(advance&&calls===3)now=2001;return now;},2000);
  const e=f.auth.beginEnrollment(f.device,f.pub,['projects:read'],f.primary);assert.ok(e);
  const sig=sign('sha256',e.message,f.keys.privateKey);calls=0;advance=true;
  assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.primary),null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_devices').get().n,0);
  assert.equal(db.prepare('SELECT floor_ms FROM fixture_owned_auth_clock').get().floor_ms,2001);
 }finally{db.close();}
});

test('browser logout invalidates pending enrollment even for same owner and workspace',()=>{
 const db=new Database(':memory:'),f=init(db);try{
  const second=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO fixture_owned_auth_sessions VALUES(?,?,?,?,0)').run(hash(second),a,b,Date.now()+600_000);
  const e=f.auth.beginEnrollment(f.device,f.pub,['projects:read'],f.primary);assert.ok(e);
  const sig=sign('sha256',e.message,f.keys.privateKey);
  assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,second),null);
  assert.equal(f.auth.logoutSession(f.primary),true);
  assert.equal(f.auth.completeEnrollment(f.device,e.challengeId,sig,f.primary),null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_owned_auth_devices').get().n,0);
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
