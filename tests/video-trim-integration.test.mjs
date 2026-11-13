import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Opt in only against the dedicated local fixture server, never a production host.
const base=process.env.VIDEOMAKER_TRIM_TEST_SERVER;
const enabled=base==='http://127.0.0.1:3321' && process.env.VIDEOMAKER_TRIM_TEST_ALLOW_WRITES==='1';
test('HTTP trim keeps the original and saves playable video and audio', {skip:!enabled && 'Set up the isolated local fixture server to run this integration test.',timeout:90000}, async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'videomaker-trim-fixture-'));
 let cookie='',projectId='';
 async function request(method,url,body,contentType='application/json',headers={}){
  const h={Origin:base,...headers};if(cookie)h.Cookie=cookie;if(body!==undefined)h['Content-Type']=contentType;
  return fetch(base+url,{method,headers:h,body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
 }
 try {
  const source=path.join(directory,'source.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:v','libx264','-preset','ultrafast','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-shortest','-n',source]);
  let response=await request('POST','/api/login',{password:'local-test-password'});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];
  response=await request('POST','/api/projects',{title:'Schnitt-Integrationstest',script:'Test',sources:[],titles:[],thumbnail:'',broll:[]});assert.equal(response.status,201);projectId=(await response.json()).id;
  const id=randomUUID(),pathPrefix=`/api/projects/${projectId}/recordings`,original=readFileSync(source);
  response=await request('POST',pathPrefix,original,'video/mp4',{'X-Recording-Id':id});assert.equal(response.status,201);
  response=await request('POST',`${pathPrefix}/${id}/trim`,{start:3,end:2});assert.equal(response.status,400);
  response=await request('POST',`${pathPrefix}/${id}/trim`,{start:0,end:10});assert.equal(response.status,400);
  response=await request('POST',`${pathPrefix}/${id}/trim`,{start:1,end:3});assert.equal(response.status,201);const output=(await response.json()).id;
  response=await request('GET',`${pathPrefix}/${id}`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
  response=await request('GET',`${pathPrefix}/${output}`);assert.equal(response.status,200);const result=path.join(directory,'result.mp4');writeFileSync(result,Buffer.from(await response.arrayBuffer()));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',result],{encoding:'utf8'}));
  assert.deepEqual(new Set(probe.streams.map(s=>s.codec_type)),new Set(['video','audio']));assert.ok(Number(probe.format.duration)>1.75&&Number(probe.format.duration)<2.25);
  // Browser MediaRecorder WebM can lack a container duration. It must cut without
  // an unbounded preliminary scan, but a request extending well past EOF must fail.
  const live=path.join(directory,'stream.webm');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x120:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libvpx','-deadline','realtime','-threads','1','-c:a','libopus','-shortest','-f','webm','-live','1','-n',live]);
  const liveProbe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',live],{encoding:'utf8'}));
  assert.ok(!Number.isFinite(Number(liveProbe.format?.duration)));
  const liveId=randomUUID();response=await request('POST',pathPrefix,readFileSync(live),'video/webm',{'X-Recording-Id':liveId});assert.equal(response.status,201);
  response=await request('POST',`${pathPrefix}/${liveId}/trim`,{start:.2,end:1.2});assert.equal(response.status,201);const liveCut=(await response.json()).id;
  response=await request('GET',`${pathPrefix}/${liveCut}`);assert.equal(response.status,200);const liveResult=path.join(directory,'webm-result.mp4');writeFileSync(liveResult,Buffer.from(await response.arrayBuffer()));
  const liveOut=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',liveResult],{encoding:'utf8'}));
  assert.deepEqual(new Set(liveOut.streams.map(s=>s.codec_type)),new Set(['video','audio']));assert.ok(Number(liveOut.format.duration)>.85&&Number(liveOut.format.duration)<1.2);
  response=await request('POST',`${pathPrefix}/${liveId}/trim`,{start:1.8,end:2.8});assert.equal(response.status,422);
 } finally {
  if(projectId)await request('DELETE',`/api/projects/${projectId}`).catch(()=>{});
  rmSync(directory,{recursive:true,force:true});
 }
});
