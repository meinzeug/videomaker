import Database from 'better-sqlite3';
import path from 'node:path';
import {listCameraLateAlerts} from './camera-late-alerts.ts';
import {sessionRevokedReadOnly} from './session-revocations.ts';

/** Read revocation and alerts in one snapshot; missing storage/schema fails closed. */
export function readCameraLateAlerts(dir:string,credential:string,secret:string,before:number|null|'invalid',signatureValid:(value:string)=>boolean){
 if(!signatureValid(credential))return {kind:'unauthorized' as const};
 const database=new Database(path.join(dir,'videomaker.sqlite'),{readonly:true,fileMustExist:true,timeout:1000});
 try{return database.transaction(()=>{
  if(!signatureValid(credential)||sessionRevokedReadOnly(database,secret,credential))return {kind:'unauthorized' as const};
  if(before==='invalid')return {kind:'invalid' as const};
  return {kind:'ok' as const,value:listCameraLateAlerts(database,before)};
 }).deferred();}finally{database.close();}
}
