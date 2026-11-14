import Database from 'better-sqlite3';
import { createOidcStorageAdapter } from '../../lib/oidc-storage.ts';

const db=new Database(process.argv[2]);
const Adapter=createOidcStorageAdapter(db);
const code=new Adapter('AuthorizationCode');
process.send('ready');
process.once('message',async()=>{
 try {
  const operation=process.argv[3] ?? 'consume';
  if(operation==='consume'){await code.consume('parallel-code');process.send('consumed');}
  else if(operation==='destroy'){await code.destroy('parallel-code');process.send('destroyed');}
  else if(operation==='revoke'){await code.revokeByGrantId('grant');process.send('revoked');}
  else if(operation==='upsert'){await code.upsert('parallel-code',{grantId:'grant'},60);process.send('saved');}
  else if(operation==='rebind'){await code.upsert('parallel-code',{grantId:'other-grant'},60);process.send('rebound');}
  else throw new Error('Ungültige Testoperation');
 }
 catch { process.send('rejected'); }
 finally { db.close(); process.disconnect(); }
});
