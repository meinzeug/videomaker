import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {initializePairedWebFixture,issuePairedWebTicketFixture,reportPairedCameraFixture,queuePairedWebCommandFixture,pollPairedWebCommandFixture,acknowledgePairedWebCommandFixture} from '../experiments/paired-web-camera/core.mjs';
process.env.NODE_ENV='test';process.env.PAIRED_WEB_CAMERA_FIXTURE='1';
function setup(db=new Database(':memory:')){
 db.pragma('foreign_keys=ON');initializePairedWebFixture(db);const identity={owner:'a'.repeat(64),session:'b'.repeat(64),deviceId:randomUUID(),pairEpoch:randomUUID()},browser='c'.repeat(64),project=randomUUID(),runtimeId=randomUUID();let t=1000,deviceAllowed=true,browserAllowed=true;
 const clock=()=>({runtimeId,wall:t,tick:t}),authorize=(value,kind)=>value.owner===identity.owner&&(kind==='device'?deviceAllowed&&value.session===identity.session&&value.deviceId===identity.deviceId&&value.pairEpoch===identity.pairEpoch:browserAllowed&&value.session===browser),projectExists=value=>value===project;
 const ticket=issuePairedWebTicketFixture(db,identity,clock,authorize).ticket;
 const state=(revision,phase='idle',recordingId=null,projectId=null,front=false,confirmedCommandId=null)=>({revision,phase,recordingId,projectId,front,confirmedCommandId});
 const report=value=>reportPairedCameraFixture(db,identity,ticket,value,clock,authorize);
 const command=(revision=1,action='start',recordingId=randomUUID(),projectId=action==='start'?project:null,expectedFront=null)=>({id:randomUUID(),action,recordingId,projectId,expectedFront,expectedRevision:revision});
 const queue=cmd=>queuePairedWebCommandFixture(db,identity,ticket,browser,cmd,clock,authorize,projectExists);
 const poll=()=>pollPairedWebCommandFixture(db,identity,ticket,clock,authorize);
 const ack=(id,accepted)=>acknowledgePairedWebCommandFixture(db,identity,ticket,id,accepted,clock,authorize);
 return {db,identity,browser,project,ticket,clock,authorize,state,report,command,queue,poll,ack,projectExists,setTime:value=>{t=value;},revokeDevice:()=>{deviceAllowed=false;},revokeBrowser:()=>{browserAllowed=false;}};
}

test('ticket is bound to session, device, pairing epoch and does not store bearer secret',()=>{
 const f=setup();try{assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM pwc_tickets').get()).includes(f.ticket),false);
  for(const changes of [{session:'d'.repeat(64)},{deviceId:randomUUID()},{pairEpoch:randomUUID()},{owner:'e'.repeat(64)}])assert.throws(()=>reportPairedCameraFixture(f.db,{...f.identity,...changes},f.ticket,f.state(1),f.clock,()=>true));
  assert.deepEqual(f.report(f.state(1)),{revision:1});assert.throws(()=>f.report(f.state(1)));
 }finally{f.db.close();}
});

test('start is offered only once and requires explicit accepted plus correlated camera state',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();assert.equal(f.queue(c).created,true);assert.equal(f.queue(c).created,false);assert.throws(()=>f.queue({...c,recordingId:randomUUID()}));
  const delivery=f.poll();assert.equal(delivery.id,c.id);assert.deepEqual(f.poll(),{empty:true,stage:'delivered'});
  f.report(f.state(2,'recording',c.recordingId,c.projectId));assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'delivered');
  assert.equal(f.ack(c.id,true).stage,'admitted');assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'admitted');
  f.report(f.state(3,'recording',c.recordingId,c.projectId,false,c.id));assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'confirmed');
 }finally{f.db.close();}
});

test('newer state supersedes queued command before delivery',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();f.queue(c);f.report(f.state(2,'recording',randomUUID(),null));assert.deepEqual(f.poll(),{empty:true,stage:'superseded'});assert.equal(f.queue(c).stage,'superseded');}finally{f.db.close();}
});

test('unacknowledged delivered command becomes uncertain and blocks new actions',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();f.queue(c);assert.equal(f.poll().id,c.id);f.setTime(11000);assert.deepEqual(f.poll(),{empty:true,stage:'uncertain'});
  f.report(f.state(2));assert.throws(()=>f.queue(f.command(2)));f.report(f.state(3,'recording',c.recordingId,c.projectId,false,c.id));assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'uncertain');
 }finally{f.db.close();}
});

test('expired never-delivered request does not later execute',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();f.queue(c);f.setTime(11000);assert.deepEqual(f.poll(),{empty:true,stage:'expired'});assert.equal(f.queue(c).stage,'expired');}finally{f.db.close();}
});

test('pause, resume, stop and switch require exact current take and camera facing',()=>{
 const f=setup();try{const take=randomUUID();f.report(f.state(1,'recording',take,f.project));assert.throws(()=>f.queue(f.command(1,'pause',randomUUID())));
  const pause=f.command(1,'pause',take);f.queue(pause);assert.equal(f.poll().id,pause.id);assert.equal(f.ack(pause.id,false).stage,'rejected');
  assert.throws(()=>f.queue(f.command(1,'resume',take)));assert.throws(()=>f.queue({...f.command(1,'switch'),expectedFront:false}));
  f.report(f.state(2,'paused',take,f.project));const resume=f.command(2,'resume',take);f.queue(resume);assert.equal(f.poll().id,resume.id);
 }finally{f.db.close();}
});

test('stale state and revoked browser session fail closed',()=>{
 const f=setup();try{f.report(f.state(1));f.setTime(4000);assert.throws(()=>f.queue(f.command()));f.report(f.state(2));f.revokeBrowser();assert.throws(()=>f.queue(f.command(2)));assert.equal(f.db.prepare('SELECT count(*) n FROM pwc_commands').get().n,0);}finally{f.db.close();}
});

test('logout during command creation rolls back the new command',()=>{
 const f=setup();try{f.report(f.state(1));let browserChecks=0;const auth=(value,kind)=>kind==='browser'?++browserChecks<2:f.authorize(value,kind);const c=f.command();
  assert.throws(()=>queuePairedWebCommandFixture(f.db,f.identity,f.ticket,f.browser,c,f.clock,auth,f.projectExists));assert.equal(f.db.prepare('SELECT count(*) n FROM pwc_commands').get().n,0);
 }finally{f.db.close();}
});

test('ticket expiry is durable after wall-clock rollback and foreign boot cannot revoke it',()=>{
 const f=setup();try{assert.throws(()=>pollPairedWebCommandFixture(f.db,f.identity,f.ticket,()=>({...f.clock(),runtimeId:randomUUID()}),f.authorize));assert.equal(f.db.prepare('SELECT revoked FROM pwc_tickets').get().revoked,0);
  f.setTime(61000);assert.throws(f.poll);assert.equal(f.db.prepare('SELECT revoked FROM pwc_tickets').get().revoked,1);f.setTime(1000);assert.throws(f.poll);
 }finally{f.db.close();}
});

test('device logout invalidates ticket without leaking queued data',()=>{
 const f=setup();try{f.report(f.state(1));f.queue(f.command());f.revokeDevice();assert.throws(f.poll);assert.equal(f.db.prepare('SELECT revoked FROM pwc_tickets').get().revoked,1);}finally{f.db.close();}
});

test('fixture cannot be enabled in production',()=>{
 const f=setup();try{process.env.NODE_ENV='production';assert.throws(f.poll,/FIXTURE_DISABLED/);}finally{process.env.NODE_ENV='test';f.db.close();}
});

test('concurrent processes can offer one command at most once', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vm-paired-web-')),path=join(directory,'state.sqlite'),f=setup(new Database(path));
 try{f.report(f.state(1));f.queue(f.command());const payload=JSON.stringify({path,identity:f.identity,ticket:f.ticket,clock:f.clock()});
  const run=()=>{const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/paired-web-poll-worker.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','ignore']});let output='';child.stdout.on('data',x=>{output+=x;});child.stdin.end(payload);return once(child,'exit').then(([code])=>({code,value:code===0?JSON.parse(output):null}));};
  const results=await Promise.all([run(),run()]);assert.ok(results.every(x=>x.code===0));assert.equal(results.filter(x=>x.value.delivered).length,1);assert.equal(results.filter(x=>x.value.empty).length,1);
 }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('reentrant callbacks cannot retarget the immutable command snapshot',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command(),original=c.recordingId;
  const exists=project=>{c.recordingId=randomUUID();return project===f.project;};
  const queued=queuePairedWebCommandFixture(f.db,f.identity,f.ticket,f.browser,c,f.clock,f.authorize,exists);assert.equal(queued.created,true);
  assert.equal(f.db.prepare('SELECT recording_id FROM pwc_commands').get().recording_id,original);assert.equal(f.poll().recordingId,original);
 }finally{f.db.close();}
});

test('late authorization failure cannot commit an offered command',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();f.queue(c);let checks=0;const auth=(value,kind)=>kind==='device'?++checks<2:f.authorize(value,kind);
  assert.throws(()=>pollPairedWebCommandFixture(f.db,f.identity,f.ticket,f.clock,auth));assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'queued');assert.equal(f.db.prepare('SELECT revoked FROM pwc_tickets').get().revoked,1);
 }finally{f.db.close();}
});

test('browser logout before polling cancels the queued command without delivery',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();f.queue(c);f.revokeBrowser();assert.deepEqual(f.poll(),{empty:true,stage:'cancelled'});assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'cancelled');assert.deepEqual(f.poll(),{empty:true});}finally{f.db.close();}
});

test('browser logout during delivery rolls back the offer',()=>{
 const f=setup();try{f.report(f.state(1));const c=f.command();f.queue(c);let browserChecks=0;
  const auth=(value,kind)=>kind==='browser'?++browserChecks<2:f.authorize(value,kind);
  assert.throws(()=>pollPairedWebCommandFixture(f.db,f.identity,f.ticket,f.clock,auth));assert.equal(f.db.prepare('SELECT stage FROM pwc_commands').get().stage,'queued');
  f.revokeBrowser();assert.deepEqual(f.poll(),{empty:true,stage:'cancelled'});
 }finally{f.db.close();}
});

test('late project removal rolls back queued start',()=>{
 const f=setup();try{f.report(f.state(1));let checks=0;const exists=()=>++checks<2;
  assert.throws(()=>queuePairedWebCommandFixture(f.db,f.identity,f.ticket,f.browser,f.command(),f.clock,f.authorize,exists));assert.equal(f.db.prepare('SELECT count(*) n FROM pwc_commands').get().n,0);
 }finally{f.db.close();}
});
