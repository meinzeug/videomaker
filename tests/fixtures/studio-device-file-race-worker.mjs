import Database from 'better-sqlite3';
import {createStudioDeviceAuth} from '../../lib/studio-device-auth-core.mjs';
import {commitSyntheticFile} from '../../experiments/studio-device-http/fixture-file-commit.mjs';
const [root,mode,ticket,project,recording,device,secret]=process.argv.slice(2);
if(!root?.startsWith('/dev/shm/studio-file-commit.')||!['commit','revoke','crash','after-commit'].includes(mode)||!/^[0-9a-f]{64}$/.test(secret||''))throw Error('Invalid fixture');
const db=new Database(`${root}/synthetic.sqlite`,{fileMustExist:true});db.pragma('busy_timeout=5000');db.pragma('synchronous=FULL');
const auth=createStudioDeviceAuth(db,Date.now,Buffer.from(secret,'hex'));process.send('ready');
process.once('message',()=>{
 try{process.send({result:mode==='revoke'?auth.revoke(device,()=>true):commitSyntheticFile(db,{root,ticket,project,recording,bytes:Buffer.from('synthetic recording'),crashAfterLink:mode==='crash',crashAfterCommit:mode==='after-commit'})});}
 catch(error){process.send({error:error.message});}
 finally{db.close();}
});
