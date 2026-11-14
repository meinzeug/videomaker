import { constants, closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { initializeOidcStorage } from './oidc-storage.ts';
import { initializeOidcProviderSessionMap } from './oidc-provider-session-map.ts';

const APPLICATION_ID=0x564d4f49;

/** No symlink or directory writable by another principal may protect provider state. */
function trustedParent(path) {
 if(!isAbsolute(path)||resolve(path)!==path)throw new Error('Ungültiger OIDC-Datenbankpfad');
 let directory=dirname(path);
 for(;;){
  const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o022)!==0||(stat.uid!==0&&stat.uid!==process.geteuid?.()))throw new Error('Ungeschützter OIDC-Datenbankpfad');
  if(directory===parse(directory).root)break;
  directory=dirname(directory);
 }
}

/** Explicit one-time setup; never open or replace an existing database. */
export function initializeProviderDatabase(path) {
 trustedParent(path);
 const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 closeSync(fd);
 const db=new Database(path,{fileMustExist:true});
 try{
  db.transaction(()=>{
   initializeOidcStorage(db);initializeOidcProviderSessionMap(db);
   db.exec('CREATE TABLE videomaker_oidc_provider_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)); INSERT INTO videomaker_oidc_provider_marker VALUES (1,1)');
   db.pragma(`application_id = ${APPLICATION_ID}`);
  }).immediate();
 }finally{db.close();}
}

/** An unrelated or insecure SQLite file is never initialized or repurposed. */
export function openProviderDatabase(path) {
 trustedParent(path);
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(stat.uid!==0&&stat.uid!==process.geteuid?.())||realpathSync(path)!==path)throw new Error('Unsichere OIDC-Datenbank');
 const db=new Database(path,{fileMustExist:true,timeout:1000});
 try{
  if(db.pragma('application_id',{simple:true})!==APPLICATION_ID)throw new Error('Keine Video-Maker-OIDC-Datenbank');
  const marker=db.prepare('SELECT version FROM videomaker_oidc_provider_marker WHERE id=1').get();
  if(marker?.version!==1)throw new Error('Ungültige OIDC-Datenbankversion');
  return db;
 }catch(error){db.close();throw error;}
}
