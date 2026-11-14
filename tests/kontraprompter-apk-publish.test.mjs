import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,chmodSync,writeFileSync,readFileSync,openSync,readSync,closeSync,symlinkSync,truncateSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const installer=path.resolve('scripts/install-kontraprompter-apk.py');
const preparer=path.resolve('scripts/prepare-kontraprompter-apk.py');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fakeApk=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('synthetic artifact')]);

function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'videomaker-apk-publish-test-'));chmodSync(root,0o700);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data');mkdirSync(data,{mode:0o700});
 const source=path.join(root,'source.apk');writeFileSync(source,fakeApk);
 const target=path.join(data,'kontraprompter.apk');writeFileSync(target,'existing release');
 return {root,data,source,target};
}
function run(source,data,sha){return spawnSync('python3',[installer,source,data,sha],{encoding:'utf8',timeout:10000});}

test('verified bytes replace the target atomically while existing readers keep the old file',t=>{
 const f=fixture(t),old=openSync(f.target,'r');
 try{
  const result=run(f.source,f.data,digest(fakeApk));assert.equal(result.status,0,result.stderr);
  assert.deepEqual(readFileSync(f.target),fakeApk);
  const buffer=Buffer.alloc(16);assert.equal(readSync(old,buffer,0,16,0),16);assert.equal(buffer.toString(),'existing release');
  assert.deepEqual(readdirSync(f.data).sort(),['.kontraprompter-apk.lock','kontraprompter.apk']);
 }finally{closeSync(old);}
});

test('wrong hash, malformed data, oversized file and symbolic links preserve the existing APK',t=>{
 const f=fixture(t);
 assert.notEqual(run(f.source,f.data,'0'.repeat(64)).status,0);
 assert.equal(readFileSync(f.target,'utf8'),'existing release');
 writeFileSync(f.source,'not an apk');assert.notEqual(run(f.source,f.data,digest(Buffer.from('not an apk'))).status,0);
 assert.equal(readFileSync(f.target,'utf8'),'existing release');
 truncateSync(f.source,512*1024*1024+1);assert.notEqual(run(f.source,f.data,'0'.repeat(64)).status,0);
 assert.equal(readFileSync(f.target,'utf8'),'existing release');
 const alias=path.join(f.root,'alias.apk');symlinkSync(f.source,alias);
 assert.notEqual(run(alias,f.data,'0'.repeat(64)).status,0);
 assert.equal(readFileSync(f.target,'utf8'),'existing release');
});

test('a second publisher cannot bypass the installation lock',t=>{
 const f=fixture(t),lock=path.join(f.data,'.kontraprompter-apk.lock');
 const result=spawnSync('flock',['--exclusive','--nonblock',lock,'python3',installer,f.source,f.data,digest(fakeApk)],{encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,0);assert.equal(readFileSync(f.target,'utf8'),'existing release');
});

test('a symlink at the published path is never followed or replaced',t=>{
 const f=fixture(t);rmSync(f.target);const outside=path.join(f.root,'outside');writeFileSync(outside,'untouched');symlinkSync(outside,f.target);
 assert.notEqual(run(f.source,f.data,digest(fakeApk)).status,0);assert.equal(readFileSync(outside,'utf8'),'untouched');
});

test('candidate verification detects bytes changed between signing and metadata checks',t=>{
 const f=fixture(t);
 const script=String.raw`
import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location('apk_prepare',sys.argv[1])
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
apk=pathlib.Path(sys.argv[2]); signer='a'*64
def output(args,cwd=None):
 if args[0].endswith('/apksigner'):
  apk.write_bytes(b'PK\x03\x04changed-after-signature-check')
  return 'Signer #1 certificate SHA-256 digest: '+signer
 return "package: name='de.kontrakurs.kontraprompter' versionCode='1' versionName='0.1.0'"
mod.output=output
try:
 mod.verify(apk,pathlib.Path('/nonexistent-sdk'),signer)
except ValueError as error:
 assert 'während der Signaturprüfung verändert' in str(error),str(error)
else:
 raise AssertionError('changed candidate was accepted')
`;
 const result=spawnSync('python3',['-c',script,preparer,f.source],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
});

test('candidate copy rejects oversized, special and symlink sources without touching the destination',t=>{
 const f=fixture(t);
 const script=String.raw`
import importlib.util, os, pathlib, sys
spec=importlib.util.spec_from_file_location('apk_prepare',sys.argv[1])
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
root=pathlib.Path(sys.argv[2]); destination=root/'candidate.apk'
oversized=root/'oversized.apk'
with oversized.open('wb') as stream: stream.truncate(mod.MAX_APK_BYTES+1)
fifo=root/'source.fifo';os.mkfifo(fifo)
symlink=root/'source-link';symlink.symlink_to(root/'source.apk')
for source in [oversized,fifo,symlink,root]:
 try: mod.copy_candidate(source,destination)
 except (OSError,ValueError): pass
 else: raise AssertionError(f'unsafe source accepted: {source}')
 assert not destination.exists()
destination.write_bytes(b'existing');
try: mod.copy_candidate(root/'source.apk',destination)
except FileExistsError: pass
else: raise AssertionError('existing destination overwritten')
assert destination.read_bytes()==b'existing'
destination.unlink();mod.copy_candidate(root/'source.apk',destination)
assert destination.read_bytes()==(root/'source.apk').read_bytes()
assert destination.stat().st_mode & 0o777==0o600
`;
 const result=spawnSync('python3',['-c',script,preparer,f.root],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
});

test('candidate copy aborts and removes partial output if a source grows beyond the limit',t=>{
 const f=fixture(t);
 const script=String.raw`
import importlib.util, os, pathlib, sys
spec=importlib.util.spec_from_file_location('apk_prepare',sys.argv[1])
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
root=pathlib.Path(sys.argv[2]);source=root/'growing.apk';target=root/'partial.apk'
source.write_bytes(b'12345678');mod.MAX_APK_BYTES=8
original_read=os.read
def growing_read(fd,size):
 chunk=original_read(fd,size)
 return chunk+b'9' if chunk else chunk
mod.os.read=growing_read
try:
 try: mod.copy_candidate(source,target)
 except ValueError: pass
 else: raise AssertionError('growing source accepted')
 assert not target.exists()
finally: mod.os.read=original_read
`;
 const result=spawnSync('python3',['-c',script,preparer,f.root],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
});

test('candidate publication never replaces a path created after the initial check',t=>{
 const f=fixture(t);
 const script=String.raw`
import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location('apk_prepare',sys.argv[1])
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
root=pathlib.Path(sys.argv[2]); source=root/'candidate'; target=root/'commit'
source.mkdir(); (source/'apk').write_text('candidate')
target.mkdir()
try: mod.rename_noreplace(source,target)
except FileExistsError: pass
else: raise AssertionError('existing directory was replaced')
assert source.is_dir() and target.is_dir() and not list(target.iterdir())
target.rmdir(); target.symlink_to(root/'absent')
try: mod.rename_noreplace(source,target)
except FileExistsError: pass
else: raise AssertionError('existing symlink was replaced')
assert target.is_symlink() and source.is_dir()
target.unlink(); mod.rename_noreplace(source,target)
assert (target/'apk').read_text()=='candidate'
`;
 const result=spawnSync('python3',['-c',script,preparer,f.root],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
});
