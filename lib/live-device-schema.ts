import type Database from 'better-sqlite3';

/** Additive migration for old device queues; serialized across concurrent server processes. */
export function ensureLiveDeviceControlSchema(db:Database.Database){
 db.transaction(()=>{
  const device=new Set((db.prepare('PRAGMA table_info(live_devices)').all() as {name:string}[]).map(c=>c.name));
  const command=new Set((db.prepare('PRAGMA table_info(live_commands)').all() as {name:string}[]).map(c=>c.name));
  if(!device.has('speed'))db.exec('ALTER TABLE live_devices ADD COLUMN speed REAL');
  if(!device.has('font_size'))db.exec('ALTER TABLE live_devices ADD COLUMN font_size REAL');
  if(!command.has('value'))db.exec('ALTER TABLE live_commands ADD COLUMN value REAL');
 }).immediate();
}
