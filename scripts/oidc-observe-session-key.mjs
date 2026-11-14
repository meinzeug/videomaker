// Explicit administrative operation; does not create a database or schema.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createOidcSessionBindings } from '../lib/oidc-session-bindings.ts';

if(process.env.OIDC_BINDING_OBSERVE_KEY!=='1'||!process.env.DATA_DIR)throw new Error('OIDC_BINDING_OBSERVE_KEY=1 und DATA_DIR erforderlich');
const db=new Database(join(process.env.DATA_DIR,'videomaker.sqlite'),{fileMustExist:true,timeout:1000});
try{
 createOidcSessionBindings(db,()=>null).observeKeyGeneration();
 console.log('OIDC-Schlüsselgeneration erfolgreich beobachtet.');
}finally{db.close();}
