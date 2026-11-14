import {authorized,sameOrigin,sessionAuthorized,sessionValue} from '@/lib/auth';
import {completeForGeneration,SYSTEM_PROMPT,parseJson,isTransientOpenRouterError,retryAfterSeconds,OpenRouterError} from '@/lib/openrouter';
import db from '@/lib/db';
import {startImages} from '@/lib/images';
import {channelGreetingMayMismatch,ensureChannelFraming} from '@/lib/script-format';
import {CHANNEL_SCRIPT_SYSTEM,CUSTOM_SCRIPT_SYSTEM,customScriptPrompt,scriptGenerationPrompt,GenerationChannelNotFound,InvalidGenerationChannel,ResearchChannelMismatch,saveGeneratedProject} from '@/lib/channel-generation';
import {acquireGenerationClaim,claimSnapshot,completeGenerationClaim,ensureGenerationClaimsSchema,GenerationClaimConflict,GenerationResearchMissing,invalidateGenerationResponse,readGenerationClaim,saveGenerationResponse,type GenerationClaim} from '@/lib/generation-claims';
import {InvalidScriptOptions,normalizeScriptOptions,usesCustomScript} from '@/lib/script-options';
import {NextResponse} from 'next/server';

export const maxDuration=300;
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id);
class InvalidProviderAnswer extends Error {}
class SessionRevoked extends Error {}
type Project={id:string;created_at:string;title:string;sources:unknown;content:Record<string,unknown>};

function loadProject(database:ReturnType<typeof db>,id:string):Project|null {
 const row=database.prepare('SELECT id,created_at,title,sources,content FROM projects WHERE id=?').get(id) as {id:string;created_at:string;title:string;sources:string;content:string}|undefined;
 return row?{...row,sources:JSON.parse(row.sources),content:JSON.parse(row.content)}:null;
}
function projectResponse(project:Project) {
 const warnings=Array.isArray(project.content.generation_warnings)?project.content.generation_warnings.filter((x):x is string=>typeof x==='string'):[];
 return NextResponse.json({...project,...(warnings.length?{channelWarning:warnings.join(' ')}:{})},{headers});
}

/** Read only: no status request ever starts or resumes a paid provider call. */
export async function GET(req:Request) {
 if(!await authorized())return NextResponse.json({error:'Nicht angemeldet.'},{status:401,headers});
 const query=new URL(req.url).searchParams,researchId=query.get('researchId');
 try{
  const database=db();ensureGenerationClaimsSchema(database);
  if(researchId===null){
   const before=query.get('before');
   if(before!==null&&!validId(before))return NextResponse.json({error:'Ungültiger Status-Cursor.'},{status:400,headers});
   const rows=database.transaction(()=>{
    const total=(database.prepare("SELECT count(*) AS n FROM generation_claims WHERE state<>'complete'").get() as {n:number}).n;
    const anchor=before===null?null:database.prepare('SELECT created_at AS createdAt FROM generation_claims WHERE research_id=?').get(before) as {createdAt:string}|undefined;
    if(before!==null&&!anchor)throw new GenerationClaimConflict('Status-Cursor nicht gefunden.');
    const page=(anchor?database.prepare("SELECT research_id AS researchId,state,created_at AS createdAt,image_mode AS imageMode,requested_channel AS channelId,report_json AS reportJson FROM generation_claims WHERE state<>'complete' AND (created_at<? OR (created_at=? AND research_id<?)) ORDER BY created_at DESC,research_id DESC LIMIT 21").all(anchor.createdAt,anchor.createdAt,before):database.prepare("SELECT research_id AS researchId,state,created_at AS createdAt,image_mode AS imageMode,requested_channel AS channelId,report_json AS reportJson FROM generation_claims WHERE state<>'complete' ORDER BY created_at DESC,research_id DESC LIMIT 21").all()) as Array<{researchId:string;state:string;createdAt:string;imageMode:string;channelId:string;reportJson:string}>;
    const nextBefore=page.length>20?page[19].researchId:null;
    const claims=page.slice(0,20).map(({reportJson,...row})=>{
     let summary='',scriptOptions=null;try{const report=JSON.parse(reportJson),value=report?.summary;if(typeof value==='string')summary=value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180);scriptOptions=normalizeScriptOptions(report?.generation_options);}catch{}
     return {...row,summary,scriptOptions};
    });
    return {total,claims,nextBefore};
   })();
   return NextResponse.json(rows,{headers});
  }
  if(!validId(researchId))return NextResponse.json({error:'Ungültige Recherche-ID.'},{status:400,headers});
  const claim=readGenerationClaim(database,researchId);
  if(!claim){
   const retained=!!database.prepare('SELECT 1 FROM research_reports WHERE id=?').get(researchId);
   return NextResponse.json({state:retained?'not_started':'not_found'},{headers});
  }
  if(claim.state==='complete'){
   const project=loadProject(database,claim.projectId);
   return NextResponse.json(project?{state:'complete',project}:{state:'project_missing'},{headers});
  }
  // The provider text may be the only surviving copy of an invalid or not yet
  // processed answer. Keep it accessible to the authenticated user as data.
  return NextResponse.json({state:claim.state,...(claim.responseText!==null?{responseText:claim.responseText}:{})},{headers});
 }catch(error){if(error instanceof GenerationClaimConflict)return NextResponse.json({error:error.message},{status:400,headers});console.error('Generation status unavailable.');return NextResponse.json({error:'Erstellungsstatus nicht verfügbar.'},{status:503,headers});}
}

export async function POST(req:Request) {
 if(!await authorized()||!await sameOrigin(req))return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers});
 let researchId:string|null=null,claimAcquired=false;
 try{
  const data=await req.json().catch(()=>({}));
  if(!data||!['render','descriptions'].includes(data.imageMode))return NextResponse.json({error:'Bitte wähle eine Bildoption aus.'},{status:400,headers});
  const scriptOptions=normalizeScriptOptions(data.scriptOptions);
  if(!validId(data.researchId))return NextResponse.json({error:'Vor der Skripterstellung muss eine vertiefte Recherche durchgeführt werden.'},{status:400,headers});
  researchId=data.researchId;
  const database=db();ensureGenerationClaimsSchema(database);
  const credential=await sessionValue();
  const acquired=database.transaction(()=>{
   if(!sessionAuthorized(database,credential))throw new SessionRevoked();
   // Do not leave a permanent reservation when a request could not possibly
   // be sent. Existing received/completed claims remain recoverable without a key.
   if(!readGenerationClaim(database,data.researchId)&&!process.env.OPENROUTER_API_KEY)throw new Error('OpenRouter-API-Schlüssel fehlt.');
   return acquireGenerationClaim(database,data.researchId,data.imageMode,data.channelId,new Date().toISOString(),scriptOptions);
  }).immediate();
  let claim:GenerationClaim=acquired.claim;claimAcquired=true;
  if(!acquired.created&&claim.state==='pending')return NextResponse.json({code:'generation_pending',error:'Für diese Recherche läuft eine Erstellung oder ihr Ergebnis ist ungeklärt. Es wird kein zweiter Skriptaufruf gestartet.'},{status:409,headers});
  if(claim.state==='invalid')return NextResponse.json({code:'generation_invalid',error:'Die gespeicherte KI-Antwort konnte nicht verarbeitet werden. Sie kann im Erstellungsstatus gesichert werden.'},{status:409,headers});
  if(claim.state==='complete'){
   const project=loadProject(database,claim.projectId);
   return project?projectResponse(project):NextResponse.json({code:'generation_project_missing',error:'Das bereits erstellte Skript ist nicht mehr vorhanden. Es wird nicht erneut erzeugt.'},{status:410,headers});
  }
  if(acquired.created){
   const snapshot=claimSnapshot(claim);
   const customized=usesCustomScript(snapshot.options);
   const response=await completeForGeneration(customized?CUSTOM_SCRIPT_SYSTEM:snapshot.channel?CHANNEL_SCRIPT_SYSTEM:SYSTEM_PROMPT,customized?customScriptPrompt(snapshot.channel,snapshot.sources,snapshot.report,snapshot.options!):scriptGenerationPrompt(snapshot.channel,snapshot.sources,snapshot.report),32000);
   // Persist the provider response *before* processing it or attempting the
   // project transaction. A crash before this commit remains unresolved.
   saveGenerationResponse(database,claim.researchId,response.text,new Date().toISOString(),response.truncated);
   claim=readGenerationClaim(database,claim.researchId)!;
  }
  if(claim.state!=='received'||claim.responseText===null)throw new Error('Die gespeicherte KI-Antwort ist nicht verfügbar.');
  let result:Record<string,unknown>;
  try{
   if(claim.responseTruncated)throw new Error('abgeschnitten');
   result=parseJson(claim.responseText);
   if(!result||typeof result!=='object'||!Array.isArray(result.titles)||result.titles.length!==3||result.titles.some((x:unknown)=>typeof x!=='string')||typeof result.thumbnail!=='string'||!Array.isArray(result.broll)||result.broll.length!==2||result.broll.some((x:unknown)=>typeof x!=='string')||typeof result.script!=='string'||!result.script.trim())throw new Error();
  }catch{invalidateGenerationResponse(database,claim.researchId,new Date().toISOString());throw new InvalidProviderAnswer('Die gespeicherte KI-Antwort ist unvollständig. Sie kann im Erstellungsstatus gesichert werden.');}
  const snapshot=claimSnapshot(claim),channel=snapshot.channel;
  const content:Record<string,unknown>={titles:result.titles,thumbnail:result.thumbnail,broll:result.broll,script:result.script};
  const customized=usesCustomScript(snapshot.options);
  const greetingWarning=!customized&&!!channel&&channelGreetingMayMismatch(result.script as string,channel.name);
  content.script=customized?(result.script as string).trim():ensureChannelFraming(result.script as string,channel?.name,channel?.platform);
  content.research=snapshot.report;content.image_mode=claim.imageMode;
  if(snapshot.options)content.script_options=snapshot.options;
  if(channel)content.generation_target=channel;
  const warnings=greetingWarning?['Die Begrüßung nennt möglicherweise einen anderen Kanal. Bitte vor der Aufnahme prüfen und bei Bedarf bearbeiten.']:[];
  const access=(snapshot.report as {source_access?:unknown})?.source_access;
  if(Array.isArray(access)&&access.some(item=>item?.status==='unavailable'))warnings.push('Mindestens eine Quelle war nicht abrufbar. Es wurde nur die gespeicherte Kurzbeschreibung verwendet.');
  if(Array.isArray(access)&&access.some(item=>item?.truncated))warnings.push('Mindestens ein ausgelesener Quelltext wurde auf 40.000 Zeichen begrenzt.');
  content.generation_warnings=warnings;
  const project:Project={id:claim.projectId,created_at:new Date().toISOString(),title:(result.titles as string[])[0],sources:snapshot.sources,content};
  // The project insert, channel association, research deletion and completed
  // claim commit together. A second finalizer returns the first project.
  const saved=database.transaction(()=>{
   // Provider work may finish after logout. Preserve its response above, but
   // do not mutate projects or start follow-up image work for a revoked session.
   if(!sessionAuthorized(database,credential))throw new SessionRevoked();
   const current=readGenerationClaim(database,claim.researchId);
   if(current?.state==='complete')return {created:false,project:loadProject(database,current.projectId)};
   if(!current||current.state!=='received'||current.responseText!==claim.responseText)throw new Error('Der Erstellungsstatus hat sich verändert.');
   saveGeneratedProject(database,project,claim.researchId,channel);
   completeGenerationClaim(database,claim.researchId,new Date().toISOString());
   return {created:true,project};
  }).immediate();
  if(!saved.project)return NextResponse.json({code:'generation_project_missing',error:'Das bereits erstellte Skript ist nicht mehr vorhanden.'},{status:410,headers});
  if(saved.created)try{startImages(saved.project.id,claim.imageMode);}catch{console.error('Image job could not start.');}
  return projectResponse(saved.project);
 }catch(error){
  if(error instanceof SessionRevoked)return NextResponse.json({error:'Nicht erlaubt.'},{status:403,headers});
  if(error instanceof GenerationResearchMissing||error instanceof GenerationChannelNotFound)return NextResponse.json({error:error.message},{status:404,headers});
  if(error instanceof InvalidGenerationChannel||error instanceof ResearchChannelMismatch||error instanceof InvalidScriptOptions)return NextResponse.json({error:error.message},{status:400,headers});
  if(error instanceof GenerationClaimConflict)return NextResponse.json({error:error.message},{status:409,headers});
  if(error instanceof InvalidProviderAnswer)return NextResponse.json({code:'generation_invalid',error:error.message},{status:409,headers});
  console.error('generation failed',error instanceof Error?error.message:'unknown');
  const retryAfter=retryAfterSeconds(error),retryable=isTransientOpenRouterError(error);
  // After reservation the provider may already have processed the request.
  // Never advertise automatic retry; a status query is safe after any failure.
  let retained=false;
  if(!claimAcquired&&researchId)try{retained=!!db().prepare('SELECT 1 FROM research_reports WHERE id=?').get(researchId);}catch{}
  return NextResponse.json({error:claimAcquired?'Der Erstellungsstatus ist unklar. Bitte unter „Offene KI-Erstellungen“ nachsehen; ein weiterer Skriptaufruf wird nicht automatisch gestartet.':error instanceof Error?error.message:'Generierung fehlgeschlagen.',...(claimAcquired&&researchId?{code:'generation_status_required'}:{}),...(retained?{researchRetained:true}:{})},{status:retryable?503:error instanceof OpenRouterError&&error.status===402?402:500,headers:{...headers,...(retryAfter?{'Retry-After':String(retryAfter)}:{})}});
 }
}
