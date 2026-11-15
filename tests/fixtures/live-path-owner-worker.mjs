import Database from 'better-sqlite3';
import {claimUploadPath} from '../../lib/live-upload-path-owner.ts';
const [file,recording,project,upload,mode,point]=process.argv.slice(2);
const db=new Database(file);db.pragma('busy_timeout=3000');db.pragma('synchronous=FULL');
process.send('ready');
process.once('message',()=>{
 try {
  const result=db.transaction(()=>{
   const owner=claimUploadPath(db,recording,project,upload,mode,mode==='full'?{size:123,sha256:'a'.repeat(64)}:{});
   if(point==='before-commit')process.kill(process.pid,'SIGKILL');
   return owner;
  }).immediate();
  if(point==='after-commit')process.kill(process.pid,'SIGKILL');
  process.send({result});
 } catch(error){process.send({error:error.message});}
 finally {db.close();}
});
