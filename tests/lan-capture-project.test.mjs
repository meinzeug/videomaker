import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ensureLanCaptureProject,initializeLanCaptureProjects} from '../lib/lan-capture-project.ts';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'videomaker-lan-project-')),file=join(directory,'db.sqlite');let db=new Database(file);
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,title TEXT NOT NULL,sources TEXT NOT NULL,content TEXT NOT NULL)');initializeLanCaptureProjects(db);
 return {directory,file,db,close(){if(db.open)db.close();rmSync(directory,{recursive:true,force:true});}};
}
test('neutrales Aufnahmeprojekt wird atomar und über Neustart hinweg idempotent angelegt',()=>{
 const f=fixture(),recording=randomUUID();
 try{
  const first=ensureLanCaptureProject(f.db,recording,()=>{}),retry=ensureLanCaptureProject(f.db,recording.toUpperCase(),()=>{});
  assert.equal(first.created,true);assert.equal(retry.created,false);assert.equal(retry.projectId,first.projectId);
  const project=f.db.prepare('SELECT * FROM projects WHERE id=?').get(first.projectId),content=JSON.parse(project.content);
  assert.equal(project.title,'Aufnahme ohne Skript');assert.equal(project.sources,'[]');assert.equal(content.script,'');assert.equal(content.capture_without_script,true);
  f.db.close();const reopened=new Database(f.file);try{assert.equal(ensureLanCaptureProject(reopened,recording,()=>{}).projectId,first.projectId);}finally{reopened.close();}
 }finally{f.close();}
});
test('gelöschtes Projekt wird bei Retry nicht heimlich ersetzt',()=>{
 const f=fixture(),recording=randomUUID();
 try{
  const created=ensureLanCaptureProject(f.db,recording,()=>{});f.db.prepare('DELETE FROM projects WHERE id=?').run(created.projectId);
  assert.throws(()=>ensureLanCaptureProject(f.db,recording,()=>{}),error=>error.code==='project_deleted');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lan_capture_projects').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
 }finally{f.close();}
});
test('widerrufene Sitzung, ungültige ID und vorhandener Web-Kameraanspruch erzeugen kein Projekt',()=>{
 const f=fixture(),recording=randomUUID();
 try{
  assert.throws(()=>ensureLanCaptureProject(f.db,recording,()=>{throw Error('UNAUTHORIZED');}),/UNAUTHORIZED/);
  assert.throws(()=>ensureLanCaptureProject(f.db,'kein-uuid',()=>{}),error=>error.code==='invalid_recording');
  f.db.exec('CREATE TABLE camera_project_claims(recording_id TEXT PRIMARY KEY)');f.db.prepare('INSERT INTO camera_project_claims VALUES(?)').run(recording);
  assert.throws(()=>ensureLanCaptureProject(f.db,recording,()=>{}),error=>error.code==='camera_claim_exists');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lan_capture_projects').get().n,0);
 }finally{f.close();}
});
test('Widerruf vor Commit legt auch das Mapping-Schema nicht an',()=>{
 const database=new Database(':memory:');
 try{
  database.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,title TEXT NOT NULL,sources TEXT NOT NULL,content TEXT NOT NULL)');
  assert.throws(()=>ensureLanCaptureProject(database,randomUUID(),()=>{throw Error('UNAUTHORIZED');}),/UNAUTHORIZED/);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lan_capture_projects'").get(),undefined);
 }finally{database.close();}
});
test('zwei Prozesse legen für dieselbe Aufnahme transaktional genau ein Projekt an',async()=>{
 const f=fixture(),recording=randomUUID(),workers=[];
 try{
  const script=new URL('./fixtures/lan-capture-project-worker.mjs',import.meta.url);
  for(let i=0;i<2;i++)workers.push(fork(script,[f.file,recording],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',value=>value==='ready'?resolve():reject(Error('Testprozess nicht bereit')));} )));
  const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(Error('Testprozess fehlgeschlagen'));});}));
  for(const worker of workers)worker.send('go');const replies=await Promise.all(pending);
  assert.ok(replies.every(item=>item.result));assert.equal(replies[0].result.projectId,replies[1].result.projectId);
  assert.deepEqual(replies.map(item=>item.result.created).sort(),[false,true]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,1);
 }finally{for(const worker of workers)if(worker.connected)worker.disconnect();f.close();}
});
