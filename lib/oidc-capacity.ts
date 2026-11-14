import type Database from 'better-sqlite3';

// Observability only. No schema initialization, deletion, clock update or network calls.
// These snapshots do not reserve space and are not an admission control mechanism.
const providerTables = ['oidc_records','oidc_consumed_objects','oidc_revoked_grants','oidc_provider_session_map'] as const;
const bindingTables = ['oidc_session_bindings','auth_session_revocations'] as const;
type ProviderTable = typeof providerTables[number];
type BindingTable = typeof bindingTables[number];
type Limit = {warn: number; critical: number};
type Result<K extends string> = {
 counts: Record<K, number>;
 databaseBytes: number;
 status: 'ok'|'warning'|'critical';
 exceeded: Array<{metric: K|'databaseBytes'; level: 'warning'|'critical'}>;
};
type Limits<K extends string> = Record<K|'databaseBytes', Limit>;

function snapshot<K extends string>(db:Database.Database,tables:readonly K[],limits:Limits<K>):Result<K> {
 // Every metric must have explicit thresholds; never report healthy with a missing limit.
 for(const metric of [...tables,'databaseBytes'] as const) {
  const limit=limits?.[metric as K|'databaseBytes'];
  if(!limit||!Number.isSafeInteger(limit.warn)||!Number.isSafeInteger(limit.critical)||limit.warn<1||limit.critical<=limit.warn)throw new Error('Ungültige OIDC-Kapazitätsgrenzen');
 }
 return db.transaction(()=>{
  const counts={} as Record<K,number>;
  for(const table of tables){
   // Identifiers are fixed in this module, not supplied by callers.
   const row=db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number};
   if(!Number.isSafeInteger(row.count)||row.count<0)throw new Error('Ungültiger OIDC-Tabellenbestand');
   counts[table]=row.count;
  }
  const pages=db.pragma('page_count',{simple:true}) as number;
  const pageSize=db.pragma('page_size',{simple:true}) as number;
  const databaseBytes=pages*pageSize;
  if(!Number.isSafeInteger(databaseBytes)||databaseBytes<0)throw new Error('Ungültige OIDC-Datenbankgröße');
  const exceeded:Result<K>['exceeded']=[];
  for(const metric of [...tables,'databaseBytes'] as Array<K|'databaseBytes'>){
   const value=metric==='databaseBytes'?databaseBytes:counts[metric as K];
   const limit=limits[metric];
   if(value>=limit.critical)exceeded.push({metric,level:'critical'});
   else if(value>=limit.warn)exceeded.push({metric,level:'warning'});
  }
  const status:Result<K>['status']=exceeded.some(item=>item.level==='critical')?'critical':exceeded.length?'warning':'ok';
  return {counts,databaseBytes,status,exceeded};
 }).deferred();
}

/** Provider database. This reports counts only; records and references remain private. */
export function measureOidcProviderCapacity(db:Database.Database,limits:Limits<ProviderTable>):Result<ProviderTable> {
 return snapshot(db,providerTables,limits);
}

/** Videomaker session database; measure separately from the provider database. */
export function measureOidcBindingCapacity(db:Database.Database,limits:Limits<BindingTable>):Result<BindingTable> {
 return snapshot(db,bindingTables,limits);
}
