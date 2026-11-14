import Database from 'better-sqlite3';
import {issuePairedWebTicketFixture} from '../../experiments/paired-web-camera/core.mjs';
process.env.NODE_ENV='test';process.env.PAIRED_WEB_CAMERA_FIXTURE='1';let data='';for await(const part of process.stdin)data+=part;const x=JSON.parse(data),db=new Database(x.path);db.pragma('foreign_keys=ON');
try{issuePairedWebTicketFixture(db,x.identity,()=>x.clock,()=>true);process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
