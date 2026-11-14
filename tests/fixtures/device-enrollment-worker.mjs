import Database from 'better-sqlite3';
import {completeQrEnrollmentFixture} from '../../experiments/device-auth/qr-enrollment.mjs';
process.env.NODE_ENV='test';process.env.VIDEOMAKER_DEVICE_AUTH_FIXTURE='1';
let data='';for await(const part of process.stdin)data+=part;
const payload=JSON.parse(data),db=new Database(payload.path);db.pragma('foreign_keys=ON');
for(const side of ['camera','prompter'])for(const field of ['publicKey','signature'])payload.input[side][field]=Buffer.from(payload.input[side][field],'base64');
try{completeQrEnrollmentFixture(db,{ownerHash:payload.ownerHash,sessionHash:payload.sessionHash,token:payload.token,input:payload.input},()=>payload.clock,()=>true);process.exitCode=0;}catch{process.exitCode=2;}finally{db.close();}
