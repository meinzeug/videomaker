import Database from 'better-sqlite3';
import {revokeRelayPairing} from '../../lib/relay-pairing-registry.ts';
const [path,owner,pairId]=process.argv.slice(2);
const db=new Database(path);
try{revokeRelayPairing(db,owner,pairId,1025,()=>true);}
finally{db.close();}
