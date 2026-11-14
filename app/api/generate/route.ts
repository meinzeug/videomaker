import { authorized, sameOrigin } from '@/lib/auth';
import { complete, SYSTEM_PROMPT, parseJson, isTransientOpenRouterError, retryAfterSeconds, OpenRouterError } from '@/lib/openrouter';
import db from '@/lib/db';
import { startImages } from '@/lib/images';
import { channelGreetingMayMismatch, ensureChannelFraming } from '@/lib/script-format';
import { CHANNEL_SCRIPT_SYSTEM, channelForResearch, scriptGenerationPrompt, GenerationChannelNotFound, InvalidGenerationChannel, ResearchChannelMismatch, saveGeneratedProject } from '@/lib/channel-generation';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
export const maxDuration=300;
type ResearchRow={sources:string;report:string};
export async function POST(req:Request) {
 if(!await authorized() || !await sameOrigin(req)) return NextResponse.json({error:'Nicht erlaubt'},{status:403});
 let retryResearchId:string|null=null;
 let persistenceStarted=false;
 try {
  const data=await req.json().catch(()=>({}));
  if(!data||!['render','descriptions'].includes(data.imageMode))return NextResponse.json({error:'Bitte wähle eine Bildoption aus.'},{status:400});
  if(typeof data.researchId!=='string'||!/^[0-9a-f-]{36}$/i.test(data.researchId))return NextResponse.json({error:'Vor der Skripterstellung muss eine vertiefte Recherche durchgeführt werden.'},{status:400});
  const research=db().prepare('SELECT sources,report FROM research_reports WHERE id=?').get(data.researchId) as ResearchRow | undefined;
  if(!research)return NextResponse.json({error:'Recherche nicht gefunden oder abgelaufen. Bitte erneut recherchieren.'},{status:404});
  retryResearchId=data.researchId;
  const safeSources=JSON.parse(research.sources),report=JSON.parse(research.report);
  let channel;
  try{channel=channelForResearch(db(),report,data.channelId);}catch(error){if(error instanceof InvalidGenerationChannel||error instanceof ResearchChannelMismatch)return NextResponse.json({error:error.message},{status:400});if(error instanceof GenerationChannelNotFound)return NextResponse.json({error:error.message},{status:404});throw error;}
  const text=await complete(channel?CHANNEL_SCRIPT_SYSTEM:SYSTEM_PROMPT,scriptGenerationPrompt(channel,safeSources,report),32000);
  const result=parseJson(text);
  if(!result||typeof result!=='object'||!Array.isArray(result.titles)||result.titles.length!==3||result.titles.some((x:unknown)=>typeof x!=='string')||typeof result.thumbnail!=='string'||!Array.isArray(result.broll)||result.broll.length!==2||result.broll.some((x:unknown)=>typeof x!=='string')||typeof result.script!=='string'||!result.script.trim()) throw new Error('Die KI hat kein vollständiges Ergebnis geliefert.');
  // Only these four fields come from the model. Server metadata and warnings
  // must never be supplied or overwritten by an untrusted model response.
  const content:Record<string,unknown>={titles:result.titles,thumbnail:result.thumbnail,broll:result.broll,script:result.script};
  const greetingWarning=!!channel&&channelGreetingMayMismatch(result.script,channel.name);
  content.script=ensureChannelFraming(result.script,channel?.name,channel?.platform);
  content.research=report;
  content.image_mode=data.imageMode;
  if(channel)content.generation_target=channel;
  content.generation_warnings=greetingWarning?['Die Begrüßung nennt möglicherweise einen anderen Kanal. Bitte vor der Aufnahme prüfen und bei Bedarf bearbeiten.']:[];
  const project={id:randomUUID(),created_at:new Date().toISOString(),title:result.titles[0] as string,sources:safeSources,content};
  persistenceStarted=true;
  saveGeneratedProject(db(),project,data.researchId,channel);
  try { startImages(project.id,data.imageMode); } catch (e) { console.error('Image job could not start:', e instanceof Error ? e.message : 'unknown'); }
  const warnings=Array.isArray(project.content.generation_warnings)?project.content.generation_warnings:[];
  return NextResponse.json({...project,...(warnings.length?{channelWarning:warnings.join(' ')}:{})});
 } catch(e) { console.error('generation failed',e instanceof Error?e.message:'unknown'); const retryable=isTransientOpenRouterError(e),retryAfter=retryAfterSeconds(e);
  // Only a failure strictly before the persistence attempt can safely offer a
  // retry. A failed or ambiguous COMMIT must never be treated as not saved.
  let researchRetained=false;
  if(retryResearchId&&!persistenceStarted)try{researchRetained=!!db().prepare('SELECT 1 FROM research_reports WHERE id=?').get(retryResearchId);}catch{}
  return NextResponse.json({error:e instanceof Error?e.message:'Generierung fehlgeschlagen.',...(researchRetained?{researchRetained:true}:{})},{status:retryable?503:e instanceof OpenRouterError&&e.status===402?402:500,headers:retryAfter?{'Retry-After':String(retryAfter)}:undefined}); }
}
