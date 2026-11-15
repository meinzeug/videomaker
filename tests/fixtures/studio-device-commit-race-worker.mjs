import Database from 'better-sqlite3';
import {createStudioDeviceAuth} from '../../lib/studio-device-auth-core.mjs';
import {commitSyntheticUpload} from '../../experiments/studio-device-http/fixture-commit-fence.mjs';
const [file,mode,ticket,project,recording,device,secret]=process.argv.slice(2);
if(!file?.startsWith('/dev/shm/studio-commit-race.')||!['commit','revoke'].includes(mode)||!/^[0-9a-f]{64}$/.test(secret||''))throw Error('Invalid fixture');
const db=new Database(file,{fileMustExist:true});db.pragma('busy_timeout=5000');db.pragma('synchronous=FULL');
const auth=createStudioDeviceAuth(db,Date.now,Buffer.from(secret,'hex'));process.send('ready');
process.once('message',()=>{
 try {process.send({result:mode==='commit'?commitSyntheticUpload(db,ticket,project,recording,123,'a'.repeat(64)):auth.revoke(device,()=>true)});}
 catch(error){process.send({error:error.message});}
 finally{db.close();}
});
