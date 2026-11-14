import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {initializeStudioRuntimeSchemaFixture,studioRuntimeAdmissibleFixture} from './runtime.mjs';

// Test-only, shared-SQLite fixed-window admission. No raw IPs or session IDs stored.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/,WINDOW=10_000,MAX_KEYS=4096;
const limits={ip:300,owner:600,session:200};
function fixture(db){if(process.env.NODE_ENV!=='test'||process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE!=='1')throw Error('STUDIO_RENDEZVOUS_FIXTURE_DISABLED');if(!db||typeof db.transaction!=='function'||db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)throw Error('INVALID_DB');}
function normalizedIp(value){
 if(typeof value!=='string'||value.length>64)return null;
 if(value.startsWith('::ffff:')&&isIP(value.slice(7))===4)value=value.slice(7);
 const type=isIP(value);if(type===4)return value;if(type===6){try{const normalized=new URL('http://['+value+']/').hostname.slice(1,-1);const mapped=/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);if(mapped){const hi=parseInt(mapped[1],16),lo=parseInt(mapped[2],16);return [hi>>8,hi&255,lo>>8,lo&255].join('.');}return normalized;}catch{return null;}}return null;
}
export function initializeStudioRateFixture(db){fixture(db);initializeStudioRuntimeSchemaFixture(db);db.exec('CREATE TABLE IF NOT EXISTS studio_signal_rates(scope TEXT NOT NULL,key_hash TEXT NOT NULL,runtime_id TEXT NOT NULL,start_tick INTEGER NOT NULL,attempts INTEGER NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,key_hash))');}
/** Peer IP must come from a trusted transport/proxy; owner/session from verified authentication. */
export function admitStudioRateFixture(db,{ip,ownerHash,sessionHash},secret,clock,override){
 fixture(db);if(!Buffer.isBuffer(secret)||secret.length<32||typeof clock!=='function')return false;
 const canonical=normalizedIp(ip);if(!canonical||(ownerHash!==undefined&&!HEX.test(ownerHash))||(sessionHash!==undefined&&!HEX.test(sessionHash))||(sessionHash!==undefined&&ownerHash===undefined))return false;
 const policy=override??limits;if(!policy||Object.keys(limits).some(k=>!Number.isSafeInteger(policy[k])||policy[k]<1||policy[k]>10000))return false;
 const keys=[['ip',canonical],...(ownerHash===undefined?[]:[['owner',ownerHash]]),...(sessionHash===undefined?[]:[['session',sessionHash]])].map(([scope,value])=>({scope,hash:createHmac('sha256',secret).update('studio-signal-rate/v1\0').update(scope).update('\0').update(value).digest('hex')}));
 return db.transaction(()=>{
  const now=clock();if(!now||!UUID.test(now.runtimeId)||!Number.isSafeInteger(now.tick)||now.tick<0||!studioRuntimeAdmissibleFixture(db,now))return false;
  // Same-runtime elapsed windows can be discarded; blocked/foreign-runtime rows remain fail-closed.
  db.prepare('DELETE FROM studio_signal_rates WHERE runtime_id=? AND blocked=0 AND start_tick<=?').run(now.runtimeId,now.tick-WINDOW);
  const fetch=db.prepare('SELECT * FROM studio_signal_rates WHERE scope=? AND key_hash=?');let needs=0;const records=[];
  for(const k of keys){const row=fetch.get(k.scope,k.hash);if(!row){needs++;records.push({...k,row:null});continue;}
   if(row.runtime_id!==now.runtimeId||row.blocked)return false;
   if(now.tick<row.start_tick){db.prepare('UPDATE studio_signal_rates SET blocked=1 WHERE scope=? AND key_hash=?').run(k.scope,k.hash);return false;}
   if(now.tick-row.start_tick<WINDOW&&row.attempts>=policy[k.scope])return false;
   records.push({...k,row});
  }
  const count=db.prepare('SELECT count(*) AS n FROM studio_signal_rates').get().n;
  if(count+needs>MAX_KEYS)return false;
  const add=db.prepare('INSERT INTO studio_signal_rates VALUES(?,?,?,?,1,0)'),reset=db.prepare('UPDATE studio_signal_rates SET start_tick=?,attempts=1 WHERE scope=? AND key_hash=?'),inc=db.prepare('UPDATE studio_signal_rates SET attempts=attempts+1 WHERE scope=? AND key_hash=?');
  for(const {scope,hash,row} of records){if(!row)add.run(scope,hash,now.runtimeId,now.tick);else if(now.tick-row.start_tick>=WINDOW)reset.run(now.tick,scope,hash);else inc.run(scope,hash);}
  return true;
 }).immediate();
}
