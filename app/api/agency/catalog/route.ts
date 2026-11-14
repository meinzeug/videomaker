import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { authorized,sessionAuthorized,sessionSignatureValid,sessionValue } from '@/lib/auth';
import { issueAgencyTicket,validAgencyCatalogItem,type AgencyCatalogItem } from '@/apps/buchhaltung/apps/web/src/server/videomaker-catalog-tickets';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const limit=2000;

/** Only names and IDs leave the Studio; script contents and credentials do not. */
export async function GET(){
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
 const secret=process.env.HABEN_AGENCY_CATALOG_SECRET,value=await sessionValue();
 if(!secret||secret.length<32)return NextResponse.json({error:'Die Agenturzuordnung ist noch nicht eingerichtet.'},{status:503,headers});
 if(!sessionSignatureValid(value))return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
 try{
  const database=db();
  return database.transaction(()=>{
   if(!sessionAuthorized(database,value))return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
   const channels=database.prepare('SELECT id,name,platform FROM channels ORDER BY name COLLATE NOCASE,id LIMIT ?').all(limit+1) as Array<{id:string;name:string;platform:string}>;
   const projects=database.prepare('SELECT id,title FROM projects ORDER BY created_at DESC,id LIMIT ?').all(limit+1) as Array<{id:string;title:string}>;
   if(channels.length>limit||projects.length>limit)return NextResponse.json({error:'Der Agenturkatalog ist zu groß; bitte eingrenzen.'},{status:503,headers});
   const result:AgencyCatalogItem[]=[];let omitted=0;
   const platforms=new Set(['youtube','tiktok','twitch','instagram','facebook']);
   for(const channel of channels){
    const platform=typeof channel.platform==='string'?channel.platform.trim().toLowerCase():'';
    const item={kind:'channel' as const,id:typeof channel.id==='string'?channel.id.toLowerCase():'',name:typeof channel.name==='string'?channel.name.trim():'',platform};
    if(validAgencyCatalogItem(item)){result.push(item);platforms.add(platform);}else omitted++;
   }
   for(const project of projects){
    const item={kind:'project' as const,id:typeof project.id==='string'?project.id.toLowerCase():'',name:typeof project.title==='string'?project.title.trim():'',platform:null};
    if(validAgencyCatalogItem(item))result.push(item);else omitted++;
   }
   for(const platform of [...platforms].sort()){
    const name=({youtube:'YouTube',tiktok:'TikTok',twitch:'Twitch',instagram:'Instagram',facebook:'Facebook'} as Record<string,string>)[platform]||platform;
    const item={kind:'platform' as const,id:platform,name,platform};if(validAgencyCatalogItem(item))result.push(item);
   }
   const now=Date.now();
   return NextResponse.json({items:result.map(item=>({...item,ticket:issueAgencyTicket(secret,value,item,now)})),omitted},{headers});
  }).immediate();
 }catch{return NextResponse.json({error:'Der Agenturkatalog ist nicht verfügbar.'},{status:503,headers});}
}
