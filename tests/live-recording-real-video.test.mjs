import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createLiveStaging,initializeLiveStaging,LIVE_CHUNK_BYTES} from '../lib/live-recording-staging.ts';

const source=process.env.LIVE_RECORDING_REAL_MP4;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// Opt in with a disposable test recording; never modify the supplied original.
test('echtes Kameravideo übersteht verlorenes ACK und erneuerten MP4-Header bytegenau', {skip:!source,timeout:120000},()=>{
 const bytes=readFileSync(source);
 assert.ok(bytes.length>LIVE_CHUNK_BYTES&&bytes.length<=64*LIVE_CHUNK_BYTES,'Testaufnahme muss zwischen 1 und 64 MiB groß sein');
 const dir=mkdtempSync(join(tmpdir(),'videomaker-real-video-'));
 const db=new Database(join(dir,'test.sqlite'));
 try{
  initializeLiveStaging(db);
  const store=createLiveStaging(db,dir,()=>4n*1024n*1024n*1024n);
  const [id,project,recording]=[randomUUID(),randomUUID(),randomUUID()];
  store.begin(id,project,recording);
  // Model a header that is revised after the initial, successfully sent chunk.
  const oldHeader=Buffer.alloc(LIVE_CHUNK_BYTES);
  assert.equal(store.put(id,project,recording,0,0,oldHeader,digest(oldHeader)).revision,1);
  assert.equal(store.put(id,project,recording,0,0,oldHeader,digest(oldHeader)).revision,1,'Wiederholung nach verlorenem ACK');
  for(let offset=LIVE_CHUNK_BYTES,part=1;offset<bytes.length;offset+=LIVE_CHUNK_BYTES,part++){
   const chunk=bytes.subarray(offset,Math.min(offset+LIVE_CHUNK_BYTES,bytes.length));
   assert.equal(store.put(id,project,recording,part,0,chunk,digest(chunk)).revision,1);
  }
  const header=bytes.subarray(0,LIVE_CHUNK_BYTES);
  assert.equal(store.put(id,project,recording,0,1,header,digest(header)).revision,2);
  assert.deepEqual(store.seal(id,project,recording,bytes.length,digest(bytes)),{sizeBytes:bytes.length,sha256:digest(bytes)});
  const output=store.sealedPath(id,project,recording).path;
  assert.deepEqual(readFileSync(output),bytes,'Der versiegelte Inhalt muss dem Kameraoriginal entsprechen');
  const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name','-of','json',output],{encoding:'utf8',timeout:30000});
  assert.equal(probe.status,0,probe.stderr||'ffprobe fehlgeschlagen');
  const streams=JSON.parse(probe.stdout).streams;
  assert.ok(streams.some(item=>item.codec_type==='video'&&item.codec_name==='h264'));
  assert.ok(streams.some(item=>item.codec_type==='audio'&&item.codec_name==='aac'));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
