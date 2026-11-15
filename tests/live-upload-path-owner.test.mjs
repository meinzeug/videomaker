import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,cameraUploadIdFor,claimCameraProject} from '../lib/camera-project-claims.ts';
import {claimUploadPath,initializeUploadPathOwners} from '../lib/live-upload-path-owner.ts';
import {ensureLanCaptureProject} from '../lib/lan-capture-project.ts';

function fixture(){
 const directory=mkdtempSync(path.join(tmpdir(),'live-owner-test-'));
 const filename=path.join(directory,'synthetic.sqlite'),db=new Database(filename);
 db.pragma('synchronous=FULL');db.transaction(()=>initializeUploadPathOwners(db)).immediate();
 return {directory,filename,db,close(){db.close();unlinkSync(filename);rmdirSync(directory);}};
}
const tx=(db,r,p,u,mode)=>db.transaction(()=>claimUploadPath(db,r,p,u,mode)).immediate();
test('unsichere SQLite-Dauerhaftigkeit wird abgewiesen',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p);
 try{
  for(const sync of ['OFF','NORMAL']){
   f.db.pragma(`synchronous=${sync}`);
   assert.throws(()=>tx(f.db,r,p,u,'live'),/UNSAFE_SQLITE_DURABILITY/);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,0);
  f.db.pragma('synchronous=FULL');
  for(const mode of ['MEMORY','OFF']){
   f.db.pragma(`journal_mode=${mode}`);
   assert.throws(()=>tx(f.db,r,p,u,'full'),/UNSAFE_SQLITE_DURABILITY/);
  }
 }finally{f.close();}
});
test('beide Reihenfolgen bleiben auf ursprünglichen Besitzer und Projekt gebunden',()=>{
 for(const first of ['live','full']){
  const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),other=first==='live'?'full':'live';
  try{
   assert.deepEqual(tx(f.db,r,p,u,first),{created:true});assert.deepEqual(tx(f.db,r,p,u,first),{created:false});
   assert.throws(()=>tx(f.db,r,p,u,other),/OWNER_CONFLICT/);
   const q=randomUUID();assert.throws(()=>tx(f.db,r,q,cameraUploadIdFor(r,q),first),/OWNER_CONFLICT/);
   assert.throws(()=>tx(f.db,r,p,randomUUID(),first),/BINDING_MISMATCH/);
   assert.throws(()=>tx(f.db,null,p,u,first),/IDENTITY_REQUIRED/);
   assert.throws(()=>claimUploadPath(f.db,r,p,u,first),/TRANSACTION_REQUIRED/);
   assert.throws(()=>f.db.prepare('DELETE FROM live_upload_path_owners').run(),/cannot be deleted/);
   assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO live_upload_path_owners(recording_id,project_id,upload_id,path) VALUES(?,?,?,?)').run(r,p,u,other),/already exists/);
  }finally{f.close();}
 }
});

test('bereits vorhandenes finales Video wird ohne Herkunftsnachweis nicht übernommen',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p);
 try{
  f.db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT,size INTEGER)');
  f.db.prepare('INSERT INTO project_recordings VALUES(?,?,?)').run(u,p,123);
  assert.throws(()=>tx(f.db,r,p,u,'live'),/FINAL_RECORDING_EXISTS/);
  assert.throws(()=>tx(f.db,r,p,u,'full'),/FINAL_RECORDING_EXISTS/);
  assert.deepEqual(f.db.prepare('SELECT id,project_id,size FROM project_recordings').get(),{id:u,project_id:p,size:123});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,0);
 }finally{f.close();}
});

test('unidentifizierbares historisches Video sperrt neuen Livepfad, ohne Bestand zu ändern',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),old=randomUUID();
 try{
  f.db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT,size INTEGER)');
  f.db.prepare('INSERT INTO project_recordings VALUES(?,?,?)').run(old,randomUUID(),123);
  assert.throws(()=>tx(f.db,r,p,u,'live'),/LEGACY_HISTORY_UNVERIFIED/);
  assert.equal(f.db.prepare('SELECT size FROM project_recordings WHERE id=?').get(old).size,123);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,0);
 }finally{f.close();}
});

test('historischer deterministischer Vollupload in anderem Projekt wird erkannt',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),other=randomUUID(),u=cameraUploadIdFor(r,p),old=cameraUploadIdFor(r,other);
 try{
  f.db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT,size INTEGER)');
  f.db.prepare('INSERT INTO projects VALUES(?)').run(p);f.db.prepare('INSERT INTO projects VALUES(?)').run(other);
  f.db.prepare('INSERT INTO project_recordings VALUES(?,?,?)').run(old,other,321);
  assert.throws(()=>tx(f.db,r,p,u,'live'),/FINAL_RECORDING_EXISTS/);
  assert.equal(f.db.prepare('SELECT size FROM project_recordings WHERE id=?').get(old).size,321);
 }finally{f.close();}
});

test('Kamera-Webclaim und abweichender LAN-Import sperren beide Pfade',()=>{
 for(const mode of ['live','full']){
  const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p);
  try{
   f.db.exec('CREATE TABLE camera_project_claims(recording_id TEXT PRIMARY KEY); CREATE TABLE lan_capture_projects(recording_id TEXT PRIMARY KEY,project_id TEXT)');
   f.db.prepare('INSERT INTO camera_project_claims VALUES(?)').run(r);
   assert.throws(()=>tx(f.db,r,p,u,mode),/WEB_CLAIM/);
   f.db.prepare('DELETE FROM camera_project_claims').run();
   f.db.prepare('INSERT INTO lan_capture_projects VALUES(?,?)').run(r,randomUUID());
   assert.throws(()=>tx(f.db,r,p,u,mode),/BINDING_MISMATCH/);
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,0);
  }finally{f.close();}
 }
});

test('neuer Webclaim kann vorhandene LAN-Besitzzuordnung nicht nachträglich übernehmen',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p);
 try{
  f.db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);
  tx(f.db,r,p,u,'full');
  assert.throws(()=>f.db.transaction(()=>claimCameraProject(f.db,r,randomUUID(),p,Date.now())).immediate(),/LAN-Upload/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM camera_project_claims').get().n,0);
 }finally{f.close();}
});

test('sämtliche Workspace-Bindungen werden auf widersprüchliche Projekte geprüft',()=>{
 for(const reverse of [false,true]){
  const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),foreign=randomUUID();
  try{
   f.db.exec('CREATE TABLE lan_capture_projects(workspace_id TEXT,recording_id TEXT,project_id TEXT,PRIMARY KEY(workspace_id,recording_id))');
   f.db.prepare('INSERT INTO lan_capture_projects VALUES(?,?,?)').run('first',r,reverse?foreign:p);
   f.db.prepare('INSERT INTO lan_capture_projects VALUES(?,?,?)').run('second',r,reverse?p:foreign);
   assert.throws(()=>tx(f.db,r,p,u,'live'),/BINDING_MISMATCH/);
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,0);
  }finally{f.close();}
 }
});

test('späterer neutraler Projektimport darf vorhandene Zuordnung nicht ersetzen',()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p);
 try{
  f.db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,created_at TEXT,title TEXT,sources TEXT,content TEXT)');
  tx(f.db,r,p,u,'full');
  assert.throws(()=>ensureLanCaptureProject(f.db,r,()=>{}),/camera_claim_exists/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
 }finally{f.close();}
});

function start(f,r,p,u,mode,point='normal'){
 const worker=fork(new URL('./fixtures/live-path-owner-worker.mjs',import.meta.url),[f.filename,r,p,u,mode,point],{stdio:['ignore','ignore','pipe','ipc'],execArgv:['--experimental-strip-types']});
 const ready=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>reject(Error(`worker exited ${code}`)));});
 return {worker,ready};
}
test('zwei Prozesse können nicht beide Pfade für denselben Take belegen',async()=>{
 const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),workers=['live','full'].map(x=>start(f,r,p,u,x));
 const exited=workers.map(({worker})=>new Promise(resolve=>worker.once('exit',resolve)));
 try{
  await Promise.all(workers.map(x=>x.ready));
  const replies=workers.map(({worker})=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));
  for(const {worker} of workers)worker.send('go');
  const results=await Promise.all(replies);
  assert.equal(results.filter(x=>x.result?.created===true).length,1);assert.equal(results.filter(x=>x.error==='OWNER_CONFLICT').length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_upload_path_owners').get().n,1);
 }finally{for(const {worker} of workers)if(worker.connected)worker.disconnect();await Promise.all(exited);f.close();}
});

test('Prozessabbruch vor und nach Commit behält keine halbe bzw eine dauerhafte Zuordnung',async()=>{
 for(const point of ['before-commit','after-commit']){
  const f=fixture(),r=randomUUID(),p=randomUUID(),u=cameraUploadIdFor(r,p),{worker,ready}=start(f,r,p,u,'live',point);
  try{
   await ready;const exited=new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({code,signal})));worker.send('go');
   assert.equal((await exited).signal,'SIGKILL');
   const row=f.db.prepare('SELECT path FROM live_upload_path_owners WHERE recording_id=?').get(r);
   if(point==='before-commit'){assert.equal(row,undefined);assert.deepEqual(tx(f.db,r,p,u,'full'),{created:true});}
   else{assert.equal(row.path,'live');assert.deepEqual(tx(f.db,r,p,u,'live'),{created:false});assert.throws(()=>tx(f.db,r,p,u,'full'),/OWNER_CONFLICT/);}
  }finally{if(worker.connected)worker.disconnect();f.close();}
 }
});
