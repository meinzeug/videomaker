import {authorized,sameOrigin} from '@/lib/auth';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraPreviewStore} from '@/lib/camera-preview-store';
import {cameraOwner} from '@/app/api/camera-devices/_shared';
import {disabled,noStore,notFound,previewError,previewJson} from '../../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 if(disabled())return notFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const {id}=await params,result=cameraPreviewStore().browserExchange(id,await cameraOwner(),await previewJson(req),cameraRemoteClock());return NextResponse.json(result,{headers:noStore});}catch(error){return previewError(error);}
}
