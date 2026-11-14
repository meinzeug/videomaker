import {authorized} from '@/lib/auth';
import {openApkRelease} from '@/lib/apk-download';
import {Readable} from 'node:stream';
import {NextResponse} from 'next/server';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};

async function download(head:boolean) {
 if(!await authorized())return NextResponse.json({error:'Bitte melde dich an, um KontraPrompter herunterzuladen.'},{status:401,headers:privateHeaders});
 let release;
 try{release=await openApkRelease(process.env.DATA_DIR||'./data');}
 catch{return NextResponse.json({error:'Das KontraPrompter-APK ist derzeit nicht verfügbar.'},{status:404,headers:privateHeaders});}
 const headers={...privateHeaders,'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="KontraPrompter-debug.apk"','Content-Length':String(release.size)};
 if(head){await release.file.close();return new Response(null,{status:200,headers});}
 const stream=Readable.toWeb(release.file.createReadStream({start:0,autoClose:true})) as ReadableStream<Uint8Array>;
 return new Response(stream,{status:200,headers});
}
export async function GET(){return download(false);}
export async function HEAD(){return download(true);}
