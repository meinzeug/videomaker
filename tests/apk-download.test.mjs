import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, open, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {APK_FILENAME, MAX_APK_BYTES, openApkRelease} from '../lib/apk-download.ts';

const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
async function fixture(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'videomaker-apk-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return {dir,file:path.join(dir,APK_FILENAME)};
}

test('opens the fixed release file and reads it from the start',async t=>{
 const {dir,file}=await fixture(t);
 const bytes=Buffer.concat([zipHeader,Buffer.from('test payload')]);
 await writeFile(file,bytes);
 const release=await openApkRelease(dir);
 try{
  assert.equal(release.size,bytes.length);
  const actual=Buffer.alloc(bytes.length);
  assert.equal((await release.file.read(actual,0,actual.length,0)).bytesRead,bytes.length);
  assert.deepEqual(actual,bytes);
 }finally{await release.file.close();}
});

test('rejects missing, truncated and non-ZIP files',async t=>{
 const {dir,file}=await fixture(t);
 await assert.rejects(openApkRelease(dir));
 for(const bytes of [Buffer.alloc(0),Buffer.from('PK'),Buffer.from('wrong header')]){
  await writeFile(file,bytes);
  await assert.rejects(openApkRelease(dir));
 }
});

test('rejects a symlink even when its target has a ZIP header',async t=>{
 const {dir,file}=await fixture(t);
 const target=path.join(dir,'other-file');
 await writeFile(target,zipHeader);
 await symlink(target,file);
 await assert.rejects(openApkRelease(dir));
});

test('rejects non-regular files without blocking on a FIFO',async t=>{
 const {dir,file}=await fixture(t);
 await mkdir(file);
 await assert.rejects(openApkRelease(dir));
 await rm(file,{recursive:true});
 execFileSync('mkfifo',[file]);
 await assert.rejects(openApkRelease(dir));
});

test('rejects oversized releases',async t=>{
 const {dir,file}=await fixture(t);
 const handle=await open(file,'w');
 try{await handle.write(zipHeader,0,zipHeader.length,0);await handle.truncate(MAX_APK_BYTES+1);}
 finally{await handle.close();}
 await assert.rejects(openApkRelease(dir));
});

test('atomic replacement keeps existing downloads on the opened file',async t=>{
 const {dir,file}=await fixture(t);
 await writeFile(file,Buffer.concat([zipHeader,Buffer.from('old')]));
 const old=await openApkRelease(dir);
 try{
  const replacement=path.join(dir,'new');
  await writeFile(replacement,Buffer.concat([zipHeader,Buffer.from('new')]));
  await rename(replacement,file);
  const latest=await openApkRelease(dir);
  try{
   const oldBytes=Buffer.alloc(old.size),newBytes=Buffer.alloc(latest.size);
   await old.file.read(oldBytes,0,oldBytes.length,0);
   await latest.file.read(newBytes,0,newBytes.length,0);
   assert.equal(oldBytes.subarray(4).toString(),'old');
   assert.equal(newBytes.subarray(4).toString(),'new');
  }finally{await latest.file.close();}
 }finally{await old.file.close();}
});
