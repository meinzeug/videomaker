import Database from 'better-sqlite3';
import {createLiveStaging} from '../../lib/live-recording-staging.ts';
import {acquireRecordingUpload} from '../../lib/recording-upload-guard.ts';
import {lockAndValidateCameraUpload,releaseCameraUploadLock} from '../../lib/camera-project-claims.ts';
const [filename,root,id,project,recording,mode]=process.argv.slice(2);
const db=new Database(filename);db.pragma('busy_timeout=3000');db.pragma('synchronous=FULL');
let store,lease,started=false;
process.send('ready');
process.on('message',message=>{
 if(message==='go'){
  try{
   if(mode==='live'){store=createLiveStaging(db,root,()=>4n*1024n*1024n*1024n);store.begin(id,project,recording);}
   else {lease=acquireRecordingUpload(db);if(!lease)throw Error('NO_LEASE');lockAndValidateCameraUpload(db,lease.token,id,null,project,1,'a'.repeat(64),lease.check);}
   started=true;process.send({result:'acquired'});
  }catch(error){process.send({result:'blocked',error:error.message});}
 } else if(message==='stop'){
  try{if(mode==='live'&&started)store.cancel(id,project,recording);if(lease){releaseCameraUploadLock(db,lease.token);lease.release();}}
  finally{db.close();process.disconnect();}
 }
});
