import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,claimCameraProject,assertCameraProjectDeletable,closeCameraProjectClaim} from '../lib/camera-project-claims.ts';
import {ensureLanCaptureProject,initializeLanCaptureProjects} from '../lib/lan-capture-project.ts';
function setup(){const db=new Database(':memory:');db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);const project=randomUUID(),device=randomUUID(),take=randomUUID();db.prepare('INSERT INTO projects VALUES(?)').run(project);return {db,project,device,take};}
test('a project claim and deletion guard work only inside the caller transaction',()=>{
 const {db,project,device,take}=setup();assert.throws(()=>claimCameraProject(db,take,device,project,100),/[Tt]ransaktion/);
 assert.throws(()=>assertCameraProjectDeletable(db,project),/[Tt]ransaktion/);
 db.transaction(()=>{assert.equal(claimCameraProject(db,take,device,project,100),true);assert.equal(claimCameraProject(db,take,device,project,101),false);}).immediate();
 assert.throws(()=>db.transaction(()=>{assertCameraProjectDeletable(db,project);db.prepare('DELETE FROM projects WHERE id=?').run(project);}).immediate(),/noch nicht abgeschlossen/);
 assert.ok(db.prepare('SELECT 1 FROM projects WHERE id=?').get(project));
 assert.throws(()=>db.transaction(()=>closeCameraProjectClaim(db,take,randomUUID(),project,110)).immediate(),/nicht gefunden/);
 db.transaction(()=>closeCameraProjectClaim(db,take,device,project,110)).immediate();
 db.transaction(()=>{assertCameraProjectDeletable(db,project);db.prepare('DELETE FROM projects WHERE id=?').run(project);}).immediate();
 assert.throws(()=>db.transaction(()=>claimCameraProject(db,take,device,project,120)).immediate(),/abgeschlossen/);
 assert.throws(()=>db.prepare('DELETE FROM camera_project_claims').run(),/cannot be deleted/);
 db.close();
});
test('rollback removes a start claim and a missing project cannot be claimed',()=>{
 const {db,project,device,take}=setup();
 assert.throws(()=>db.transaction(()=>{claimCameraProject(db,take,device,project,100);throw Error('command failed');}).immediate(),/command failed/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_claims').get().n,0);
 assert.throws(()=>db.transaction(()=>claimCameraProject(db,take,device,randomUUID(),100)).immediate(),/nicht gefunden/);
 db.transaction(()=>assertCameraProjectDeletable(db,project)).immediate();db.close();
});
test('an immediate deletion transaction cannot interleave with a competing start',()=>{
 const folder=mkdtempSync(join(tmpdir(),'camera-claim-'));
 try{
  const path=join(folder,'fixture.db'),db=new Database(path),other=new Database(path),project=randomUUID();
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);db.prepare('INSERT INTO projects VALUES(?)').run(project);
  other.pragma('busy_timeout = 0');
  db.transaction(()=>{
   assertCameraProjectDeletable(db,project);
   assert.throws(()=>other.transaction(()=>claimCameraProject(other,randomUUID(),randomUUID(),project,1)).immediate(),/locked/);
   db.prepare('DELETE FROM projects WHERE id=?').run(project);
  }).immediate();
  assert.throws(()=>other.transaction(()=>claimCameraProject(other,randomUUID(),randomUUID(),project,2)).immediate(),/nicht gefunden/);
  other.close();db.close();
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test('LAN-Zuordnung sperrt eine spätere Webkamera-Belegung derselben Aufnahme-ID',()=>{
 const {db,project,device,take}=setup();
 try{
  // This fixture's simple projects table needs the fields used by neutral LAN projects.
  db.exec('ALTER TABLE projects ADD COLUMN created_at TEXT; ALTER TABLE projects ADD COLUMN title TEXT; ALTER TABLE projects ADD COLUMN sources TEXT; ALTER TABLE projects ADD COLUMN content TEXT');
  initializeLanCaptureProjects(db);const neutral=ensureLanCaptureProject(db,take,()=>{});assert.ok(neutral.projectId);
  assert.throws(()=>db.transaction(()=>claimCameraProject(db,take.toUpperCase(),device,project,100)).immediate(),/LAN-Aufnahme/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_claims').get().n,0);
 }finally{db.close();}
});
test('gleichzeitige LAN- und Webkameraansprüche können nicht beide dieselbe Aufnahme-ID belegen',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'lan-web-claim-race-')),file=join(directory,'fixture.sqlite'),db=new Database(file),workers=[];
 try{
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,created_at TEXT,title TEXT,sources TEXT,content TEXT)');db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);initializeLanCaptureProjects(db);
  const project=randomUUID(),device=randomUUID(),recording=randomUUID();db.prepare('INSERT INTO projects(id) VALUES(?)').run(project);
  const script=new URL('./fixtures/lan-web-claim-race-worker.mjs',import.meta.url);
  for(const kind of ['lan','web'])workers.push(fork(script,[file,recording,project,device,kind],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',value=>value==='ready'?resolve():reject(Error('Worker nicht bereit')));} )));
  const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(Error('Worker fehlgeschlagen'));});}));
  for(const worker of workers)worker.send('go');const replies=await Promise.all(pending);
  assert.deepEqual(replies.map(item=>item.result).sort(),['created','rejected']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_project_claims').get().n+db.prepare('SELECT count(*) AS n FROM lan_capture_projects').get().n,1);
 }finally{for(const worker of workers)if(worker.connected)worker.disconnect();db.close();rmSync(directory,{recursive:true,force:true});}
});
