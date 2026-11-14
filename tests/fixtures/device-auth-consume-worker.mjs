import Database from 'better-sqlite3';
import {completeDeviceReconnect} from '../../experiments/device-auth/core.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE='1';let input='';for await(const chunk of process.stdin)input+=chunk;const v=JSON.parse(input),db=new Database(v.path);db.pragma('foreign_keys=ON');
try{completeDeviceReconnect(db,{attemptId:v.attemptId,clientChallenge:v.clientChallenge,signature:Buffer.from(v.signature,'base64')},()=>v.clock);process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
