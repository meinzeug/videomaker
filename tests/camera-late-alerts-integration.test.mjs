// Explicitly marked disposable local dev server only; never a public host.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {uploadCameraRecovery} from '../lib/camera-recovery-client.ts';

const base=process.env.CAMERA_LATE_TEST_SERVER,dir=process.env.CAMERA_LATE_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3335'&&process.env.CAMERA_LATE_TEST_ALLOW_WRITES==='1'&&typeof dir==='string';
test('paired late error survives project deletion without changing the verified receipt',{skip:!enabled,timeout:120000},async()=>{
 const resolved=realpathSync(dir);assert.equal(path.dirname(resolved),'/tmp');assert.match(path.basename(resolved),/^camera-late-e2e-[A-Za-z0-9]+$/);
 assert.equal(readFileSync(path.join(resolved,'disposable-fixture'),'utf8'),'camera-late-fixture\n');
 let cookie='';
 const post=(url,body,extra={})=>fetch(base+url,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 const login=await post('/api/login',{password:'camera-late-test'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
 const source=randomUUID(),{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({type:'spki',format:'der'});
 async function prove(action){
  let response=await post('/api/camera-devices/pairing/challenge',{deviceId:source,action});assert.equal(response.status,200);
  const challenge=await response.json(),payload=action==='register'?spki:Buffer.alloc(0),hash=createHash('sha256').update(payload).digest('hex');
  const message=`videomaker-camera-device-auth/v2\n${source}\n${challenge.challengeId}\n${challenge.challenge}\n${action}\n${hash}\n`;
  response=await post('/api/camera-devices/pairing/complete',{deviceId:source,action,challengeId:challenge.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),privateKey).toString('base64url')});assert.equal(response.status,200);return response.json();
 }
 assert.equal((await prove('register')).registered,true);const {ticket}=await prove('session');
 let sequence=0;const heartbeat=(phase,recordingId=null,projectId=null,extra={})=>({id:source,sequence:++sequence,name:'Testkamera',capability:'remote-record-v1',phase,recordingId,projectId,ack:[],...extra});
 const poll=(input,proof=ticket)=>post('/api/camera-devices/poll',input,{'x-camera-device-ticket':proof});
 assert.equal((await poll(heartbeat('idle'))).status,200);
 const created=await post('/api/projects',{title:'Synthetischer Spätmeldungstest',script:'Testtext',sources:[],titles:[],thumbnail:'',broll:[]});assert.equal(created.status,201);
 const project=(await created.json()).id,recording=randomUUID(),command=randomUUID(),bytes=Buffer.from('synthetische Testdaten, kein Video');
 const proof={sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 assert.equal((await post(`/api/camera-devices/${source}/commands`,{id:command,type:'record_start',recordingId:recording,projectId:project})).status,201);
 assert.equal((await poll(heartbeat('idle'))).status,200);
 assert.equal((await poll(heartbeat('recording',recording,project,{ack:[{id:command,result:'accepted'}]}))).status,200);
 assert.equal((await poll(heartbeat('ready',recording,project,proof))).status,200);
 const request=(url,options)=>fetch(base+url,{...options,headers:{...options.headers,cookie,origin:base}});
 const receipt=await uploadCameraRecovery(new Blob([bytes]),project,recording,proof,new AbortController().signal,request);
 const db=new Database(path.join(resolved,'videomaker.sqlite'),{fileMustExist:true,readonly:true});
 try{
  assert.notEqual(db.prepare('SELECT closed_at FROM camera_project_claims WHERE recording_id=?').get(recording).closed_at,null);
  const proofBefore=db.prepare('SELECT * FROM camera_project_upload_receipts WHERE recording_id=?').get(recording);
  assert.equal((await poll(heartbeat('error',recording,project),'forged-ticket')).status,403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_late_alerts WHERE recording_id=?').get(recording).n,0);
  const error=heartbeat('error',recording,project);assert.equal((await poll(error)).status,200);
  assert.equal((await poll(error)).status,409);
  assert.equal((await poll(heartbeat('error',recording,project))).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_late_alerts WHERE recording_id=?').get(recording).n,1);
  assert.deepEqual(db.prepare('SELECT * FROM camera_project_upload_receipts WHERE recording_id=?').get(recording),proofBefore);
  // A new signing identity cannot take over the former device ID or report
  // a late alert for the old device's recording.
  assert.equal((await post('/api/camera-devices/pairing/challenge',{deviceId:source,action:'register'})).status,409);
  const other=randomUUID(),otherKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),otherSpki=otherKey.publicKey.export({type:'spki',format:'der'});
  async function otherProof(action){
   let r=await post('/api/camera-devices/pairing/challenge',{deviceId:other,action});assert.equal(r.status,200);const challenge=await r.json();
   const payload=action==='register'?otherSpki:Buffer.alloc(0),hash=createHash('sha256').update(payload).digest('hex');
   const message=`videomaker-camera-device-auth/v2\n${other}\n${challenge.challengeId}\n${challenge.challenge}\n${action}\n${hash}\n`;
   r=await post('/api/camera-devices/pairing/complete',{deviceId:other,action,challengeId:challenge.challengeId,payload:payload.toString('base64url'),signature:sign('sha256',Buffer.from(message),otherKey.privateKey).toString('base64url')});assert.equal(r.status,200);return r.json();
  }
  await otherProof('register');const otherTicket=(await otherProof('session')).ticket;
  assert.equal((await post('/api/camera-devices/poll',{id:other,sequence:1,name:'Anderes Testgerät',capability:'remote-record-v1',phase:'error',recordingId:recording,projectId:project,ack:[]},{'x-camera-device-ticket':otherTicket})).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_late_alerts WHERE recording_id=?').get(recording).n,1);
  let response=await fetch(base+'/api/camera-devices/alerts',{headers:{cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  let page=await response.json();assert.equal(page.alerts.filter(item=>item.recordingId===recording).length,1);
  assert.equal(typeof page.capacityReached,'boolean');
  for(const query of ['?before=0','?before=1.5','?before=1&before=2'])assert.equal((await fetch(base+'/api/camera-devices/alerts'+query,{headers:{cookie}})).status,400);
  const download=await fetch(base+`/api/projects/${project}/recordings/${receipt.uploadId}?download=1`,{headers:{cookie}});assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  // Deleting this synthetic project deliberately exercises orphaned alert visibility.
  assert.equal((await fetch(base+`/api/projects/${project}`,{method:'DELETE',headers:{origin:base,cookie}})).status,200);
  assert.equal((await poll(heartbeat('partial',recording,project,proof))).status,200);
  response=await fetch(base+'/api/camera-devices/alerts',{headers:{cookie}});page=await response.json();
  const matching=page.alerts.filter(item=>item.recordingId===recording);assert.equal(matching.length,2);assert.ok(matching.every(item=>item.projectTitle===null&&item.projectId===project));
  assert.deepEqual(db.prepare('SELECT * FROM camera_project_upload_receipts WHERE recording_id=?').get(recording),proofBefore);
  const conflict=heartbeat('partial',recording,project,{sizeBytes:proof.sizeBytes,sha256:'e'.repeat(64)});
  response=await poll(conflict);assert.equal(response.status,409);const rejection=await response.json();
  assert.deepEqual({code:rejection.code,deviceId:rejection.deviceId,recordingId:rejection.recordingId,projectId:rejection.projectId,phase:rejection.phase,sequence:rejection.sequence,sizeBytes:rejection.sizeBytes,sha256:rejection.sha256},
   {code:'camera_late_report_conflict',deviceId:source,recordingId:recording,projectId:project,phase:'partial',sequence:conflict.sequence,sizeBytes:conflict.sizeBytes,sha256:conflict.sha256});
  assert.equal((await poll(heartbeat('idle'))).status,200,'a later nonconflicting poll remains possible');
  // Fill only this disposable fixture's audit quota. The next late event is
  // retryable (503), and its device sequence must remain uncommitted.
  const quotaRecording=randomUUID(),quotaUpload=(await import('../lib/camera-project-claims.ts')).cameraUploadIdFor(quotaRecording,project);
  const writer=new Database(path.join(resolved,'videomaker.sqlite'),{fileMustExist:true});
  try{writer.transaction(()=>{
   writer.prepare('INSERT INTO camera_project_claims VALUES(?,?,?,?,?)').run(quotaRecording,source,project,1,2);
   writer.prepare('INSERT INTO camera_project_upload_ids VALUES(?,?,?)').run(quotaUpload,quotaRecording,project);
   writer.prepare("INSERT INTO camera_project_device_manifests VALUES(?,?,?,'ready',?,?,?)").run(quotaRecording,project,source,proof.sizeBytes,proof.sha256,2);
   writer.prepare('INSERT INTO camera_project_upload_receipts VALUES(?,?,?,?,?,?)').run(quotaRecording,project,quotaUpload,proof.sha256,proof.sizeBytes,2);
   const count=writer.prepare('SELECT count(*) AS n FROM camera_late_alerts').get().n;
   const insert=writer.prepare("INSERT INTO camera_late_alerts(recording_id,project_id,device_id,phase,sequence,observed_at) VALUES(?,?,?,'error',?,?)");
   for(let i=count;i<10000;i++)insert.run(randomUUID(),project,source,1,1);
  }).immediate();}finally{writer.close();}
  page=await (await fetch(base+'/api/camera-devices/alerts',{headers:{cookie}})).json();assert.equal(page.capacityReached,true);
  const quotaReport=heartbeat('error',quotaRecording,project),beforeSequence=db.prepare('SELECT sequence FROM camera_remote_devices WHERE id=?').get(source).sequence;
  assert.equal((await poll(quotaReport)).status,503);assert.equal((await poll(quotaReport)).status,503);
  assert.equal(db.prepare('SELECT sequence FROM camera_remote_devices WHERE id=?').get(source).sequence,beforeSequence);
  assert.equal(db.prepare('SELECT count(*) AS n FROM camera_late_alerts WHERE recording_id=?').get(quotaRecording).n,0);
  assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{origin:base,cookie}})).status,200);
  assert.equal((await fetch(base+'/api/camera-devices/alerts',{headers:{cookie}})).status,401);
  assert.equal((await fetch(base+'/api/camera-devices/alerts?before=invalid',{headers:{cookie}})).status,401);
 }finally{db.close();}
});
