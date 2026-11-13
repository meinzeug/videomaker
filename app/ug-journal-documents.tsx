'use client';
import {useCallback,useEffect,useState} from 'react';
import type {LedgerJournal} from '@/lib/ug-ledger';
import type {LedgerDocumentLink,LedgerDocumentOption} from '@/lib/ug-ledger-documents';
import type {PendingJournal} from './api/ledger/_safety';

const input:React.CSSProperties={width:'100%',padding:'11px 12px',border:'1px solid #4b4d56',borderRadius:10,background:'#17191f',color:'#f5f5f7',font:'inherit'};
const field:React.CSSProperties={display:'grid',gap:6,minWidth:0};
type Props={journals:LedgerJournal[];locked:boolean;revision:number;onAuth:()=>void;onSubmit:(item:PendingJournal)=>void};

/** Explicit user linking only. Beleg selection is independent of the preliminary finance entry. */
export default function UgJournalDocuments({journals,locked,revision,onAuth,onSubmit}:Props){
 const [journalId,setJournalId]=useState(''),[documentId,setDocumentId]=useState('');
 const [options,setOptions]=useState<LedgerDocumentOption[]>([]),[nextBefore,setNextBefore]=useState<number|null>(null),[links,setLinks]=useState<LedgerDocumentLink[]>([]);
 const [busy,setBusy]=useState(false),[linksLoading,setLinksLoading]=useState(false),[linksReady,setLinksReady]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState(''),[correcting,setCorrecting]=useState('');
 const selected=options.find(item=>item.id===documentId);
 const alreadyLinked=!!selected&&links.some(link=>link.documentId===selected.id&&!link.unlinkId);
 const loadOptions=useCallback(async(before:number|null=null)=>{
  setBusy(true);setError('');
  try{const response=await fetch(`/api/ledger/documents${before===null?'':`?before=${before}`}`,{cache:'no-store'});if(response.status===401||response.status===403){onAuth();throw new Error('Bitte erneut anmelden.');}const value=await response.json();if(!response.ok||!Array.isArray(value.documents)||(value.nextBefore!==null&&typeof value.nextBefore!=='number'))throw new Error('Belege konnten nicht geladen werden.');setOptions(previous=>before===null?value.documents:[...previous,...value.documents]);setNextBefore(value.nextBefore);}
  catch(e){setError(e instanceof Error?e.message:'Belege konnten nicht geladen werden.');}finally{setBusy(false);}
 },[onAuth]);
 useEffect(()=>{void loadOptions();},[loadOptions,revision]);
 useEffect(()=>{
  if(!journalId){setLinks([]);setLinksReady(false);setLinksLoading(false);return;}
  const controller=new AbortController();setError('');setLinks([]);setLinksReady(false);setLinksLoading(true);
  void (async()=>{try{const response=await fetch(`/api/ledger/journals/${encodeURIComponent(journalId)}/documents`,{cache:'no-store',signal:controller.signal});if(response.status===401||response.status===403){onAuth();throw new Error('Bitte erneut anmelden.');}const value=await response.json();if(!response.ok||!Array.isArray(value.links))throw new Error('Zuordnungen konnten nicht geladen werden.');if(!controller.signal.aborted){setLinks(value.links);setLinksReady(true);}}
   catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Zuordnungen konnten nicht geladen werden.');}finally{if(!controller.signal.aborted)setLinksLoading(false);}})();
  return()=>controller.abort();
 },[journalId,revision,onAuth]);
 function attach(event:React.FormEvent){
  event.preventDefault();if(locked||busy||linksLoading||!linksReady||alreadyLinked||links.length>=500||!selected||!journalId)return;
  onSubmit({version:1,action:'document-link',uncertain:false,body:{id:crypto.randomUUID(),journalId,documentId:selected.id,financeEntryId:selected.entryId,sha256:selected.sha256}});
 }
 function unlink(event:React.FormEvent,link:LedgerDocumentLink){
  event.preventDefault();const clean=reason.trim();if(locked||busy||!clean||clean.length>250||/[\u0000-\u001f\u007f]/.test(clean))return;
  onSubmit({version:1,action:'document-unlink',uncertain:false,body:{id:crypto.randomUUID(),journalId,linkId:link.id,reason:clean}});setCorrecting('');setReason('');
 }
 return <section className="panel" style={{display:'grid',gap:14,marginBottom:24,maxWidth:960}} aria-label="Belegzuordnung">
  <div><p className="eyebrow">05 / BELEGE</p><h2>Originalbeleg zuordnen</h2></div>
  <p>Wähle eine vorhandene Buchung und einen bereits in Finanzen abgelegten Originalbeleg. Die Zuordnung erstellt keine Buchung und übernimmt keinen Betrag. Jede Zuordnung und begründete Korrektur bleibt im Verlauf sichtbar.</p>
  <p>Der Beleg wird beim Zuordnen und Herunterladen auf seine unveränderten Originaldaten geprüft. Bei einer Stornobuchung werden Zuordnungen nicht automatisch übernommen.</p>
  {error&&<p role="alert" className="error">{error}</p>}
  <label style={field}>Buchung<select style={input} value={journalId} onChange={e=>{setJournalId(e.target.value);setCorrecting('');setReason('');}}><option value="">Buchung auswählen</option>{journals.map(j=><option key={j.id} value={j.id}>{j.occurredOn} · {j.kind==='reversal'?'Storno · ':''}{j.description} · {j.id}</option>)}</select></label>
  {!journals.length&&<p>Bitte zuerst eine Buchung erfassen.</p>}
  <form onSubmit={attach} style={{display:'grid',gap:12}}>
   <label style={field}>Vorhandener Originalbeleg<select style={input} disabled={locked||busy} value={documentId} onChange={e=>setDocumentId(e.target.value)}><option value="">Beleg auswählen</option>{options.map(d=><option key={d.id} value={d.id}>{d.originalName} · {d.financeDate} · {d.financeDescription}</option>)}</select></label>
   {selected&&<p>Finanzvorgang: {selected.financeDescription} · {selected.financeDate}<br/>SHA-256: <span style={{overflowWrap:'anywhere'}}>{selected.sha256}</span></p>}
   {alreadyLinked&&<p>Dieser Beleg ist bereits aktiv zugeordnet.</p>}
   {links.length>=500&&<p>Für diese Buchung ist die Höchstzahl an Zuordnungen erreicht.</p>}
   <button type="submit" className="primary" disabled={locked||busy||linksLoading||!linksReady||alreadyLinked||links.length>=500||!journalId||!selected} style={{justifySelf:'start'}}>Beleg dieser Buchung zuordnen</button>
  </form>
  {nextBefore!==null&&<button type="button" className="secondary-action" disabled={busy} onClick={()=>void loadOptions(nextBefore)}>Weitere Belege laden</button>}
  {!options.length&&!busy&&<p>Keine Belege vorhanden. Lade zuerst einen Originalbeleg im Finanzbereich zu einem Vorgang hoch.</p>}
  {journalId&&<div><h3>Zuordnungen und Korrekturen</h3>{linksLoading?<p>Zuordnungen werden geladen …</p>:!linksReady?<p>Zuordnungen konnten nicht geladen werden.</p>:!links.length?<p>Noch keine Belege zugeordnet.</p>:links.map(link=><article key={link.id} style={{borderTop:'1px solid #45474f',padding:'14px 0',display:'grid',gap:8}}><strong>{link.originalName}</strong><p>{link.unlinkId?'Korrigiert':'Aktiv'} · zugeordnet am {link.createdAt} · {link.size} Bytes<br/>SHA-256: <span style={{overflowWrap:'anywhere'}}>{link.sha256}</span></p>{link.unlinkId&&<p>Korrektur am {link.unlinkedAt} · Grund: {link.unlinkReason}</p>}<a href={`/api/ledger/documents/${encodeURIComponent(link.id)}/download`}>Originalbeleg geprüft herunterladen</a>{!link.unlinkId&&(correcting===link.id?<form onSubmit={e=>unlink(e,link)} style={{display:'grid',gap:8}}><label style={field}>Grund der Korrektur<input style={input} maxLength={250} value={reason} disabled={locked} onChange={e=>setReason(e.target.value)} required/></label><div><button className="secondary-action" disabled={locked||busy||!reason.trim()} type="submit">Zuordnung mit Begründung korrigieren</button> <button className="secondary-action" type="button" disabled={locked} onClick={()=>{setCorrecting('');setReason('');}}>Abbrechen</button></div></form>:<button className="secondary-action" type="button" disabled={locked} style={{justifySelf:'start'}} onClick={()=>setCorrecting(link.id)}>Zuordnung korrigieren</button>)}</article>)}</div>}
 </section>;
}
