import Database from 'better-sqlite3';
import {ensureLanCaptureProject} from '../../lib/lan-capture-project.ts';
const db=new Database(process.argv[2]);db.pragma('busy_timeout=10000');process.send('ready');
process.once('message',()=>{
 try{process.send({result:ensureLanCaptureProject(db,process.argv[3],()=>{})});}catch(error){process.send({error:error?.code||String(error)});}
 finally{db.close();process.disconnect();}
});
