import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {ensureLiveDeviceControlSchema} from '../lib/live-device-schema.ts';
test('control migration is additive and repeatable without altering existing rows',()=>{
 const db=new Database(':memory:');
 try{
  db.exec(`CREATE TABLE live_devices(id TEXT PRIMARY KEY,name TEXT,role TEXT,status TEXT,last_seen INTEGER);
   CREATE TABLE live_commands(id TEXT PRIMARY KEY,device_id TEXT,type TEXT,project_id TEXT,created_at INTEGER,expires_at INTEGER);
   INSERT INTO live_devices VALUES('device','phone','prompter','ready',10);
   INSERT INTO live_commands VALUES('command','device','pause',NULL,10,20);`);
  ensureLiveDeviceControlSchema(db);ensureLiveDeviceControlSchema(db);
  assert.deepEqual(db.prepare('SELECT id,speed,font_size FROM live_devices').get(),{id:'device',speed:null,font_size:null});
  assert.deepEqual(db.prepare('SELECT id,type,value FROM live_commands').get(),{id:'command',type:'pause',value:null});
  db.prepare('UPDATE live_devices SET speed=?,font_size=?').run(35,44);
  db.prepare('UPDATE live_commands SET value=?').run(55);
  ensureLiveDeviceControlSchema(db);
  assert.deepEqual(db.prepare('SELECT speed,font_size FROM live_devices').get(),{speed:35,font_size:44});
  assert.equal(db.prepare('SELECT value FROM live_commands').get().value,55);
 }finally{db.close();}
});
