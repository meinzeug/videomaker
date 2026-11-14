import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareRecordingIntent,commitRecordingIntent,linkRecordingDurably} from '../lib/recording-upload-intent.ts';

async function ensure(directory,intent,token){
 const temporary=await prepareRecordingIntent(directory,intent,token,()=>{});
 try{return commitRecordingIntent(directory,intent,temporary,()=>{});}finally{await rm(temporary,{force:true});}
}

test('durable intent binds id to project and bytes; fsync failure keeps recoverable file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-intent-'));
 try{
  const id=randomUUID(),token=randomUUID(),intent={version:1,recordingId:id,projectId:randomUUID(),mime:'video/mp4',sizeBytes:3,sha256:'a'.repeat(64)};
  const prepared=await prepareRecordingIntent(dir,intent,token,()=>{});
  await assert.rejects(access(path.join(dir,`.upload-intent-${id}.json`)));
  assert.equal(commitRecordingIntent(dir,intent,prepared,()=>{}),true);await rm(prepared);
  assert.equal(await ensure(dir,intent,randomUUID()),true);
  assert.equal(await ensure(dir,{...intent,projectId:randomUUID()},randomUUID()),false);
  const tmp=path.join(dir,'input'),target=path.join(dir,'final.mp4');await writeFile(tmp,'abc');
  assert.throws(()=>linkRecordingDurably(tmp,target,()=>{throw new Error('fsync failed')}),/fsync failed/);
  assert.equal(await readFile(target,'utf8'),'abc');
  assert.equal(linkRecordingDurably(tmp,target),'exists');
  assert.equal(await readFile(target,'utf8'),'abc');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('exclusive intent preparation never deletes a pre-existing temporary file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-intent-owned-'));
 try{
  const token=randomUUID(),existing=path.join(dir,`.verified-intent-tmp-${token}`),bytes=Buffer.from('unrelated existing data');
  await writeFile(existing,bytes,{flag:'wx'});
  const intent={version:1,recordingId:randomUUID(),projectId:randomUUID(),mime:'video/mp4',sizeBytes:3,sha256:'a'.repeat(64)};
  await assert.rejects(prepareRecordingIntent(dir,intent,token,()=>{}),error=>error.code==='EEXIST');
  assert.deepEqual(await readFile(existing),bytes);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('oversized and symlink markers are never followed, overwritten or removed',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-intent-marker-'));
 try{
  const id=randomUUID(),marker=path.join(dir,`.upload-intent-${id}.json`),outside=path.join(dir,'unrelated');
  const intent={version:1,recordingId:id,projectId:randomUUID(),mime:'video/mp4',sizeBytes:3,sha256:'a'.repeat(64)};
  const temporary=await prepareRecordingIntent(dir,intent,randomUUID(),()=>{}),large=Buffer.alloc(4097,65);
  await writeFile(marker,large,{flag:'wx'});assert.equal(commitRecordingIntent(dir,intent,temporary,()=>{}),false);
  assert.deepEqual(await readFile(marker),large);await rm(marker);
  await writeFile(outside,'preserve');await symlink(outside,marker);
  assert.throws(()=>commitRecordingIntent(dir,intent,temporary,()=>{}));
  assert.equal(await readFile(outside,'utf8'),'preserve');
 }finally{await rm(dir,{recursive:true,force:true});}
});
