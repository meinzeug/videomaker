import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createLiveStaging} from '../../lib/live-recording-staging.ts';
const [file,root,id,project,recording,point]=process.argv.slice(2);
const db=new Database(file);
const store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n,()=>{},where=>{if(where===point)process.kill(process.pid,'SIGKILL');});
if(point==='after-opening-fsync')store.begin(id,project,recording);
else {const data=Buffer.from('recording bytes');store.put(id,project,recording,0,0,data,createHash('sha256').update(data).digest('hex'));}
throw Error('crash hook was not reached');
