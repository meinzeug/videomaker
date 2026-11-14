import {authorized} from '@/lib/auth';
import {internalSessionSecretConfigured,internalSessionSecretValid} from '@/lib/buchhaltung-session';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

/** Only the companion service should know the secret; never disclose session details. */
export async function GET(req:Request) {
 const secret=process.env.BUCHHALTUNG_SESSION_CHECK_SECRET;
 if(!internalSessionSecretConfigured(secret))return new Response(null,{status:503,headers});
 if(!internalSessionSecretValid(secret,req.headers.get('x-videomaker-internal-secret')))return new Response(null,{status:401,headers});
 try{return new Response(null,{status:await authorized()?204:401,headers});}
 catch{return new Response(null,{status:503,headers});}
}
