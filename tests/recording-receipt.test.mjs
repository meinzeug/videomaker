import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,unlink} from 'node:fs/promises';
import {renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/lib/recording-receipt.ts')&&specifier==='./recordings')return next('./recordings.ts',context);
 return next(specifier,context);
}});
const {recordingFileReceipt}=await import('../lib/recording-receipt.ts');

test('receipt hashes actual stored bytes and rejects a wrong size or missing file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-receipt-'));const file=path.join(dir,'capture.mp4');
 const bytes=Buffer.from('private synthetic fixture');
 await writeFile(file,bytes,{flag:'wx'});
 try{
  assert.deepEqual(await recordingFileReceipt(file,bytes.length),{sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  await assert.rejects(recordingFileReceipt(file,bytes.length+1));
  await assert.rejects(recordingFileReceipt(file,0));
  await unlink(file);
  await assert.rejects(recordingFileReceipt(file,bytes.length));
 } finally {await import('node:fs/promises').then(fs=>fs.rm(dir,{recursive:true,force:true}));}
});

test('a replaced target or a lost upload lease never yields a receipt',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'recording-receipt-race-'));const file=path.join(dir,'capture.mp4'),replacement=path.join(dir,'replacement.mp4');
 const bytes=Buffer.from('first synthetic version'),other=Buffer.alloc(bytes.length,42);
 try{
  await writeFile(file,bytes,{flag:'wx'});writeFileSync(replacement,other,{flag:'wx'});
  let count=0;
  await assert.rejects(recordingFileReceipt(file,bytes.length,()=>{if(++count===2)renameSync(replacement,file);}),/STORED_FILE_CHANGED/);
  count=0;
  await assert.rejects(recordingFileReceipt(file,other.length,()=>{if(++count===2)throw new Error('UPLOAD_LEASE_LOST');}),/UPLOAD_LEASE_LOST/);
 } finally {await import('node:fs/promises').then(fs=>fs.rm(dir,{recursive:true,force:true}));}
});
