import Database from 'better-sqlite3';
import {createLiveStaging} from '../../lib/live-recording-staging.ts';
import {claimCameraProject} from '../../lib/camera-project-claims.ts';
const [file,root,stage,project,recording,device,kind]=process.argv.slice(2),db=new Database(file);db.pragma('busy_timeout=10000');process.send('ready');
process.once('message',()=>{
 try{
  if(kind==='lan')createLiveStaging(db,root,()=>4n*1024n*1024n*1024n).begin(stage,project,recording);
  else db.transaction(()=>claimCameraProject(db,recording,device,project,100)).immediate();
  process.send({kind,result:'created'});
 }catch(error){process.send({kind,result:'rejected',code:error?.code||''});}
 finally{db.close();process.disconnect();}
});
