import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';

const enabled=process.env.ORIGIN_POLICY_TEST_ALLOW_WRITES==='1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
 const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test('isolated HTTP preserves legacy mode and validates configured scheme and host',{skip:!enabled,timeout:180_000},async()=>{
 if(process.platform!=='linux')throw new Error('Dieser isolierte Prozessgruppentest benötigt Linux.');
 // All data is created by this test. Never accept a caller-supplied DATA_DIR.
 const fixture=mkdtempSync(join(tmpdir(),'videomaker-origin-test-'));
 const port=await freePort(),base=`http://127.0.0.1:${port}`,external='https://videomaker.dorfspy.de';
 const next=join(process.cwd(),'node_modules/next/dist/bin/next');let child,log='';
 async function start(configured){
  log='';
  const env={...process.env,NODE_ENV:'development',DATA_DIR:fixture,ADMIN_PASSWORD:'origin-local-test',SESSION_SECRET:'local-origin-test-secret-32-characters-minimum'};
  if(configured)env.VIDEOMAKER_PUBLIC_ORIGIN=external;else delete env.VIDEOMAKER_PUBLIC_ORIGIN;
  child=spawn(process.execPath,[next,'dev','-H','127.0.0.1','-p',String(port)],{cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe'],env});
  child.stdout.on('data',chunk=>{log+=chunk.toString();});child.stderr.on('data',chunk=>{log+=chunk.toString();});
  for(let i=0;i<400;i++){
   if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture startete nicht: ${log.slice(-1200)}`);
   if(log.includes('Ready'))try{if((await fetch(base+'/api/health')).ok)return;}catch{}
   await sleep(50);
  }
  throw new Error('Zeitlimit beim Start der isolierten Origin-Fixture.');
 }
 async function stop(){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const proc=child;process.kill(-proc.pid,'SIGTERM');
  for(let i=0;i<200&&proc.exitCode===null&&proc.signalCode===null;i++)await sleep(25);
  if(proc.exitCode===null&&proc.signalCode===null)throw new Error('Origin-Fixture konnte nicht beendet werden.');
 }
 async function post(path,origin,host,extra={},cookie=''){
  // Node fetch normalizes Host to the destination; raw HTTP preserves the
  // external Host that Caddy forwards and allows explicit spoofing cases.
  return new Promise((resolve,reject)=>{
   const request=httpRequest(base+path,{method:'POST',headers:{Origin:origin,Host:host,'Content-Type':'application/json',...extra,...(cookie?{Cookie:cookie}:{})}},response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
   });
   request.on('error',reject);request.end(JSON.stringify({password:'origin-local-test'}));
  });
 }
 try{
  await start(true);
  const host='videomaker.dorfspy.de';
  let response=await post('/api/login',external,host,{'X-Forwarded-Host':'evil.example','X-Forwarded-Proto':'http'});
  assert.equal(response.status,200,`configured login: ${response.body}`);const cookie=response.headers['set-cookie']?.[0].split(';',1)[0];assert.ok(cookie);
  for(const origin of ['http://'+host,'https://evil.example',external+'/path','null']){
   response=await post('/api/login',origin,host,{'X-Forwarded-Host':host,'X-Forwarded-Proto':'https'});
   assert.equal(response.status,403,origin);
  }
  response=await post('/api/login',external,'evil.example',{'X-Forwarded-Host':host,'X-Forwarded-Proto':'https'});assert.equal(response.status,403);
  response=await post('/api/logout',external,host,{},cookie);assert.equal(response.status,200);
  await stop();
  await start(false);
  // Existing direct HTTP fixture remains functional with no new configuration.
  response=await post('/api/login',base,`127.0.0.1:${port}`);assert.equal(response.status,200);
 }finally{
  await stop().catch(()=>{});
  rmSync(fixture,{recursive:true,force:true});
 }
});
