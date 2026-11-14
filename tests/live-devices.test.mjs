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
test('remote settings reject absent, nonnumeric, nonfinite and out-of-range values',()=>{
 for(const type of ['set_speed','set_font_size']){
  const [min,max]=type==='set_speed'?[5,160]:[20,100];
  assert.equal(parseCommand({type,value:min}).value,min);
  assert.equal(parseCommand({type,value:max}).value,max);
  for(const value of [undefined,null,'44',NaN,Infinity,min-0.01,max+0.01])assert.throws(()=>parseCommand({type,value}));
 }
 assert.throws(()=>parseCommand({type:'pause',value:3}));
});
test('optional device controls are bounded and cannot be reported by camera role',()=>{
 const heartbeat={id,name:'Handy',role:'prompter',status:'bereit',ack:[]};
 assert.equal(parseHeartbeat(heartbeat).speed,null);
 assert.equal(parseHeartbeat({...heartbeat,controls:{speed:35,fontSize:44}}).fontSize,44);
 for(const controls of [null,[],{speed:4,fontSize:44},{speed:35,fontSize:101},{speed:'35',fontSize:44},{speed:NaN,fontSize:44}])assert.throws(()=>parseHeartbeat({...heartbeat,controls}));
 assert.throws(()=>parseHeartbeat({...heartbeat,role:'camera',controls:{speed:35,fontSize:44}}));
});
