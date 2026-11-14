import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {initializeStudioRateFixture,admitStudioRateFixture} from '../experiments/studio-rendezvous/rate-limit.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
function setup(db=new Database(':memory:')){
 db.pragma('foreign_keys=ON');initializeStudioRateFixture(db);const secret=randomBytes(32),runtimeId=randomUUID(),identity={ip:'127.0.0.1',ownerHash:'a'.repeat(64),sessionHash:'b'.repeat(64)},policy={ip:3,owner:3,session:3};let tick=100;
 const clock=()=>({runtimeId,tick}),admit=(fields=identity,source=clock)=>admitStudioRateFixture(db,fields,secret,source,policy);
 return {db,secret,identity,clock,admit,setTime:value=>{tick=value;}};
}

test('shared counters bound IP, owner and session without retaining raw identity',()=>{
 const f=setup();try{for(let i=0;i<3;i++)assert.equal(f.admit(),true);assert.equal(f.admit(),false);
  const rows=f.db.prepare('SELECT scope,key_hash FROM studio_signal_rates').all();assert.equal(rows.length,3);assert.equal(JSON.stringify(rows).includes(f.identity.ip),false);assert.equal(JSON.stringify(rows).includes(f.identity.sessionHash),false);
  f.setTime(10100);assert.equal(f.admit(),true);
 }finally{f.db.close();}
});

test('foreign runtimes cannot reset or erase limits and backwards clock blocks permanently',()=>{
 const f=setup();try{assert.equal(f.admit(),true);assert.equal(f.admit(f.identity,()=>({...f.clock(),runtimeId:randomUUID()})),false);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates WHERE blocked=1').get().n,0);
  f.setTime(99);assert.equal(f.admit(),false);f.setTime(20000);assert.equal(f.admit(),false);assert.ok(f.db.prepare('SELECT count(*) n FROM studio_signal_rates WHERE blocked=1').get().n>0);
 }finally{f.db.close();}
});

test('IP normalization combines IPv4-mapped and equivalent IPv6 identities',()=>{
 const f=setup();try{assert.equal(f.admit({ip:'127.0.0.1'}),true);assert.equal(f.admit({ip:'::ffff:127.0.0.1'}),true);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates').get().n,1);
  assert.equal(f.admit({ip:'2001:0db8:0000:0000:0000:0000:0000:0001'}),true);assert.equal(f.admit({ip:'2001:db8::1'}),true);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates').get().n,2);assert.equal(f.admit({ip:'invalid'}),false);
 }finally{f.db.close();}
});

test('two processes share an atomic rate limit', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-studio-rate-')),path=join(directory,'state.sqlite'),f=setup(new Database(path));
 try{const payload=JSON.stringify({path,identity:f.identity,secret:f.secret.toString('base64'),clock:f.clock()});
  const run=()=>{const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/studio-rate-worker.mjs',import.meta.url).pathname],{stdio:['pipe','ignore','ignore']});child.stdin.end(payload);return once(child,'exit').then(([code])=>code);};
  const result=await Promise.all([run(),run(),run(),run()]);assert.equal(result.filter(x=>x===0).length,3);assert.equal(result.filter(x=>x===2).length,1);
 }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('rate fixture is unavailable in production',()=>{const f=setup();try{process.env.NODE_ENV='production';assert.throws(()=>f.admit(),/FIXTURE_DISABLED/);}finally{process.env.NODE_ENV='test';f.db.close();}});

test('expired same-runtime counters can be reclaimed without erasing foreign or blocked entries',()=>{
 const f=setup();try{
  const insert=f.db.prepare('INSERT INTO studio_signal_rates VALUES(?,?,?,?,?,?)'),runtime=f.clock().runtimeId,foreign=randomUUID();
  for(let i=0;i<100;i++)insert.run('ip',i.toString(16).padStart(64,'0'),runtime,100,1,0);
  insert.run('ip','f'.repeat(64),foreign,100,1,0);insert.run('ip','e'.repeat(64),runtime,100,1,1);
  f.setTime(10100);assert.equal(f.admit(),true);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates WHERE runtime_id=? AND blocked=0').get(runtime).n,3);
  assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates WHERE runtime_id=?').get(foreign).n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM studio_signal_rates WHERE blocked=1').get().n,1);
 }finally{f.db.close();}
});
