// Local, disabled fixture only. Not a Next.js route and not production auth.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createStudioDeviceAuth} from '../../lib/studio-device-auth-core.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const b64url=/^[A-Za-z0-9_-]+$/;
const scope=Object.freeze(['projects:read','recordings:upload']);

function decode(value,max) {
 if(typeof value!=='string'||value.length>max*2||!b64url.test(value))return null;
 const raw=Buffer.from(value,'base64url');
 return raw.length>0&&raw.length<=max&&raw.toString('base64url')===value?raw:null;
}
function cookie(req){
 const raw=req.headers.cookie;if(typeof raw!=='string'||raw.length>1024)return null;
 const parts=raw.split(';').map(x=>x.trim()).filter(x=>x.startsWith('fixture_session='));
 if(parts.length!==1)return null;const value=parts[0].slice('fixture_session='.length);
 return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
}
function json(res,status,body){
 const value=JSON.stringify(body);
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
 res.end(value);
}
function readJson(req,limit=2048,deadline=3000){
 return new Promise((resolve,reject)=>{
  let size=0,settled=false;const chunks=[];
  // Keep an error listener attached through close, including after a timeout:
  // a late client disconnect must not become an unhandled EventEmitter error.
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);req.off('data',data);req.off('end',end);if(error)reject(error);else resolve(value);};
  const fail=()=>finish(Error('body'));
  const data=chunk=>{size+=chunk.length;if(size>limit){req.pause();finish(Error('body'));return;}chunks.push(chunk);};
  const end=()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();finish(null,value);}catch{finish(Error('body'));}};
  const timer=setTimeout(()=>{req.pause();finish(Error('body'));},deadline);
  req.on('data',data);req.on('end',end);req.on('error',fail);
 });
}
function exact(body,fields){return Object.keys(body).sort().join(',')===[...fields].sort().join(',');}
function equal(a,b){const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');return x.length===32&&y.length===32&&timingSafeEqual(x,y);}

/** db has only synthetic fixture sessions; caller must supply a >=32-byte fixture secret. */
export function createDeviceHttpFixture({db,challengeSecret,ownerSecret,clock=Date.now,origin='https://fixture.invalid'}){
 if(!Buffer.isBuffer(ownerSecret)||ownerSecret.length<32)throw Error('Fixture owner secret required');
 const auth=createStudioDeviceAuth(db,clock,challengeSecret);
 const buckets=new Map();
 function throttle(key){
  const now=performance.now(),old=buckets.get(key);
  if(!old&&buckets.size>=512){
   for(const [name,bucket] of buckets)if(now-bucket.at>=10_000)buckets.delete(name);
   if(buckets.size>=512)return false;
  }
  if(!old||now-old.at>=10_000){buckets.set(key,{at:now,count:1});return true;}
  if(old.count>=40)return false;old.count++;return true;
 }
 function browser(req){
  if(req.headers.origin!==origin||typeof req.headers['x-fixture-csrf']!=='string'||req.headers['x-fixture-csrf'].length>128)return null;
  const token=cookie(req);if(!token)return null;
  const csrf=req.headers['x-fixture-csrf'];
  const valid=()=>{
   const row=db.prepare('SELECT csrf_hash FROM fixture_browser_sessions WHERE token_hash=?').get(hash(token));
   return !!row&&equal(row.csrf_hash,hash(csrf));
  };
  if(!valid())return null;
  const owner=createHmac('sha256',ownerSecret).update('studio-fixture-owner/v1\0').update(token).digest('hex');
  return {token,valid,owner};
 }
 return async(req,res)=>{
  try{
   if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return json(res,403,{error:'Nicht erlaubt'});
   if(!throttle('global')||!throttle('ip:'+req.socket.remoteAddress))return json(res,429,{error:'Später erneut versuchen'});
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.search||url.hash)return json(res,404,{error:'Nicht gefunden'});
   if(req.method==='GET'&&url.pathname==='/fixture/projects'){
    const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');
    if(!match||!auth.permits(match[1],'projects:read'))return json(res,403,{error:'Nicht erlaubt'});
    return json(res,200,{projects:[]});
   }
   if(req.method==='GET'&&url.pathname==='/fixture/admin')return json(res,403,{error:'Nicht erlaubt'});
   if(req.method!=='POST'||req.headers['content-type']!=='application/json')return json(res,404,{error:'Nicht gefunden'});
   const body=await readJson(req);
   if(['/fixture/enroll/begin','/fixture/enroll/complete','/fixture/revoke','/fixture/logout'].includes(url.pathname)){
    const session=browser(req);if(!session)return json(res,403,{error:'Nicht erlaubt'});
    if(url.pathname==='/fixture/logout'){
     if(!exact(body,[]))return json(res,400,{error:'Ungültige Anfrage'});
     const deleted=db.transaction(()=>session.valid()?db.prepare('DELETE FROM fixture_browser_sessions WHERE token_hash=?').run(hash(session.token)).changes:0).immediate();
     return json(res,deleted?200:403,deleted?{ok:true}:{error:'Nicht erlaubt'});
    }
    if(url.pathname==='/fixture/enroll/begin'){
     const pub=decode(body.publicKey,256);
     if(!exact(body,['deviceId','publicKey'])||!uuid.test(body.deviceId)||!pub)return json(res,400,{error:'Ungültige Anfrage'});
     const out=auth.beginEnrollment(body.deviceId,pub,scope,session.owner,session.valid);
     if(!out)return json(res,403,{error:'Nicht erlaubt'});
     const parts=out.message.toString('utf8').split('\n');
     return json(res,200,{challengeId:out.challengeId,nonce:parts[3],ownerHash:session.owner,scope,expiresInMs:out.expiresInMs});
    }
    if(url.pathname==='/fixture/enroll/complete'){
     const sig=decode(body.signature,80);
     if(!exact(body,['deviceId','challengeId','signature'])||!uuid.test(body.deviceId)||!uuid.test(body.challengeId)||!sig)return json(res,400,{error:'Ungültige Anfrage'});
     const out=auth.completeEnrollment(body.deviceId,body.challengeId,sig,session.owner,session.valid);
     return out?json(res,200,out):json(res,403,{error:'Nicht erlaubt'});
    }
    if(!exact(body,['deviceId'])||!uuid.test(body.deviceId))return json(res,400,{error:'Ungültige Anfrage'});
    return auth.revoke(body.deviceId,session.valid)?json(res,200,{revoked:true}):json(res,403,{error:'Nicht erlaubt'});
   }
   if(url.pathname==='/fixture/login/begin'){
    if(!exact(body,['deviceId'])||!uuid.test(body.deviceId))return json(res,400,{error:'Ungültige Anfrage'});
    if(!throttle('device:'+body.deviceId))return json(res,429,{error:'Später erneut versuchen'});
    const out=auth.beginLogin(body.deviceId);
    return out?json(res,200,{challengeId:out.challengeId,challengeToken:out.challengeToken,expiresInMs:out.expiresInMs}):json(res,403,{error:'Nicht erlaubt'});
   }
   if(url.pathname==='/fixture/login/complete'){
    const sig=decode(body.signature,80);
    if(!exact(body,['deviceId','challengeToken','signature'])||!uuid.test(body.deviceId)||typeof body.challengeToken!=='string'||body.challengeToken.length>200||!sig)return json(res,400,{error:'Ungültige Anfrage'});
    if(!throttle('device:'+body.deviceId))return json(res,429,{error:'Später erneut versuchen'});
    const out=auth.completeLogin(body.deviceId,body.challengeToken,sig);
    return out?json(res,200,out):json(res,403,{error:'Nicht erlaubt'});
   }
   return json(res,404,{error:'Nicht gefunden'});
  }catch{if(!res.headersSent)json(res,400,{error:'Ungültige Anfrage'});else res.destroy();}
 };
}
