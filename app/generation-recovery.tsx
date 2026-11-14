'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {Project} from './studio-types';
import type {ScriptOptions} from '@/lib/script-options';

type Claim={researchId:string;state:'pending'|'received'|'invalid';createdAt:string;imageMode:'render'|'descriptions';channelId:string;summary:string;scriptOptions?:ScriptOptions|null;pipelinePhase?:string;partCount?:number|null;completedParts?:number;maxProviderAttempts?:number|null;attemptCount?:number;reportedCostUsd?:number|null;unknownCostAttempts?:number;promptTokens?:number|null;completionTokens?:number|null};
type Result={total:number;claims:Claim[];nextBefore:string|null};
const resumable=(phase:unknown)=>phase==='facts_ready'||phase==='script_ready'||phase==='repair_ready'||phase==='parts_ready';

/** An explicit status/recovery path; it never retries an uncertain provider call. */
export default function GenerationRecovery({refreshKey,active=false,onProject}:{refreshKey:number;active?:boolean;onProject:(project:Project)=>void}) {
 const [result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState('');
 const running=useRef(false),mounted=useRef(true),refreshSequence=useRef(0);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;refreshSequence.current++;};},[]);
 const refresh=useCallback(async()=>{
  const sequence=++refreshSequence.current;
  try{
   const response=await fetch('/api/generate',{cache:'no-store'}),body=await response.json();
   if(!response.ok||!body||!Array.isArray(body.claims)||typeof body.total!=='number'||!(body.nextBefore===null||typeof body.nextBefore==='string'))throw new Error(body?.error||'Erstellungsstatus nicht verfügbar.');
   if(mounted.current&&refreshSequence.current===sequence){setResult(body as Result);setError('');}
  }catch(e){if(mounted.current&&refreshSequence.current===sequence)setError(e instanceof Error?e.message:'Erstellungsstatus nicht verfügbar.');}
 },[]);
 useEffect(()=>{void refresh();},[refresh,refreshKey]);
 useEffect(()=>{if(!active)return;const timer=window.setInterval(()=>void refresh(),2000);return()=>window.clearInterval(timer);},[active,refresh]);
 async function more(){
  const before=result?.nextBefore;if(!before||running.current)return;
  const sequence=refreshSequence.current;running.current=true;setWorking('more');setError('');
  try{
   const response=await fetch(`/api/generate?before=${encodeURIComponent(before)}`,{cache:'no-store'}),body=await response.json();
   if(!response.ok||!body||!Array.isArray(body.claims)||typeof body.total!=='number'||!(body.nextBefore===null||typeof body.nextBefore==='string'))throw new Error(body?.error||'Weitere Einträge konnten nicht geladen werden.');
   if(mounted.current&&sequence===refreshSequence.current)setResult(previous=>{
    if(!previous||previous.nextBefore!==before)return previous;
    const ids=new Set(previous.claims.map(item=>item.researchId));
    return {total:body.total,claims:[...previous.claims,...(body.claims as Claim[]).filter(item=>!ids.has(item.researchId))],nextBefore:body.nextBefore};
   });
  }catch(e){if(mounted.current&&sequence===refreshSequence.current)setError(e instanceof Error?e.message:'Weitere Einträge konnten nicht geladen werden.');}
  finally{running.current=false;if(mounted.current)setWorking('');}
 }
 async function inspect(claim:Claim,download:false|'response'|'parts'=false){
  if(running.current)return;running.current=true;setWorking(claim.researchId);setError('');setNotice('');
  try{
   const response=await fetch(`/api/generate?researchId=${encodeURIComponent(claim.researchId)}`,{cache:'no-store'}),body=await response.json();
   if(!response.ok)throw new Error(body?.error||'Erstellungsstatus nicht verfügbar.');
   if(!mounted.current)return;
   if(download){
    let stored=download==='parts'&&Array.isArray(body.parts)?body.parts.flatMap((part:{response?:unknown})=>{try{if(typeof part.response!=='string')return [];const envelope=JSON.parse(part.response),value=JSON.parse(envelope.text);return typeof value.skript==='string'?[value.skript]:[];}catch{return [];}}).join('\n\n'):body.responseText;if(typeof stored!=='string'){const raw=body.repairResponse||body.scriptResponse||(Array.isArray(body.parts)?[...body.parts].reverse().find((item:{response?:unknown})=>typeof item.response==='string')?.response:null)||body.factsResponse;try{stored=JSON.parse(raw).text;}catch{}}
    if(typeof stored!=='string'||!stored.trim())throw new Error('Eine gespeicherte KI-Antwort ist nicht verfügbar.');
    const url=URL.createObjectURL(new Blob([stored],{type:'text/plain;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=download==='parts'?'originale-skriptteile.txt':'ki-antwort.txt';document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice('Die gespeicherte KI-Antwort wurde zum Download bereitgestellt.');return;
   }
   if(body.state==='complete'&&body.project){onProject(body.project as Project);setNotice('Das gespeicherte Skript wurde geöffnet.');await refresh();return;}
   if(body.state==='received'||(body.state==='pending'&&resumable(body.pipelinePhase))){
    const finish=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({researchId:claim.researchId,imageMode:claim.imageMode,channelId:claim.channelId||null,scriptOptions:claim.scriptOptions??null})});
    const project=await finish.json();if(!finish.ok)throw new Error(project?.error||'Das Skript konnte noch nicht fertiggestellt werden.');if(!mounted.current)return;
    onProject(project as Project);setNotice('Das gespeicherte Skript wurde geöffnet.');await refresh();return;
   }
   if(body.state==='pending')setNotice(body.pipelinePhase==='facts_invalid'||body.pipelinePhase==='parts_invalid'?'Das gespeicherte Faktenblatt oder ein Skriptteil ist unvollständig und kann nicht automatisch fortgesetzt werden.':'Ein Modellaufruf läuft möglicherweise noch oder sein Ergebnis ist unklar. Es wird kein zweiter Aufruf gestartet.');
   else if(body.state==='invalid')setNotice('Die KI-Antwort ist gespeichert, konnte aber nicht verarbeitet werden. Du kannst sie herunterladen.');
   else if(body.state==='project_missing')setNotice('Das bereits erstellte Skript ist nicht mehr vorhanden. Es wird nicht automatisch neu erzeugt.');
   else setNotice('Für diesen Eintrag ist kein wiederherstellbares Ergebnis verfügbar.');
   await refresh();
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Erstellungsstatus nicht verfügbar.');}
  finally{running.current=false;if(mounted.current)setWorking('');}
 }
 if(!error&&result?.total===0)return null;
 return <section className="panel" aria-label="Offene KI-Erstellungen">
  <div className="section-heading"><div><p className="eyebrow">ERSTELLUNGSSTATUS</p><h2>Offene KI-Erstellungen<span>.</span></h2></div><button className="secondary-action" type="button" onClick={()=>void refresh()} disabled={!!working}>Aktualisieren</button></div>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {!result&&!error&&<p role="status">Status wird geladen …</p>}
  {!!result?.total&&<><p>Bei ungeklärten Modellaufrufen wird kein weiterer Aufruf automatisch gestartet. Das ausdrücklich gewählte Fortsetzen eines gespeicherten Zwischenstands kann weitere KI-Kosten verursachen; Bildplanung und gegebenenfalls Bilderzeugung ebenfalls.{result.total>result.claims.length?` ${result.claims.length} von ${result.total} Einträgen werden angezeigt.`:''}</p>
   {result.claims.map(claim=><div key={claim.researchId} className="generation-recovery-row">
    <div><strong>{claim.state==='received'?'Antwort gespeichert':claim.state==='invalid'?'Antwort unvollständig':'Läuft oder unterbrochen'}</strong><p>{claim.summary||`Recherche ${claim.researchId}`}</p>{typeof claim.partCount==='number'&&<p>KI-Plan: {claim.partCount} Teil{claim.partCount===1?'':'e'}, {claim.completedParts??0} gespeichert; bis zu {claim.maxProviderAttempts} Provider-Versuche für Faktenblatt, Teile und Korrektur zusammen. {claim.attemptCount??0} Versuche bisher; {typeof claim.reportedCostUsd==='number'?`${claim.reportedCostUsd.toFixed(6)} USD vom Provider gemeldet`:'bisher keine Kosten gemeldet'}{(claim.unknownCostAttempts??0)>0?`, bei ${claim.unknownCostAttempts} Versuchen Kosten unbekannt`:''}. {typeof claim.promptTokens==='number'&&typeof claim.completionTokens==='number'?`${claim.promptTokens} Eingabe- und ${claim.completionTokens} Ausgabetokens, soweit gemeldet. `:''}Webrecherche und Bildarbeit sind nicht enthalten.</p>}</div>
    <div><button type="button" className="secondary-action" disabled={!!working} onClick={()=>void inspect(claim)}>{working===claim.researchId?'Wird geprüft …':claim.state==='received'?'Skript fertigstellen':resumable(claim.pipelinePhase)?'Fortsetzen (KI-Kosten möglich)':'Status prüfen'}</button>{(claim.state!=='pending'||claim.pipelinePhase==='facts_invalid'||claim.pipelinePhase==='parts_invalid'||resumable(claim.pipelinePhase))&&<> <button type="button" className="secondary-action" disabled={!!working} onClick={()=>void inspect(claim,'response')}>KI-Antwort herunterladen</button></>}{typeof claim.completedParts==='number'&&claim.completedParts>0&&<> <button type="button" className="secondary-action" disabled={!!working} onClick={()=>void inspect(claim,'parts')}>Originalteile herunterladen</button></>}</div>
   </div>)}
   {result.nextBefore&&<button type="button" className="secondary-action" disabled={!!working} onClick={()=>void more()}>{working==='more'?'Wird geladen …':'Weitere Einträge laden'}</button>}
  </>}
 </section>;
}
