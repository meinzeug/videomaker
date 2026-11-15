import Database from 'better-sqlite3';
import {beginStudioDeviceEnrollment} from '../../lib/studio-device-enrollment.ts';
import {revokeSession} from '../../lib/session-revocations.ts';
const [file,mode,token,device,key]=process.argv.slice(2);
if(!file?.startsWith('/dev/shm/studio-real-enroll-')||!['begin','revoke'].includes(mode)||process.env.STUDIO_ENROLLMENT_TEST!=='1')throw Error('invalid fixture');
const db=new Database(file,{fileMustExist:true,timeout:5000});db.pragma('synchronous=FULL');process.send('ready');
process.once('message',()=>{
 try{if(mode==='begin'){const result=beginStudioDeviceEnrollment(db,token,{deviceId:device,publicKey:Buffer.from(key,'base64url')});process.send({issued:!!result});}
 else{revokeSession(db,process.env.SESSION_SECRET,token,Date.now());process.send({revoked:true});}}
 catch(e){process.send({error:e.message});}finally{db.close();}
});
