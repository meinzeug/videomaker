import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {ensureCameraPairingSchema,issuePairingChallenge,parsePairingChallenge} from '@/lib/camera-device-pairing';
import {cameraCredential,cameraError,cameraJson,cameraNotFound,cameraRemoteDisabled,cameraTransaction,noStore} from '../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const input=parsePairingChallenge(await cameraJson(req)),credential=await cameraCredential(),database=db();ensureCameraPairingSchema(database);const result=cameraTransaction(database,credential,owner=>issuePairingChallenge(database,input,owner,cameraRemoteClock()));return NextResponse.json(result,{headers:noStore});}catch(error){return cameraError(error);}
}
