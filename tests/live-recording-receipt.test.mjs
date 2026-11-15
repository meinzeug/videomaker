import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,linkSync,rmSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import Database from 'better-sqlite3';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/lib/recording-receipt.ts')&&specifier==='./recordings')return next('./recordings.ts',context);
 return next(specifier,context);
}});
const {createLiveStaging,initializeLiveStaging}=await import('../lib/live-recording-staging.ts');
const {getLiveRecordingReceipt}=await import('../lib/live-recording-receipt.ts');
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'live-receipt-')),db=new Database(join(root,'db.sqlite'));
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT,created_at TEXT,mime TEXT,size INTEGER)');initializeLiveStaging(db);
 const [id,project,recording]=[randomUUID(),randomUUID(),randomUUID()],data=Buffer.from('synthetic mp4 bytes'),sha=hash(data);
 let allowed=true;const authorize=()=>{if(!allowed)throw new Error('UNAUTHORIZED');if(!db.prepare('SELECT 1 FROM projects WHERE id=?').get(project))throw new Error('PROJECT_MISSING');};
 db.prepare('INSERT INTO projects VALUES(?)').run(project);
 const store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n,authorize);store.begin(id,project,recording);store.put(id,project,recording,0,0,data,sha);store.seal(id,project,recording,data.length,sha);
 mkdirSync(join(root,'recordings'));const file=join(root,'recordings',`${id}.mp4`);linkSync(store.sealedPath(id,project,recording).path,file);
 db.prepare('INSERT INTO project_recordings VALUES(?,?,?,?,?)').run(id,project,'2026-01-01','video/mp4',data.length);
 const request=(extra={})=>getLiveRecordingReceipt({database:db,root,id,project,recording,authorize,...extra});
 return {root,db,id,project,recording,data,sha,file,store,request,revoke(){allowed=false;},close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
test('Beleg ist idempotent nach verlorener Abschlussantwort; Abruf veröffentlicht und löscht nichts',async()=>{
 const f=fixture();try{
  const expected={id:f.id,projectId:f.project,recordingId:f.recording,sizeBytes:f.data.length,sha256:f.sha,published:true};
  assert.deepEqual(await f.request(),expected);assert.deepEqual(await f.request(),expected);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM recording_upload_owners').get().n,0,'wiederholte Belegabrufe dürfen keine dauerhaften Eigentümereinträge ansammeln');
  assert.equal(f.store.status(f.id,f.project,f.recording).state,'sealed');assert.deepEqual(readFileSync(f.file),f.data);
  f.store.markPublished(f.id,f.project,f.recording);assert.deepEqual(await f.request(),expected);
  assert.equal(f.store.status(f.id,f.project,f.recording).state,'published');
 }finally{f.close();}
});
test('fremde Bindung, fehlende Datei und gelöschter Aufnahmebeleg erzeugen nie neuen Upload',async()=>{
 for(const change of ['recording','project','file','row']){
  const f=fixture();try{
   const extra={};if(change==='recording')extra.recording=randomUUID();if(change==='project')extra.project=randomUUID();if(change==='file')unlinkSync(f.file);if(change==='row')f.db.prepare('DELETE FROM project_recordings WHERE id=?').run(f.id);
   await assert.rejects(f.request(extra));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM project_recordings').get().n,change==='row'?0:1);
  }finally{f.close();}
 }
});
test('Logout, Projekt- und Aufnahmelöschung während des Hashens verhindern einen Beleg',async()=>{
 for(const change of ['logout','project','row','replace']){
  const f=fixture();try{
   await assert.rejects(f.request({afterHash:()=>{
    if(change==='logout')f.revoke();
    if(change==='project')f.db.prepare('DELETE FROM projects WHERE id=?').run(f.project);
    if(change==='row')f.db.prepare('DELETE FROM project_recordings WHERE id=?').run(f.id);
    if(change==='replace'){unlinkSync(f.file);writeFileSync(f.file,f.data);}
   }}));
  }finally{f.close();}
 }
});
test('veränderte Bytes erhalten trotz identischer Dateigröße keinen Beleg',async()=>{
 const f=fixture();try{writeFileSync(f.file,Buffer.alloc(f.data.length,7));await assert.rejects(f.request());}finally{f.close();}
});
