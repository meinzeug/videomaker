import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {OpaqueRendezvous} from '../lib/opaque-rendezvous.ts';
const owner='a'.repeat(64),other='b'.repeat(64),secret=()=>randomBytes(32).toString('base64url');
const user={role:'owner',owner};
function fixture(config={}){let time=1;const relay=new OpaqueRendezvous(()=>time,config),room=relay.create(owner),credential=secret(),guest={role:'guest',credential};return {relay,room,guest,credential,at(value){time=value;}};}
test('join is single-role and lost responses can only retry with the same credential',()=>{
 const f=fixture();assert.deepEqual(f.relay.join(f.room.roomId,f.room.joinTicket,f.credential),{joined:true,created:true});
 assert.deepEqual(f.relay.join(f.room.roomId,f.room.joinTicket,f.credential),{joined:true,created:false});
 assert.throws(()=>f.relay.join(f.room.roomId,f.room.joinTicket,secret()),{code:'DENIED'});
 assert.throws(()=>f.relay.join(f.room.roomId,secret(),f.credential),{code:'DENIED'});
 assert.throws(()=>f.relay.join(f.room.roomId,f.room.joinTicket,f.room.joinTicket),{code:'DENIED'});
});
test('opaque packets preserve order, cannot be forged, and survive lost acknowledgements',()=>{
 const f=fixture();f.relay.join(f.room.roomId,f.room.joinTicket,f.credential);const bytes=Buffer.from([1,2,3]);
 assert.deepEqual(f.relay.send(f.room.roomId,user,1,bytes),{sequence:1,created:true});bytes[0]=99;
 assert.deepEqual(f.relay.peek(f.room.roomId,f.guest),{sequence:1,ciphertext:Buffer.from([1,2,3])});
 assert.deepEqual(f.relay.send(f.room.roomId,user,1,Buffer.from([1,2,3])),{sequence:1,created:false});
 assert.throws(()=>f.relay.send(f.room.roomId,user,1,Buffer.from([1,2,4])),{code:'SEQUENCE'});
 assert.throws(()=>f.relay.peek(f.room.roomId,{role:'guest',credential:secret()}),{code:'DENIED'});
 assert.throws(()=>f.relay.peek(f.room.roomId,{role:'owner',owner:other}),{code:'DENIED'});
 assert.throws(()=>f.relay.acknowledge(f.room.roomId,f.guest,2),{code:'SEQUENCE'});
 assert.equal(f.relay.acknowledge(f.room.roomId,f.guest,1).created,true);
 assert.equal(f.relay.acknowledge(f.room.roomId,f.guest,1).created,false);
 assert.equal(f.relay.peek(f.room.roomId,f.guest),null);
});
test('limits, rate, expiration, rollback, and logout fail closed',()=>{
 const f=fixture({maxRooms:1,maxPerOwner:1,joinMs:10,roomMs:100,maxMessages:1,maxBytes:8,maxMessageBytes:8,maxRate:1,rateWindowMs:10});
 assert.throws(()=>f.relay.create(owner),{code:'CAPACITY'});f.relay.join(f.room.roomId,f.room.joinTicket,f.credential);
 f.relay.send(f.room.roomId,user,1,Buffer.from('one'));assert.throws(()=>f.relay.send(f.room.roomId,user,2,Buffer.from('two')),{code:'RATE'});
 f.relay.acknowledge(f.room.roomId,f.guest,1);f.at(12);f.relay.send(f.room.roomId,user,2,Buffer.from('two'));
 assert.throws(()=>f.relay.send(f.room.roomId,user,3,Buffer.from('x')),{code:'RATE'});
 assert.equal(f.relay.revokeOwner(owner),1);assert.throws(()=>f.relay.peek(f.room.roomId,f.guest),{code:'MISSING'});
 const second=f.relay.create(owner);f.at(0);assert.throws(()=>f.relay.join(second.roomId,second.joinTicket,secret()),{code:'MISSING'});
});
test('unused ticket expires; rooms and payloads are bounded',()=>{
 const f=fixture({joinMs:10,roomMs:100,maxMessages:1,maxBytes:4,maxMessageBytes:4});f.at(11);
 assert.throws(()=>f.relay.join(f.room.roomId,f.room.joinTicket,f.credential),{code:'EXPIRED'});
 assert.throws(()=>f.relay.send(f.room.roomId,user,1,Buffer.alloc(5)),{code:'INVALID'});
 f.relay.send(f.room.roomId,user,1,Buffer.alloc(4));assert.throws(()=>f.relay.send(f.room.roomId,user,2,Buffer.alloc(1)),{code:'CAPACITY'});
 f.at(101);assert.throws(()=>f.relay.peek(f.room.roomId,user),{code:'MISSING'});
});

test('a room uses one shared byte limit across both directions',()=>{
 const f=fixture({maxBytes:6,maxMessageBytes:4});f.relay.join(f.room.roomId,f.room.joinTicket,f.credential);
 f.relay.send(f.room.roomId,user,1,Buffer.alloc(4));
 assert.throws(()=>f.relay.send(f.room.roomId,f.guest,1,Buffer.alloc(3)),{code:'CAPACITY'});
 f.relay.acknowledge(f.room.roomId,f.guest,1);
 assert.equal(f.relay.send(f.room.roomId,f.guest,1,Buffer.alloc(3)).created,true);
});
