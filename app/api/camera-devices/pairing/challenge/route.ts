import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {ensureCameraPairingSchema,issuePairingChallenge,parsePairingChallenge} from '@/lib/camera-device-pairing';
import {cameraError,cameraJson,cameraNotFound,cameraOwner,cameraRemoteDisabled,noStore} from '../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(cameraRemoteDisabled())return cameraNotFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const input=parsePairingChallenge(await cameraJson(req)),owner=await cameraOwner(),database=db();ensureCameraPairingSchema(database);return NextResponse.json(issuePairingChallenge(database,input,owner,cameraRemoteClock()),{headers:noStore});}catch(error){return cameraError(error);}
}
