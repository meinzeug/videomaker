import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA,claimCameraProject,assertCameraProjectDeletable,closeCameraProjectClaim} from '../lib/camera-project-claims.ts';
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
