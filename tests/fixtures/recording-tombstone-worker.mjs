import Database from 'better-sqlite3';
import {tombstoneProjectRecordings,isRecordingTombstoned} from '../../lib/project-recording-deletions.ts';
const [file,action,id]=process.argv.slice(2), db=new Database(file,{timeout:5000});
if(action==='delete'){
 db.exec('BEGIN IMMEDIATE');
 tombstoneProjectRecordings(db,'project-a',[{id,mime:'video/mp4'}]);
 db.prepare('DELETE FROM project_recordings WHERE id=?').run(id);
 process.send('locked');
 process.once('message',()=>{db.exec('COMMIT');db.close();process.send('committed');process.disconnect();});
}else{
 process.send('trying');
 const result=db.transaction(()=>{
  if(isRecordingTombstoned(db,id))return 'deleted';
  db.prepare('INSERT INTO project_recordings VALUES(?,?)').run(id,'video/mp4');return 'created';
 }).immediate();
 db.close();process.send(result);process.disconnect();
}
