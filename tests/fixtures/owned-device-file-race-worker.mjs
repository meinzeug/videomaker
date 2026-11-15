import Database from 'better-sqlite3';
import {createOwnedDeviceAuth} from '../../experiments/studio-device-http/owned-device-auth-core.mjs';
import {commitOwnedSyntheticFile} from '../../experiments/studio-device-http/owned-fixture-file-commit.mjs';
const [root,mode,ticket,project,recording,device,secret,session]=process.argv.slice(2);
if(!root?.startsWith('/dev/shm/studio-file-commit.')||!['commit','revoke-device','revoke-project','crash'].includes(mode)||!/^[0-9a-f]{64}$/.test(secret||''))throw Error('Invalid fixture');
const db=new Database(`${root}/synthetic.sqlite`,{fileMustExist:true});db.pragma('busy_timeout=5000');db.pragma('synchronous=FULL');
const auth=createOwnedDeviceAuth(db,Date.now,Buffer.from(secret,'hex'));process.send('ready');
process.once('message',()=>{
 try{let result;if(mode==='revoke-device')result=auth.revoke(device,session);else if(mode==='revoke-project')result=auth.revokeProject(device,project,session);else result=commitOwnedSyntheticFile(db,{root,ticket,project,recording,bytes:Buffer.from('synthetic recording'),crashAfterLink:mode==='crash'});process.send({result});}
 catch(error){process.send({error:error.message});}finally{db.close();}
});
