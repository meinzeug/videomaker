import Database from 'better-sqlite3';
import {completeRelayPairing} from '../../lib/relay-pairing-registry.ts';
const [file]=process.argv.slice(2),db=new Database(file,{timeout:10000});db.pragma('busy_timeout=10000');process.send('ready');
process.once('message',message=>{
 const x=message.input;
 for(const role of ['camera','prompter']){x[role].publicKey=Buffer.from(x[role].publicKey,'base64');x[role].signature=Buffer.from(x[role].signature,'base64');}
 try{process.send({ok:true,value:completeRelayPairing(db,message.owner,x,()=>message.clock,()=>true)});}catch(error){process.send({ok:false,error:String(error)});}
 finally{db.close();process.disconnect();}
});
