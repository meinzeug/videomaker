import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cameraPreviewEnabled} from '../lib/camera-preview-feature.ts';
import {CameraPreviewStore,validatePreviewCandidate} from '../lib/camera-preview-store.ts';
const runtime=randomUUID(),owner='a'.repeat(64),other='b'.repeat(64),clock=n=>({runtimeId:runtime,wall:n,tick:n});
const offer='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=recvonly\r\n';
const answer='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=sendonly\r\n';
const ice=(id=randomUUID(),address='192.168.1.10')=>({id,kind:'ice',data:`candidate:1 1 udp 2122260223 ${address} 55600 typ host generation 0`,mid:'0',mLineIndex:0});
const empty={after:0,events:[]};
function fixture(){const store=new CameraPreviewStore(),deviceId=randomUUID(),sessionId=randomUUID(),body={generation:runtime,creationToken:store.availableDevices(clock(1000),owner).creationToken,sessionId,deviceId,offer};const device=(now,extra={})=>store.deviceExchange(deviceId,{sessionId:null,after:0,events:[],available:true,...extra},clock(now));return {store,deviceId,sessionId,body,device};}
test('feature requires both local opt-ins and known node runtime; production never enabled',()=>{
 assert.equal(cameraPreviewEnabled('development','1','1','nodejs'),true);assert.equal(cameraPreviewEnabled('test','1','1','nodejs'),true);
 for(const v of [['production','1','1','nodejs'],['development','1','1','edge'],['development','1','1',undefined],['development','1',undefined,'nodejs'],['development',undefined,'1','nodejs']])assert.equal(cameraPreviewEnabled(...v),false);
});
test('only recently authorized device may create one owner-bound session',()=>{
 const f=fixture();assert.throws(()=>f.store.create(f.body,owner,clock(1000),true),/nicht freigegeben/);
 f.device(1000);const created=f.store.create(f.body,owner,clock(1001),true);assert.equal(created.created,true);assert.equal(created.leaseRemainingMs,9999);assert.equal(f.store.create(f.body,owner,clock(1002),true).created,false);
 assert.throws(()=>f.store.create({...f.body,offer:offer+'a=mid:0\r\n'},owner,clock(1003),true),/anders belegt/);
 const otherToken=f.store.availableDevices(clock(1003),other).creationToken;
 assert.throws(()=>f.store.create({...f.body,creationToken:otherToken,sessionId:randomUUID()},other,clock(1003),true),/bereits eine Vorschau/);
 assert.throws(()=>f.store.browserExchange(f.sessionId,other,empty,clock(1004)),/nicht gefunden/);
 assert.deepEqual(f.store.close(f.sessionId,other,clock(1005)),{closed:true});assert.equal(f.store.browserExchange(f.sessionId,owner,empty,clock(1006)).sessionId,f.sessionId);
 f.store.close(f.sessionId,owner,clock(1007));assert.throws(()=>f.store.create(f.body,owner,clock(1008),true),/bereits beendet/);
});
test('offer, answer and ICE are ordered, replay-safe, owner-bound and retryable',()=>{
 const f=fixture();f.device(1000);f.store.create(f.body,owner,clock(1001),true);
 const discovered=f.device(1002).session;assert.equal(discovered.events[0].kind,'offer');assert.equal(discovered.events[0].seq,1);
 assert.equal(f.device(1003).session.events[0].id,f.sessionId); // lost response replays
 const answerEvent={id:randomUUID(),kind:'answer',data:answer,mid:null,mLineIndex:null};
 f.device(1004,{sessionId:f.sessionId,after:1,events:[answerEvent]});
 const incoming=f.store.browserExchange(f.sessionId,owner,empty,clock(1005));assert.equal(incoming.events[0].kind,'answer');
 assert.throws(()=>f.store.browserExchange(f.sessionId,owner,{after:2,events:[]},clock(1006)),/Bestätigung/);
 const candidate=ice();f.store.browserExchange(f.sessionId,owner,{after:1,events:[candidate]},clock(1007));
 f.store.browserExchange(f.sessionId,owner,{after:1,events:[candidate]},clock(1008));
 assert.throws(()=>f.store.browserExchange(f.sessionId,owner,{after:1,events:[{...candidate,data:candidate.data.replace('55600','55601')}]},clock(1009)),/anders verwendet/);
 const messages=f.device(1010,{sessionId:f.sessionId,after:1}).session.events;assert.equal(messages.length,1);assert.equal(messages[0].id,candidate.id);assert.equal(messages[0].seq,2);
});
test('public, relayed, malformed and embedded candidates are rejected',()=>{
 assert.equal(validatePreviewCandidate(ice().data),true);assert.equal(validatePreviewCandidate(ice(undefined,'b1c2-d3.local').data),true);
 for(const value of [ice(undefined,'8.8.8.8').data,ice(undefined,'127.0.0.1').data,ice().data.replace('typ host','typ srflx'),ice().data+' raddr 8.8.8.8 rport 9',ice().data+'\nmalicious'])assert.equal(validatePreviewCandidate(value),false);
 const f=fixture();f.device(1000);for(const bad of [offer+'m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',offer+'a=candidate:1 1 udp 1 8.8.8.8 1 typ host\r\n',offer.replace('0.0.0.0','8.8.8.8'),offer.replace('recvonly','sendrecv')])assert.throws(()=>f.store.create({...f.body,offer:bad},owner,clock(1001),true));
});
test('revocation, runtime change, clock regression and expired leases close sessions',()=>{
 for(const mode of ['revoke','runtime','wall','device','browser']){
  const f=fixture();f.device(1000);f.store.create(f.body,owner,clock(1001),true);
  if(mode==='revoke')f.device(1002,{available:false});
  if(mode==='runtime')assert.deepEqual(f.store.deviceExchange(f.deviceId,{sessionId:f.sessionId,after:0,events:[],available:true},{runtimeId:randomUUID(),wall:1002,tick:1002}),{session:null});
  if(mode==='wall')assert.throws(()=>f.store.browserExchange(f.sessionId,owner,empty,{runtimeId:runtime,wall:900,tick:1002}),/nicht gefunden/);
  if(mode==='device')assert.throws(()=>f.store.browserExchange(f.sessionId,owner,empty,clock(11000)),/nicht gefunden/);
  if(mode==='browser'){f.device(9000);assert.deepEqual(f.device(13001,{sessionId:f.sessionId}),{session:null});}
  if(mode==='revoke')assert.throws(()=>f.store.browserExchange(f.sessionId,owner,empty,clock(1003)),/nicht gefunden/);
 }
});
test('offer expires even if browser and device keep polling without acknowledgment',()=>{
 const f=fixture();f.device(1000);f.store.create(f.body,owner,clock(1000),true);
 for(const n of [9000,15999]){f.device(n);f.store.browserExchange(f.sessionId,owner,empty,clock(n));}
 assert.deepEqual(f.device(16000),{session:null});
});
test('event batches are atomic and SDP/ICE limits fail closed',()=>{
 const f=fixture();f.device(1000);f.store.create(f.body,owner,clock(1000),true);f.device(1001);
 assert.throws(()=>f.device(1002,{sessionId:f.sessionId,after:1,events:[ice()]}),/Antwort fehlt/);
 const valid=ice(),bad=ice(undefined,'8.8.8.8');assert.throws(()=>f.store.browserExchange(f.sessionId,owner,{after:0,events:[valid,bad]},clock(1002)));
 assert.equal(f.device(1003,{sessionId:f.sessionId,after:1}).session.events.length,0);
 assert.throws(()=>f.store.browserExchange(f.sessionId,owner,{after:0,events:Array.from({length:17},()=>ice())},clock(1004)));
});
test('new generation rejects old CREATE and bounded tombstones prevent closed-session replay',()=>{
 const f=fixture();f.device(1000);f.store.create(f.body,owner,clock(1000),true);f.store.close(f.sessionId,owner,clock(1001));assert.throws(()=>f.store.create(f.body,owner,clock(1002),true),/bereits beendet/);
 const next={runtimeId:randomUUID(),wall:1003,tick:1003};assert.throws(()=>f.store.create(f.body,owner,next,true),/veraltet/);
 const x=fixture();x.device(1000);for(let i=0;i<512;i++){const body={...x.body,sessionId:randomUUID()};x.store.create(body,owner,clock(1000),true);x.store.close(body.sessionId,owner,clock(1000));}
 assert.throws(()=>x.store.create({...x.body,sessionId:randomUUID()},owner,clock(1000),true),/Sitzungslimit/);
});
test('close-before-create is owner-scoped, idempotent, and rejects a late CREATE',()=>{
 const f=fixture();f.device(1000);f.store.close(f.sessionId,owner,clock(1001));f.store.close(f.sessionId,owner,clock(1002));
 assert.throws(()=>f.store.create(f.body,owner,clock(1003),true),/bereits beendet/);
 const otherToken=f.store.availableDevices(clock(1003),other).creationToken;
 assert.equal(f.store.create({...f.body,creationToken:otherToken},other,clock(1003),true).created,true);
 f.store.close(f.sessionId,owner,clock(1004));assert.equal(f.store.browserExchange(f.sessionId,other,empty,clock(1005)).sessionId,f.sessionId);
 f.store.close(f.sessionId,other,clock(1006));assert.throws(()=>f.store.browserExchange(f.sessionId,other,empty,clock(1007)),/nicht gefunden/);
});
test('creation tokens bind browser owner, generation and deadline',()=>{
 const f=fixture();f.device(1000);
 assert.throws(()=>f.store.create(f.body,other,clock(1001),true),/Freigabe/);
 assert.throws(()=>f.store.create({...f.body,creationToken:f.body.creationToken.slice(0,-1)+'x'},owner,clock(1001),true),/Freigabe/);
 f.device(15000);assert.throws(()=>f.store.create(f.body,owner,clock(16000),true),/Freigabe/);
});

test('a new preview waits until the phone confirms closing the prior peer',()=>{
 const f=fixture();f.device(1000);f.store.create(f.body,owner,clock(1001),true);
 assert.equal(f.device(1002).session.sessionId,f.sessionId); // the offer may have reached the phone
 f.store.close(f.sessionId,owner,clock(1003));
 const fresh={...f.body,sessionId:randomUUID(),creationToken:f.store.availableDevices(clock(1004),owner).creationToken};
 assert.equal(f.store.availableDevices(clock(1004),owner).devices[0].available,false);
 assert.throws(()=>f.store.create(fresh,owner,clock(1004),true),/nicht freigegeben/);
 assert.deepEqual(f.device(1005,{sessionId:f.sessionId,after:1,events:[]}),{session:null});
 assert.equal(f.store.availableDevices(clock(1006),owner).devices[0].available,false);
 assert.deepEqual(f.device(1007),{session:null}); // Android polls idle only after its close callback
 assert.equal(f.store.availableDevices(clock(1008),owner).devices[0].available,true);
 assert.equal(f.store.create(fresh,owner,clock(1009),true).created,true);
});
