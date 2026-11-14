import Database from 'better-sqlite3';
import { createOidcProviderSessionMap } from '../../lib/oidc-provider-session-map.ts';
const db=new Database(process.argv[2]),map=createOidcProviderSessionMap(db);
process.send('ready');
process.once('message',()=>{
 try{map.bindOnce('u'.repeat(43),process.argv[3]);process.send('bound');}
 catch{process.send('rejected');}
 finally{db.close();process.disconnect();}
});
