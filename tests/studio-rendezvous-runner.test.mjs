import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

test('local fixture uses private synthetic sessions, admits create and cleans its own files', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'kp-studio-runner-test-')),infoPath=join(directory,'fixture.json'),child=spawn(process.execPath,['--max-old-space-size=96','--experimental-strip-types',new URL('../experiments/studio-rendezvous/run-local-fixture.mjs',import.meta.url).pathname,directory],{env:{...process.env,NODE_ENV:'test',VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>{output+=x;});
 try{
  const deadline=Date.now()+5000;while(!existsSync(infoPath)){if(child.exitCode!==null||Date.now()>deadline)throw Error('fixture start failed');await delay(20);}
  assert.equal(statSync(directory).mode&0o777,0o700);assert.equal(statSync(infoPath).mode&0o777,0o600);const info=JSON.parse(readFileSync(infoPath,'utf8'));assert.ok(!output.includes(info.camera.cookie));
  const response=await fetch(info.baseUrl+'/fixture/rooms',{method:'POST',headers:{origin:'https://videomaker.dorfspy.de','content-type':'application/json',cookie:info.camera.cookie},body:JSON.stringify({deviceId:info.camera.deviceId,attemptId:'11111111-1111-4111-8111-111111111111'})});assert.equal(response.status,200);
  const control=connect(info.controlSocket);await once(control,'connect');control.write('{"op":"stop"}\n');let reply='';for await(const block of control)reply+=block;assert.equal(JSON.parse(reply).ok,true);
  const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(existsSync(infoPath),false);assert.equal(existsSync(info.controlSocket),false);
 }finally{if(child.exitCode===null)child.kill('SIGTERM');rmSync(directory,{recursive:true,force:true});}
});
