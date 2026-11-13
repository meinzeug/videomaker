import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensureRecordingIntent,linkRecordingDurably} from '../lib/recording-upload-intent.ts';

test('durable intent binds id to project and bytes; fsync failure keeps recoverable file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-intent-'));
 try{
  const id=randomUUID(),token=randomUUID(),intent={version:1,recordingId:id,projectId:randomUUID(),mime:'video/mp4',sizeBytes:3,sha256:'a'.repeat(64)};
  assert.equal(await ensureRecordingIntent(dir,intent,token,()=>{}),true);
  assert.equal(await ensureRecordingIntent(dir,intent,randomUUID(),()=>{}),true);
  assert.equal(await ensureRecordingIntent(dir,{...intent,projectId:randomUUID()},randomUUID(),()=>{}),false);
  const tmp=path.join(dir,'input'),target=path.join(dir,'final.mp4');await writeFile(tmp,'abc');
  assert.throws(()=>linkRecordingDurably(tmp,target,()=>{throw new Error('fsync failed')}),/fsync failed/);
  assert.equal(await readFile(target,'utf8'),'abc');
  assert.equal(linkRecordingDurably(tmp,target),'exists');
  assert.equal(await readFile(target,'utf8'),'abc');
 } finally {await rm(dir,{recursive:true,force:true});}
});
