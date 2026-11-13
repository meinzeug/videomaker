import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHeartbeat,parseCommand} from '../lib/live-devices.ts';
const id='12c3267c-c343-41d1-8245-2a88107e7213';
test('device reports validate role, ID, bounded state and acknowledgements',()=>{
 assert.equal(parseHeartbeat({id,name:' Handy ',role:'prompter',status:'bereit',ack:[id,id]}).ack.length,1);
 for(const patch of [{id:'bad'},{role:'unknown'},{name:' '},{status:'x'.repeat(121)},{ack:['bad']}])assert.throws(()=>parseHeartbeat({id,name:'Handy',role:'prompter',status:'bereit',ack:[],...patch}));
});
test('remote commands require a known action and a valid project for load',()=>{
 assert.equal(parseCommand({type:'load',projectId:id}).projectId,id);
 assert.equal(parseCommand({type:'pause'}).projectId,null);
 assert.throws(()=>parseCommand({type:'record'}));
 assert.throws(()=>parseCommand({type:'load',projectId:'invalid'}));
});
