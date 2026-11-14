import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fixture} from './fixtures/relay-delivery-fixture.mjs';
import {revokeRelayOwnerSession} from '../lib/relay-session-authorization.ts';
import {revokeSession} from '../lib/session-revocations.ts';

test('only both live authenticated devices can exchange and acknowledge opaque records',()=>{
 const f=fixture();try{
  assert.deepEqual(f.delivery.send(f.owner,f.camera.participant,f.cameraActor,1,Buffer.from('opaque')), {sequence:1,created:true});
  assert.equal(f.delivery.peek(f.owner,f.prompter.participant,f.guestActor).ciphertext.toString(),'opaque');
  assert.equal(f.delivery.acknowledge(f.owner,f.prompter.participant,f.guestActor,1).acknowledged,true);
  assert.equal(f.delivery.peek(f.owner,f.prompter.participant,f.guestActor),null);
  assert.throws(()=>f.delivery.send(f.owner,f.camera.participant,f.guestActor,2,Buffer.from('x')),/RELAY_DENIED/);
  assert.throws(()=>f.delivery.send(f.owner,{...f.camera.participant,credential:randomBytes(32).toString('base64url')},f.cameraActor,2,Buffer.from('x')),/RELAY_DENIED/);
  revokeSession(f.db,f.secret,f.prompter.cookie,1024);
  assert.throws(()=>f.delivery.send(f.owner,f.camera.participant,f.cameraActor,2,Buffer.from('x')),/RELAY_DENIED/);
  assert.equal(f.relay.peek(f.room.roomId,f.guestActor),null);
 }finally{f.db.close();}
});

test('database commit failure restores queued bytes and sequence',()=>{
 const f=fixture();try{
  f.db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
  let calls=0;const participant={...f.camera.participant,authorize:()=>{if(++calls===2)f.db.exec('INSERT INTO c VALUES(1)');return true;}};
  assert.throws(()=>f.delivery.send(f.owner,participant,f.cameraActor,1,Buffer.from('must-roll-back')));
  assert.equal(f.relay.peek(f.room.roomId,f.guestActor),null);
  assert.equal(f.delivery.send(f.owner,f.camera.participant,f.cameraActor,1,Buffer.from('retry')).created,true);
 }finally{f.db.close();}
});

test('peer revocation during delivery rolls back the in-memory mutation',()=>{
 const f=fixture();try{
  let calls=0;const participant={...f.camera.participant,authorize:()=>{if(++calls===3)revokeRelayOwnerSession(f.db,f.prompter.session);return true;}};
  assert.throws(()=>f.delivery.send(f.owner,participant,f.cameraActor,1,Buffer.from('must-not-queue')),/RELAY_DENIED/);
  assert.equal(f.relay.peek(f.room.roomId,f.guestActor),null);
  assert.throws(()=>f.delivery.send(f.owner,f.camera.participant,f.cameraActor,1,Buffer.from('retry')),/RELAY_DENIED/);
 }finally{f.db.close();}
});
