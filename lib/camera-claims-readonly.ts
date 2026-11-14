import Database from 'better-sqlite3';
import path from 'node:path';
import {listOpenCameraClaims} from './camera-project-claims.ts';
import {sessionRevokedReadOnly} from './session-revocations.ts';

/** Never creates a database or schema; caller translates failures to a closed response. */
export function readOpenCameraClaims(dir:string,credential:string,secret:string,projectId:string|null,signatureValid:(value:string)=>boolean){
 if(!signatureValid(credential))return {kind:'unauthorized' as const};
 const database=new Database(path.join(dir,'videomaker.sqlite'),{readonly:true,fileMustExist:true,timeout:1000});
 try{return database.transaction(()=>{
  if(!signatureValid(credential)||sessionRevokedReadOnly(database,secret,credential))return {kind:'unauthorized' as const};
  if(projectId===null)return {kind:'invalid' as const};
  return {kind:'ok' as const,value:listOpenCameraClaims(database,projectId)};
 }).deferred();}finally{database.close();}
}
