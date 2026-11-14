import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {acquireGenerationClaim,claimSnapshot,completeGenerationClaim,ensureGenerationClaimsSchema,GenerationClaimConflict,GenerationResearchMissing,readGenerationClaim,saveGenerationResponse} from '../lib/generation-claims.ts';
import {saveGeneratedProject} from '../lib/channel-generation.ts';

const rid='11111111-1111-4111-8111-111111111111';
const now='2026-11-14T00:00:00.000Z';
function setup(db){
 db.exec(`CREATE TABLE research_reports(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,sources TEXT NOT NULL,report TEXT NOT NULL);
 CREATE TABLE projects(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,title TEXT NOT NULL,sources TEXT NOT NULL,content TEXT NOT NULL);
 CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,platform TEXT NOT NULL,handle TEXT NOT NULL);
 CREATE TABLE project_channels(project_id TEXT NOT NULL,channel_id TEXT NOT NULL,PRIMARY KEY(project_id,channel_id));`);
 ensureGenerationClaimsSchema(db);
 db.prepare('INSERT INTO research_reports VALUES(?,?,?,?)').run(rid,now,JSON.stringify([{url:'https://example.org/a'}]),JSON.stringify({summary:'Test',generation_channel:null}));
}
function acquire(db,mode='descriptions',channel=null){return db.transaction(()=>acquireGenerationClaim(db,rid,mode,channel,now)).immediate();}

test('one durable reservation per research, including retries with changed parameters',()=>{
 const db=new Database(':memory:');setup(db);
 const first=acquire(db),second=acquire(db);
 assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(first.claim.projectId,second.claim.projectId);assert.equal(second.claim.state,'pending');
 assert.throws(()=>acquire(db,'render'),GenerationClaimConflict);
 // Deleting the original report must not make the pending reservation expire.
 db.prepare('DELETE FROM research_reports WHERE id=?').run(rid);
 assert.equal(acquire(db).claim.state,'pending');assert.equal(claimSnapshot(first.claim).report.summary,'Test');
 db.close();
});
test('response and reservation survive a restart; no provider call is needed to resume',()=>{
 const dir=mkdtempSync(join(tmpdir(),'generation-claim-test-'));
 try{
  const file=join(dir,'db.sqlite');let db=new Database(file);setup(db);
  const first=acquire(db);saveGenerationResponse(db,rid,'{"script":"saved"}',now,true);db.close();
  db=new Database(file);const resumed=acquire(db);assert.equal(resumed.created,false);assert.equal(resumed.claim.state,'received');assert.equal(resumed.claim.responseText,'{"script":"saved"}');assert.equal(resumed.claim.responseTruncated,1);assert.equal(resumed.claim.projectId,first.claim.projectId);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('project and claim completion roll back together on SQLite COMMIT failure',()=>{
 const db=new Database(':memory:');setup(db);db.pragma('foreign_keys = ON');
 const {claim}=acquire(db);saveGenerationResponse(db,rid,'{"script":"saved"}',now);
 db.exec(`CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
 CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
 CREATE TRIGGER break_generation_commit AFTER INSERT ON projects BEGIN INSERT INTO commit_child VALUES (123); END;`);
 const project={id:claim.projectId,created_at:now,title:'Test',sources:[],content:{script:'saved',generation_warnings:[]}};
 assert.throws(()=>db.transaction(()=>{saveGeneratedProject(db,project,rid,null);completeGenerationClaim(db,rid,now);}).immediate());
 assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM research_reports').get().n,1);
 assert.equal(readGenerationClaim(db,rid).state,'received');assert.equal(readGenerationClaim(db,rid).responseText,'{"script":"saved"}');
 db.exec('DROP TRIGGER break_generation_commit');
 db.transaction(()=>{saveGeneratedProject(db,project,rid,null);completeGenerationClaim(db,rid,now);}).immediate();
 assert.equal(readGenerationClaim(db,rid).state,'complete');assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM research_reports').get().n,0);
 assert.equal(acquire(db).claim.projectId,project.id);db.close();
});
test('unknown research is not claimed; duplicate provider response cannot replace the first',()=>{
 const db=new Database(':memory:');setup(db);
 assert.throws(()=>db.transaction(()=>acquireGenerationClaim(db,'22222222-2222-4222-8222-222222222222','descriptions',null,now)).immediate(),GenerationResearchMissing);
 acquire(db);saveGenerationResponse(db,rid,'first',now);assert.throws(()=>saveGenerationResponse(db,rid,'second',now));assert.equal(readGenerationClaim(db,rid).responseText,'first');db.close();
});
