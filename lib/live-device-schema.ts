import type Database from 'better-sqlite3';

/** Additive migration for old device queues; serialized across concurrent server processes. */
export function ensureLiveDeviceControlSchema(db:Database.Database){
 db.transaction(()=>{
  const device=new Set((db.prepare('PRAGMA table_info(live_devices)').all() as {name:string}[]).map(c=>c.name));
  const command=new Set((db.prepare('PRAGMA table_info(live_commands)').all() as {name:string}[]).map(c=>c.name));
  if(!device.has('speed'))db.exec('ALTER TABLE live_devices ADD COLUMN speed REAL');
  if(!device.has('font_size'))db.exec('ALTER TABLE live_devices ADD COLUMN font_size REAL');
  if(!command.has('value'))db.exec('ALTER TABLE live_commands ADD COLUMN value REAL');
  db.exec('CREATE TABLE IF NOT EXISTS live_command_receipts (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, completed_at INTEGER NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS live_command_receipts_device_idx ON live_command_receipts(device_id, completed_at)');
 }).immediate();
}
