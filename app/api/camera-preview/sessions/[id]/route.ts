import {authorized,sameOrigin} from '@/lib/auth';
import db from '@/lib/db';
import {cameraRemoteClock} from '@/lib/camera-remote-clock';
import {cameraPreviewStore} from '@/lib/camera-preview-store';
import {cameraCredential} from '@/app/api/camera-devices/_shared';
import {disabled,noStore,notFound,previewError,previewTransaction} from '../../_shared';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function DELETE(req:Request,{params}:{params:Promise<{id:string}>}){
 if(disabled())return notFound();
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers:noStore});
 try{const {id}=await params,credential=await cameraCredential(),database=db();return NextResponse.json(previewTransaction(database,credential,owner=>cameraPreviewStore().close(id,owner,cameraRemoteClock())),{headers:noStore});}catch(error){return previewError(error);}
}
