import Database from 'better-sqlite3';
import { createOidcSessionBindings } from '../../lib/oidc-session-bindings.ts';
import { verifiedSessionBindingProof } from '../../lib/session-binding-proof.ts';
import { revokeSession } from '../../lib/session-revocations.ts';

const db=new Database(process.argv[2]),cookie=process.argv[3],secret=process.argv[5]??'isolated-test-secret-at-least-32-characters';
const binding=createOidcSessionBindings(db,(database,value)=>verifiedSessionBindingProof(database,value,secret),Date.now,()=>secret);
process.send('ready');
process.once('message',()=>{
 try {
  if(process.argv[4]==='issue')process.send({operation:'issue',reference:binding.issue(cookie)});
  else if(process.argv[4]==='logout'){revokeSession(db,secret,cookie,Date.now());process.send({operation:'logout'});}
  else if(process.argv[4]==='check')process.send({operation:'check',active:binding.isActive(process.argv[6])});
  else throw new Error('Ungültige Testoperation');
 } catch { process.send({operation:'error'}); }
 finally { db.close();process.disconnect(); }
});
