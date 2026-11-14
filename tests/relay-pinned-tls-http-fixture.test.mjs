import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {OpaqueRendezvous} from '../lib/opaque-rendezvous.ts';

// An opt-in localhost fixture, not an HTTP production interface. The test uses
// synthetic keys, and proves nothing about initial QR pin exchange or Android hardware.
test('mutually pinned TLS 1.3 crosses an opaque HTTP relay; wrong pin fails', {skip:process.env.RELAY_TLS_HTTP_TEST!=='1',timeout:40_000},async()=>{
 const cp=process.env.RELAY_TLS_PROBE_CP, camera=process.env.RELAY_TLS_CAMERA_KEYSTORE, client=process.env.RELAY_TLS_CLIENT_KEYSTORE;
 assert.ok(cp&&camera&&client,'synthetic compiler output and keystores are required');
 const owner='a'.repeat(64),relay=new OpaqueRendezvous();
 const fixtureKeys={owner:randomBytes(32).toString('hex'),guest:randomBytes(32).toString('hex')};
 let room,guest,wire=[],dropResponse=null,dropped=false;
 function newRoom(){const created=relay.create(owner);room=created.roomId;guest=randomBytes(32).toString('base64url');relay.join(room,created.joinTicket,guest);wire=[];dropResponse=null;dropped=false;}
 newRoom();
 const server=createServer(async(req,res)=>{
  try{
   const match=/^\/(owner|guest)\/(peek|send\/([1-9][0-9]*)|ack\/([1-9][0-9]*))$/.exec(req.url??'');
   if(!match||req.headers['x-fixture-key']!==fixtureKeys[match[1]]){res.writeHead(403).end();return;}
   const actor=match[1]==='owner'?{role:'owner',owner}:{role:'guest',credential:guest};
   if(req.method==='GET'&&match[2]==='peek'){
    const item=relay.peek(room,actor);
    if(!item){res.writeHead(204).end();return;}
    res.writeHead(200,{'X-Sequence':String(item.sequence)}).end(item.ciphertext);return;
   }
   if(req.method!=='POST'){res.writeHead(405).end();return;}
   const parts=[];let length=0;
   for await(const part of req){length+=part.length;if(length>16*1024){res.writeHead(413).end();return;}parts.push(part);}
   const body=Buffer.concat(parts);
   if(match[3]){relay.send(room,actor,Number(match[3]),body);wire.push(body);}
   else if(match[4]&&body.length===0)relay.acknowledge(room,actor,Number(match[4]));
   else{res.writeHead(400).end();return;}
   if(!dropped&&((dropResponse==='lost-send'&&match[3])||(dropResponse==='lost-ack'&&match[4]))){dropped=true;res.destroy();return;}
   res.writeHead(200).end();
  }catch{if(!res.headersSent)res.writeHead(400).end();else res.destroy();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 async function probe(wrong){
  const child=spawn('java',['-Xmx96m','-Dsun.net.http.retryPost=false','-cp',cp,'de.kontrakurs.kontraprompter.pairing.RelayTlsHttpProbeKt',url,fixtureKeys.owner,fixtureKeys.guest,camera,client,String(wrong)],{stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
  const timer=setTimeout(()=>child.kill('SIGKILL'),16_000);
  const [code,signal]=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(...args)=>resolve(args));}).finally(()=>clearTimeout(timer));
  assert.equal(code,0,`probe failed (${signal}): ${error}`);
  assert.match(output,wrong==='none'?/PINNED_TLS_OK/:wrong.startsWith('lost-')?/LOST_RESPONSE_ABORTED/:/WRONG_PIN_REJECTED/);
 }
 try{
  await probe('none');
  assert.ok(wire.length>0);
  const traffic=Buffer.concat(wire);
  for(const marker of ['fixture-camera-secret-unique-486921','fixture-prompter-secret-unique-798351'])assert.equal(traffic.includes(marker),false);
  relay.close(room,owner);newRoom();
  await probe('server');
  relay.close(room,owner);newRoom();
  await probe('client');
  for(const failure of ['lost-send','lost-ack']){
   relay.close(room,owner);newRoom();dropResponse=failure;
   await probe(failure);assert.equal(dropped,true);
  }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
