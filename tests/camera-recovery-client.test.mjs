import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {cameraRecoveryUploadId,uploadCameraRecovery} from '../lib/camera-recovery-client.ts';
import {cameraUploadIdFor} from '../lib/camera-project-claims.ts';

const payload=new Blob([new Uint8Array([1,2,3,4,5])],{type:'video/mp4'});
const proof={sizeBytes:payload.size,sha256:createHash('sha256').update(Buffer.from([1,2,3,4,5])).digest('hex')};

test('browser upload identity matches the server for many recording and project IDs',()=>{
 for(let i=0;i<40;i++){const recording=randomUUID(),project=randomUUID();assert.equal(cameraRecoveryUploadId(recording,project),cameraUploadIdFor(recording,project));}
 assert.throws(()=>cameraRecoveryUploadId('invalid',randomUUID()));
});

test('recovery sends the exact file, manifest and stable identity and verifies the server receipt',async()=>{
 const recording=randomUUID(),project=randomUUID(),signal=new AbortController().signal,uploadId=cameraRecoveryUploadId(recording,project);
 const result=await uploadCameraRecovery(payload,project,recording,proof,signal,async(url,options)=>{
  assert.equal(url,`/api/projects/${project}/recordings`);assert.equal(options.method,'POST');
  assert.equal(options.headers['X-Recording-Id'],uploadId);assert.equal(options.headers['X-Camera-Recording-Id'],recording);
  assert.equal(options.headers['X-Content-SHA256'],proof.sha256);assert.equal(options.headers['Content-Type'],'video/mp4');
  assert.deepEqual(Buffer.from(await options.body.arrayBuffer()),Buffer.from([1,2,3,4,5]));
  return Response.json({id:uploadId,projectId:project,sizeBytes:proof.sizeBytes,sha256:proof.sha256},{status:201});
 });
 assert.deepEqual(result,{uploadId,projectId:project,...proof});
});

test('wrong file, size, proof or cancellation never starts an upload',async()=>{
 const recording=randomUUID(),project=randomUUID(),controller=new AbortController();let attempts=0;
 const request=async()=>{attempts++;throw Error('must not upload');};
 await assert.rejects(uploadCameraRecovery(payload,project,recording,{...proof,sizeBytes:99},controller.signal,request),/Dateigröße/);
 await assert.rejects(uploadCameraRecovery(payload,project,recording,{...proof,sha256:'b'.repeat(64)},controller.signal,request),/stimmt nicht/);
 await assert.rejects(uploadCameraRecovery(payload,project,recording,{...proof,sha256:'bad'},controller.signal,request),/ungültig/);
 controller.abort();await assert.rejects(uploadCameraRecovery(payload,project,recording,proof,controller.signal,request));
 assert.equal(attempts,0);
});

test('network error and unexpected server receipt cannot be represented as confirmation',async()=>{
 const recording=randomUUID(),project=randomUUID(),signal=new AbortController().signal;
 await assert.rejects(uploadCameraRecovery(payload,project,recording,proof,signal,async()=>new Response('',{status:409})),/nicht bestätigt/);
 await assert.rejects(uploadCameraRecovery(payload,project,recording,proof,signal,async()=>Response.json({id:'different',projectId:project,...proof})),/nicht überein/);
 await assert.rejects(uploadCameraRecovery(payload,project,recording,proof,signal,async()=>{throw Error('offline');}),/offline/);
});
