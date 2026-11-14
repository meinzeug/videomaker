import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,openSync,writeSync,closeSync,linkSync,rmSync,readFileSync,writeFileSync,unlinkSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createLiveStaging,initializeLiveStaging,LIVE_CHUNK_BYTES,LIVE_MAX_SESSIONS} from '../lib/live-recording-staging.ts';
import {CAMERA_PROJECT_CLAIMS_SCHEMA} from '../lib/camera-project-claims.ts';

const sum=bytes=>createHash('sha256').update(bytes).digest('hex');
const huge=()=>4n*1024n*1024n*1024n;
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'videomaker-live-stage-')),db=new Database(join(directory,'db.sqlite'));
 initializeLiveStaging(db);
 const store=createLiveStaging(db,directory,huge),ids=[randomUUID(),randomUUID(),randomUUID()];
 return {directory,db,store,ids,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
test('identische Wiederholung ist idempotent; revidierter MP4-Header und letzter Teil werden verlustfrei versiegelt',()=>{
 const f=fixture(),[id,project,recording]=f.ids;
 try{
  f.store.begin(id,project,recording);const first=Buffer.alloc(LIVE_CHUNK_BYTES,1),newHeader=Buffer.alloc(LIVE_CHUNK_BYTES,2),last=Buffer.from('mp4 trailer');
  assert.equal(f.store.put(id,project,recording,0,0,first,sum(first)).revision,1);
  assert.equal(f.store.put(id,project,recording,0,0,first,sum(first)).revision,1,'verlorenes ACK darf nicht doppelt zählen');
  assert.equal(f.store.put(id,project,recording,1,0,last,sum(last)).revision,1);
  assert.equal(f.store.put(id,project,recording,0,1,newHeader,sum(newHeader)).revision,2);
  const final=Buffer.concat([newHeader,last]);
  assert.deepEqual(f.store.seal(id,project,recording,final.length,sum(final)),{sizeBytes:final.length,sha256:sum(final)});
  assert.equal(f.store.status(id,project,recording).state,'sealed');
  const stage=f.db.prepare('SELECT file_key FROM live_recording_stages WHERE id=?').get(id);
  assert.deepEqual(readFileSync(join(f.directory,'.live-recording-staging',`${stage.file_key}.part`)),final);
  assert.throws(()=>f.store.put(id,project,recording,0,2,first,sum(first)),/NOT_OPEN/);
 }finally{f.close();}
});
test('Crash nach Teilmutation lässt unbestätigten Chunk stehen und erneutes Senden stellt ihn wieder her',()=>{
 const f=fixture(),[id,project,recording]=f.ids;
 try{
  f.store.begin(id,project,recording);const old=Buffer.from('original'),next=Buffer.from('correct!');
  f.store.put(id,project,recording,0,0,old,sum(old));
  f.db.prepare("UPDATE live_recording_chunks SET state='writing',expected_revision=1,size=?,sha256=? WHERE stage_id=? AND part=0").run(next.length,sum(next),id);
  const stage=f.db.prepare('SELECT file_key FROM live_recording_stages WHERE id=?').get(id),file=join(f.directory,'.live-recording-staging',`${stage.file_key}.part`);
  const fd=openSync(file,'r+');try{writeSync(fd,Buffer.from('xx'),0,2,0);}finally{closeSync(fd);}
  assert.equal(f.store.status(id,project,recording).chunks[0].state,'writing');
  assert.throws(()=>f.store.seal(id,project,recording,next.length,sum(next)),/INCOMPLETE/);
  assert.throws(()=>f.store.put(id,project,recording,0,0,old,sum(old)),/REVISION_CONFLICT/);
  const rewritten=Buffer.from('new-data');
  assert.equal(f.store.put(id,project,recording,0,1,rewritten,sum(rewritten)).revision,2,'nicht bestätigter alter Datenstand muss nach MP4-Rewrite nicht rekonstruierbar sein');
  assert.deepEqual(f.store.seal(id,project,recording,rewritten.length,sum(rewritten)),{sizeBytes:rewritten.length,sha256:sum(rewritten)});
 }finally{f.close();}
});
test('Lücken, fremde Bindungen, Hashfehler, stale Revision und veränderte Dateien werden abgewiesen',()=>{
 const f=fixture(),[id,project,recording]=f.ids;
 try{
  f.store.begin(id,project,recording);const value=Buffer.from('only chunk');
  assert.throws(()=>f.store.put(id,project,randomUUID(),0,0,value,sum(value)),/BINDING_CONFLICT/);
  assert.throws(()=>f.store.put(id,project,recording,1,0,value,sum(value)),/NONCONTIGUOUS/);
  assert.throws(()=>f.store.put(id,project,recording,0,0,value,'0'.repeat(64)),/INVALID_CHUNK/);
  f.store.put(id,project,recording,0,0,value,sum(value));
  assert.throws(()=>f.store.put(id,project,recording,1,0,value,sum(value)),/NONCONTIGUOUS/);
  assert.throws(()=>f.store.put(id,project,recording,0,0,Buffer.from('changed'),sum(Buffer.from('changed'))),/REVISION_CONFLICT/);
  assert.throws(()=>f.store.seal(id,project,recording,value.length,'0'.repeat(64)),/FINAL_MISMATCH/);
  const key=f.db.prepare('SELECT file_key FROM live_recording_stages WHERE id=?').get(id).file_key;
  const file=join(f.directory,'.live-recording-staging',`${key}.part`);writeFileSync(file,Buffer.from('corrupted!'));
  assert.equal(f.store.status(id,project,recording).chunks[0].state,'invalid','Status darf beschädigte Bytes nicht bestätigen');
  assert.throws(()=>f.store.seal(id,project,recording,value.length,sum(value)),/STAGE_CHANGED/);
  assert.equal(f.store.put(id,project,recording,0,1,value,sum(value)).revision,2);
  assert.equal(f.store.status(id,project,recording).chunks[0].state,'ready');
 }finally{f.close();}
});
test('Platzreserve und Sitzungsobergrenze sperren, expliziter Abbruch macht nur eigenen Platz frei',()=>{
 const f=fixture();
 try{
  const sessions=Array.from({length:LIVE_MAX_SESSIONS},()=>[randomUUID(),randomUUID(),randomUUID()]);
  for(const args of sessions)f.store.begin(...args);
  assert.throws(()=>f.store.begin(randomUUID(),randomUUID(),randomUUID()),/CAPACITY/);
  assert.equal(f.store.cancel(...sessions[0]),true);f.store.begin(randomUUID(),randomUUID(),randomUUID());
  const low=createLiveStaging(f.db,f.directory,()=>1n),bytes=Buffer.from('small');
  assert.throws(()=>low.put(...sessions[1],0,0,bytes,sum(bytes)),/NO_SPACE/);
 }finally{f.close();}
});
test('Sitzungswiderruf verhindert die Zustandsänderung',()=>{
 const f=fixture(),[id,project,recording]=f.ids;let allowed=true;
 try{
  const protectedStore=createLiveStaging(f.db,f.directory,huge,()=>{if(!allowed)throw new Error('UNAUTHORIZED');});
  protectedStore.begin(id,project,recording);allowed=false;
  assert.throws(()=>protectedStore.put(id,project,recording,0,0,Buffer.from('x'),sum(Buffer.from('x'))),/UNAUTHORIZED/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM live_recording_chunks').get().n,0);
  assert.throws(()=>protectedStore.cancel(id,project,recording),/UNAUTHORIZED/);
  allowed=true;assert.equal(protectedStore.status(id,project,recording).state,'open');
 }finally{f.close();}
});
test('nicht autorisierter Beginn legt kein Stagingschema an',()=>{
 const directory=mkdtempSync(join(tmpdir(),'videomaker-live-auth-')),db=new Database(':memory:');
 try{
  const store=createLiveStaging(db,directory,huge,()=>{throw Error('UNAUTHORIZED');});
  assert.throws(()=>store.begin(randomUUID(),randomUUID(),randomUUID()),/UNAUTHORIZED/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='live_recording_stages'").get(),undefined);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
test('Webclaim und abweichende LAN-Projektbindung sperren den Liveupload ohne Datenverlust',()=>{
 const f=fixture(),[id,project,recording]=f.ids;
 try{
  f.db.exec('CREATE TABLE camera_project_claims(recording_id TEXT PRIMARY KEY); CREATE TABLE lan_capture_projects(recording_id TEXT PRIMARY KEY,project_id TEXT NOT NULL)');
  f.db.prepare('INSERT INTO camera_project_claims VALUES(?)').run(recording);
  assert.throws(()=>f.store.begin(id,project,recording),/WEB_CLAIM/);
  f.db.prepare('DELETE FROM camera_project_claims').run();f.db.prepare('INSERT INTO lan_capture_projects VALUES(?,?)').run(recording,randomUUID());
  assert.throws(()=>f.store.begin(id,project,recording),/BINDING_CONFLICT/);
  f.db.prepare('DELETE FROM lan_capture_projects').run();f.store.begin(id,project,recording);
  f.db.prepare('INSERT INTO camera_project_claims VALUES(?)').run(recording);
  const value=Buffer.from('x');assert.throws(()=>f.store.put(id,project,recording,0,0,value,sum(value)),/WEB_CLAIM/);
  assert.equal(f.store.cancel(id,project,recording),true,'expliziter Abbruch bleibt trotz Konflikt möglich');
 }finally{f.close();}
});
test('veröffentlichte Datei behält ihre Bytes und Abschluss ist nach Prozessabbruch wiederholbar',()=>{
 const f=fixture(),[id,project,recording]=f.ids;
 try{
  f.db.exec('CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL)');
  f.store.begin(id,project,recording);const data=Buffer.from('final recording bytes');f.store.put(id,project,recording,0,0,data,sum(data));
  f.store.seal(id,project,recording,data.length,sum(data));
  const source=f.store.sealedPath(id,project,recording).path,dir=join(f.directory,'recordings');mkdirSync(dir,{mode:0o700});
  const final=join(dir,`${id}.mp4`);linkSync(source,final);
  assert.throws(()=>f.store.cancel(id,project,recording),/PUBLISH_UNCERTAIN/);
  f.db.prepare('INSERT INTO project_recordings VALUES(?,?,?,?)').run(id,project,'video/mp4',data.length);
  assert.equal(f.store.markPublished(id,project,recording),true);assert.equal(f.store.markPublished(id,project,recording),true);
  assert.deepEqual(readFileSync(final),data);assert.equal(f.store.status(id,project,recording).state,'published');
  assert.throws(()=>f.store.cancel(id,project,recording),/PUBLISHED/);
 }finally{f.close();}
});
test('fremde Symlinks an der Stagingdatei werden nicht verfolgt',()=>{
 const f=fixture(),[id,project,recording]=f.ids;
 try{
  f.store.begin(id,project,recording);const stage=f.db.prepare('SELECT file_key FROM live_recording_stages WHERE id=?').get(id);
  const file=join(f.directory,'.live-recording-staging',`${stage.file_key}.part`),target=join(f.directory,'unrelated');writeFileSync(target,'do not touch');unlinkSync(file);symlinkSync(target,file);
  assert.throws(()=>f.store.put(id,project,recording,0,0,Buffer.from('x'),sum(Buffer.from('x'))));
  assert.equal(readFileSync(target,'utf8'),'do not touch');
 }finally{f.close();}
});
test('konkurrierende Prozesse bestätigen niemals zwei unterschiedliche Daten für dieselbe Revision',async()=>{
 const f=fixture(),[id,project,recording]=f.ids,workers=[];
 try{
  f.store.begin(id,project,recording);
  const script=new URL('./fixtures/live-staging-worker.mjs',import.meta.url);
  for(const value of ['original','changed!'])workers.push(fork(script,[join(f.directory,'db.sqlite'),f.directory,id,project,recording,value],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',value=>value==='ready'?resolve():reject(new Error('Testprozess nicht bereit')));} )));
  const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(new Error('Testprozess fehlgeschlagen'));});}));
  for(const worker of workers)worker.send('go');const replies=await Promise.all(pending);
  assert.equal(replies.filter(item=>item.result).length,1);assert.equal(replies.filter(item=>item.error==='REVISION_CONFLICT').length,1);
  const chunk=f.store.status(id,project,recording).chunks[0],key=f.db.prepare('SELECT file_key FROM live_recording_stages WHERE id=?').get(id).file_key;
  assert.equal(sum(readFileSync(join(f.directory,'.live-recording-staging',`${key}.part`))),chunk.sha256);
  assert.equal(chunk.state,'ready');assert.equal(chunk.revision,1);
 }finally{for(const worker of workers)if(worker.connected)worker.disconnect();f.close();}
});
test('gleichzeitiger WEB-Claim und LAN-Livebeginn können nicht dieselbe Aufnahme belegen',async()=>{
 const f=fixture(),[id,project,recording]=f.ids,workers=[];
 try{
  f.db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');f.db.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);f.db.prepare('INSERT INTO projects VALUES(?)').run(project);
  const script=new URL('./fixtures/live-web-claim-race-worker.mjs',import.meta.url),device=randomUUID();
  for(const kind of ['lan','web'])workers.push(fork(script,[join(f.directory,'db.sqlite'),f.directory,id,project,recording,device,kind],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']}));
  await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',v=>v==='ready'?resolve():reject(Error('Worker nicht bereit')));} )));
  const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);w.once('exit',code=>{if(code!==0)reject(Error('Worker fehlgeschlagen'));});}));
  for(const worker of workers)worker.send('go');const replies=await Promise.all(pending);
  assert.deepEqual(replies.map(item=>item.result).sort(),['created','rejected']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM camera_project_claims').get().n+f.db.prepare('SELECT COUNT(*) AS n FROM live_recording_stages').get().n,1);
 }finally{for(const worker of workers)if(worker.connected)worker.disconnect();f.close();}
});

test('echter Prozessabbruch an Dateisynchronisation und DB-Commit ist wiederaufnehmbar',()=>{
 for(const point of ['after-opening-fsync','after-write-intent','after-chunk-fsync','after-chunk-commit']){
  const f=fixture(),[id,project,recording]=f.ids,bytes=Buffer.from('recording bytes');
  try{
   if(point!=='after-opening-fsync')f.store.begin(id,project,recording);
   const child=spawnSync(process.execPath,['--experimental-strip-types','tests/fixtures/live-staging-crash-worker.mjs',join(f.directory,'db.sqlite'),f.directory,id,project,recording,point],{encoding:'utf8',timeout:10000});
   assert.equal(child.signal,'SIGKILL',point+': '+child.stderr);
   if(point==='after-opening-fsync')f.store.begin(id,project,recording);
   else {
    const current=f.store.status(id,project,recording).chunks[0];
    assert.equal(current.state,point==='after-chunk-commit'?'ready':'writing',point);
    assert.equal(f.store.put(id,project,recording,0,0,bytes,sum(bytes)).revision,1);
    assert.deepEqual(f.store.seal(id,project,recording,bytes.length,sum(bytes)),{sizeBytes:bytes.length,sha256:sum(bytes)});
   }
  }finally{f.close();}
 }
});
