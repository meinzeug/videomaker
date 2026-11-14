import Database from 'better-sqlite3';
import {pollPairedWebCommandFixture} from '../../experiments/paired-web-camera/core.mjs';
process.env.NODE_ENV='test';process.env.PAIRED_WEB_CAMERA_FIXTURE='1';let text='';for await(const part of process.stdin)text+=part;const x=JSON.parse(text),db=new Database(x.path);db.pragma('foreign_keys=ON');
try{const result=pollPairedWebCommandFixture(db,x.identity,x.ticket,()=>x.clock,()=>true,()=>true);process.stdout.write(JSON.stringify({delivered:!!result.id,empty:!!result.empty}));process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
