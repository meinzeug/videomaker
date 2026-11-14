import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {parseCommand,parseHeartbeat} from './live-devices';

type Heartbeat=ReturnType<typeof parseHeartbeat>;
type Command=ReturnType<typeof parseCommand>;
/** Authorization is checked under the same writer lock as acknowledgements and registration. */
export function processDeviceHeartbeat(database:Database.Database,item:Heartbeat,now:number,authorize:()=>boolean){
 return database.transaction(()=>{
  if(!authorize())return null;
  database.prepare('DELETE FROM live_commands WHERE expires_at<=?').run(now);
  database.prepare('DELETE FROM live_devices WHERE last_seen<?').run(now-300000);
  database.prepare('INSERT INTO live_devices(id,name,role,status,last_seen,speed,font_size) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,status=excluded.status,last_seen=excluded.last_seen,speed=excluded.speed,font_size=excluded.font_size').run(item.id,item.name,item.role,item.status,now,item.speed,item.fontSize);
  const ack=database.prepare('DELETE FROM live_commands WHERE id=? AND device_id=?');item.ack.forEach(id=>ack.run(id,item.id));
  return database.prepare('SELECT id,type,project_id as projectId,value,expires_at-? as remainingMs FROM live_commands WHERE device_id=? AND expires_at>? ORDER BY created_at,rowid LIMIT 1').all(now,item.id,now);
 }).immediate();
}
/** An old app cannot receive setting commands, and stale or logged-out sessions cannot queue one. */
export function enqueueDeviceCommand(database:Database.Database,id:string,command:Command,now:number,authorize:()=>boolean){
 return database.transaction(()=>{
  if(!authorize())return 'auth';
  const device=database.prepare('SELECT role,speed,font_size FROM live_devices WHERE id=? AND last_seen>?').get(id,now-10000) as {role:string;speed:number|null;font_size:number|null}|undefined;
  if(!device)return 'offline';
  if(device.role!=='prompter')return 'role';
  if(command.projectId&&!database.prepare('SELECT 1 FROM projects WHERE id=?').get(command.projectId))return 'project';
  if((command.type==='set_speed'||command.type==='set_font_size')&&(device.speed===null||device.font_size===null))return 'unsupported';
  if((database.prepare('SELECT count(*) as n FROM live_commands WHERE device_id=? AND expires_at>?').get(id,now) as {n:number}).n>=32)return 'busy';
  database.prepare('INSERT INTO live_commands(id,device_id,type,project_id,value,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,command.type,command.projectId,command.value,now,now+10000);return 'ok';
 }).immediate();
}
