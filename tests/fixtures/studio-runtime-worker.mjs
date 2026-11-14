import Database from 'better-sqlite3';
import {prepareStudioRuntimeFixture} from '../../experiments/studio-rendezvous/runtime.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_STUDIO_RENDEZVOUS_FIXTURE='1';
let data='';for await(const part of process.stdin)data+=part;const value=JSON.parse(data),db=new Database(value.path);db.pragma('foreign_keys=ON');
try{process.stdout.write(JSON.stringify(prepareStudioRuntimeFixture(db,()=>value.clock)));process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
