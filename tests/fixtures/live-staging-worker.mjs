import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createLiveStaging} from '../../lib/live-recording-staging.ts';
const [database,root,id,project,recording,payload]=process.argv.slice(2);
const db=new Database(database),store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n),bytes=Buffer.from(payload);
db.pragma('busy_timeout=10000');process.send('ready');
process.once('message',()=>{
 try{const result=store.put(id,project,recording,0,0,bytes,createHash('sha256').update(bytes).digest('hex'));process.send({result});}
 catch(error){process.send({error:error?.code||String(error)});}
 finally{db.close();process.disconnect();}
});
