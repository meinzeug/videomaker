import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {parseCommand,parseHeartbeat} from '../lib/live-devices.ts';
import {ensureLiveDeviceControlSchema} from '../lib/live-device-schema.ts';
import {enqueueDeviceCommand,processDeviceHeartbeat} from '../lib/live-device-queue.ts';
const id='12c3267c-c343-41d1-8245-2a88107e7213';
function fixture(){const db=new Database(':memory:');db.exec(`CREATE TABLE live_devices(id TEXT PRIMARY KEY,name TEXT,role TEXT,status TEXT,last_seen INTEGER);CREATE TABLE live_commands(id TEXT PRIMARY KEY,device_id TEXT,type TEXT,project_id TEXT,created_at INTEGER,expires_at INTEGER);CREATE TABLE projects(id TEXT PRIMARY KEY);`);ensureLiveDeviceControlSchema(db);return db;}
const heartbeat=(controls)=>parseHeartbeat({id,name:'Handy',role:'prompter',status:'bereit',ack:[],...(controls?{controls}:{})});
test('old phones cannot receive setting commands; updated phones get bounded values and ACK removes only their own command',()=>{
 const db=fixture();try{
  processDeviceHeartbeat(db,heartbeat(null),100,()=>true);
  const speed=parseCommand({type:'set_speed',value:60});
  assert.equal(enqueueDeviceCommand(db,id,speed,101,()=>true),'unsupported');
  assert.equal(enqueueDeviceCommand(db,id,parseCommand({type:'pause'}),101,()=>true),'ok');
  const pending=processDeviceHeartbeat(db,heartbeat({speed:35,fontSize:44}),102,()=>true);assert.equal(pending[0].type,'pause');
  assert.equal(enqueueDeviceCommand(db,id,speed,103,()=>true),'ok');
  const update=parseHeartbeat({id,name:'Handy',role:'prompter',status:'bereit',ack:[pending[0].id],controls:{speed:35,fontSize:44}});
  const commands=processDeviceHeartbeat(db,update,104,()=>true);assert.equal(commands[0].type,'set_speed');assert.equal(commands[0].value,60);
  assert.equal(db.prepare('SELECT count(*) AS n FROM live_commands').get().n,1);
  assert.equal(enqueueDeviceCommand(db,id,parseCommand({type:'set_font_size',value:55}),10_105,()=>true),'offline');
 }finally{db.close();}
});
test('a revoked session changes neither registration nor queue nor ACK',()=>{
 const db=fixture();try{
  processDeviceHeartbeat(db,heartbeat({speed:35,fontSize:44}),100,()=>true);
  assert.equal(enqueueDeviceCommand(db,id,parseCommand({type:'play'}),101,()=>true),'ok');
  const command=db.prepare('SELECT id FROM live_commands').get().id;
  const report=parseHeartbeat({id,name:'Changed',role:'prompter',status:'changed',ack:[command],controls:{speed:70,fontSize:60}});
  assert.equal(processDeviceHeartbeat(db,report,102,()=>false),null);
  assert.equal(enqueueDeviceCommand(db,id,parseCommand({type:'pause'}),103,()=>false),'auth');
  assert.deepEqual(db.prepare('SELECT name,speed,font_size FROM live_devices').get(),{name:'Handy',speed:35,font_size:44});
  assert.equal(db.prepare('SELECT count(*) AS n FROM live_commands').get().n,1);
 }finally{db.close();}
});
