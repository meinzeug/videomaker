import type Database from 'better-sqlite3';

class RelayExpired extends Error {}
export function expiredRelayOperation():never {throw new RelayExpired('EXPIRED');}
/** Roll back the attempted mutation but commit an expiry tombstone/removal. */
export function relayExpiringTransaction<T>(db:Database.Database,action:()=>T,onExpired:()=>void):T {
 if(db.inTransaction)throw new Error('NESTED_RELAY_TRANSACTION_UNSUPPORTED');
 const result=db.transaction(()=>{
  try{return {ok:true as const,value:db.transaction(action)()};}
  catch(error){if(!(error instanceof RelayExpired))throw error;onExpired();return {ok:false as const};}
 }).immediate();
 if(!result.ok)throw new Error('EXPIRED');
 return result.value;
}
export function tablePresent(db:Database.Database,name:string){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
