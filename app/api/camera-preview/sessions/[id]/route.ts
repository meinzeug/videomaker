import {authorized,sameOrigin} from '@/lib/auth';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraPreviewStore} from '@/lib/camera-preview-store';
import {cameraOwner} from '@/app/api/camera-devices/_shared';
import {disabled,noStore,notFound,previewError} from '../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function DELETE(req:Request,{params}:{params:Promise<{id:string}>}){
 if(disabled())return notFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const {id}=await params;return NextResponse.json(cameraPreviewStore().close(id,await cameraOwner(),cameraRemoteClock()),{headers:noStore});}catch(error){return previewError(error);}
}
