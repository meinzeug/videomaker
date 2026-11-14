'use client';
import {useCallback,useEffect,useState} from 'react';
import type {FinanceEntry} from '@/lib/finance';
import type {LedgerJournal} from '@/lib/ug-ledger';
import type {LedgerFinanceLink} from '@/lib/ug-ledger-finance-links';
import type {PendingJournal} from './api/ledger/_safety';

const input:React.CSSProperties={width:'100%',padding:'11px 12px',border:'1px solid #4b4d56',borderRadius:10,background:'#17191f',color:'#f5f5f7',font:'inherit'};
const field:React.CSSProperties={display:'grid',gap:6,minWidth:0};
type Props={journals:LedgerJournal[];locked:boolean;revision:number;onAuth:()=>void;onSubmit:(item:PendingJournal)=>void};
function euros(cents:number){return `${Math.floor(cents/100).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${String(cents%100).padStart(2,'0')} €`;}

/** A cross-reference does not establish a matching amount or post a transaction. */
export default function UgJournalFinanceLinks({journals,locked,revision,onAuth,onSubmit}:Props){
 const [journalId,setJournalId]=useState(''),[financeId,setFinanceId]=useState('');
 const [options,setOptions]=useState<FinanceEntry[]>([]),[nextBefore,setNextBefore]=useState<number|null>(null),[links,setLinks]=useState<LedgerFinanceLink[]>([]);
 const [busy,setBusy]=useState(false),[optionsReady,setOptionsReady]=useState(false),[linksLoading,setLinksLoading]=useState(false),[linksReady,setLinksReady]=useState(false);
 const [error,setError]=useState(''),[reason,setReason]=useState(''),[correcting,setCorrecting]=useState('');
 const selected=options.find(item=>item.id===financeId);
 const duplicate=!!selected&&links.some(link=>link.financeEntryId===selected.id&&!link.unlinkId);
 const loadOptions=useCallback(async(before:number|null=null)=>{
  setBusy(true);setError('');if(before===null){setOptionsReady(false);setOptions([]);}
  try{
   const response=await fetch(`/api/finance${before===null?'':`?before=${before}`}`,{cache:'no-store'});
   if(response.status===401||response.status===403){onAuth();throw new Error('Bitte erneut anmelden.');}
   const value=await response.json();if(!response.ok||!Array.isArray(value.entries)||(value.nextBefore!==null&&typeof value.nextBefore!=='number'))throw new Error('Finanzvorgänge konnten nicht geladen werden.');
   setOptions(previous=>before===null?value.entries:[...previous,...value.entries]);setNextBefore(value.nextBefore);setOptionsReady(true);
  }catch(e){setError(e instanceof Error?e.message:'Finanzvorgänge konnten nicht geladen werden.');}finally{setBusy(false);}
 },[onAuth]);
 useEffect(()=>{void loadOptions();},[loadOptions,revision]);
 useEffect(()=>{
  if(!journalId){setLinks([]);setLinksReady(false);setLinksLoading(false);return;}
  const controller=new AbortController();setError('');setLinks([]);setLinksReady(false);setLinksLoading(true);
  void (async()=>{try{
   const response=await fetch(`/api/ledger/journals/${encodeURIComponent(journalId)}/finance-links`,{cache:'no-store',signal:controller.signal});
   if(response.status===401||response.status===403){onAuth();throw new Error('Bitte erneut anmelden.');}
   const value=await response.json();if(!response.ok||!Array.isArray(value.links))throw new Error('Zuordnungen konnten nicht geladen werden.');
   if(!controller.signal.aborted){setLinks(value.links);setLinksReady(true);}
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Zuordnungen konnten nicht geladen werden.');}finally{if(!controller.signal.aborted)setLinksLoading(false);}})();
  return()=>controller.abort();
 },[journalId,revision,onAuth]);
 function attach(event:React.FormEvent){
  event.preventDefault();if(locked||busy||linksLoading||!optionsReady||!linksReady||duplicate||links.length>=500||!selected||!journalId)return;
  const last=links.find(link=>link.financeEntryId===selected.id);
  onSubmit({version:1,action:'finance-link',uncertain:false,body:{id:crypto.randomUUID(),journalId,financeEntryId:selected.id,expectedLinkId:last?.id??null,expectedUnlinkId:last?.unlinkId??null}});
 }
 function unlink(event:React.FormEvent,link:LedgerFinanceLink){
  event.preventDefault();const clean=reason.trim();if(locked||busy||!clean||clean.length>250||/[\u0000-\u001f\u007f]/.test(clean))return;
  onSubmit({version:1,action:'finance-unlink',uncertain:false,body:{id:crypto.randomUUID(),journalId,linkId:link.id,reason:clean}});setCorrecting('');setReason('');
 }
 return <section className="panel" style={{display:'grid',gap:14,marginBottom:24,maxWidth:960}} aria-label="Finanzvorgänge zuordnen">
  <div><p className="eyebrow">06 / FINANZEN</p><h2>Finanzvorgang zuordnen</h2></div>
  <p>Verknüpfe eine vorhandene Einnahme oder Ausgabe ausdrücklich mit einer bestehenden Journalbuchung. Die Verknüpfung erstellt und verändert keine Buchung, prüft keine Beträge und bewertet keine Steuern. Mehrere Zuordnungen sind möglich; prüfe Teilzahlungen und Stornos selbst.</p>
  <p>Auch eine Stornierung ist ein eigener Vorgang. Zuordnungen werden beim Stornieren nicht automatisch übertragen. Belege werden hier nicht zugeordnet.</p>
  {error&&<p role="alert" className="error">{error}</p>}
  <label style={field}>Journalbuchung<select style={input} value={journalId} onChange={e=>{setJournalId(e.target.value);setCorrecting('');setReason('');}}><option value="">Buchung auswählen</option>{journals.map(j=><option key={j.id} value={j.id}>{j.occurredOn} · {j.kind==='reversal'?'Storno · ':''}{j.description}{j.reversed?' · storniert':''} · {j.id}</option>)}</select></label>
  {!journals.length&&<p>Bitte zuerst eine Journalbuchung erfassen.</p>}
  <form onSubmit={attach} style={{display:'grid',gap:12}}>
   <label style={field}>Vorhandener Finanzvorgang<select style={input} disabled={locked||busy||!optionsReady} value={financeId} onChange={e=>setFinanceId(e.target.value)}><option value="">Vorgang auswählen</option>{options.map(item=><option key={item.id} value={item.id}>{item.occurredOn} · {item.kind==='reversal'?'Storno · ':''}{item.direction==='income'?'Einnahme':'Ausgabe'} · {item.description} · {euros(item.amountCents)}{item.reversed?' · storniert':''}</option>)}</select></label>
   {selected&&<p>Finanzvorgang: {selected.id} · {selected.kind==='reversal'?'Storno · ':''}{selected.direction==='income'?'Einnahme':'Ausgabe'} · {euros(selected.amountCents)}{selected.reversed?' · storniert':''}{selected.reversedEntryId&&<> · Storno von {selected.reversedEntryId}</>}</p>}
   {duplicate&&<p>Dieser Vorgang ist bereits aktiv zugeordnet.</p>}{links.length>=500&&<p>Für diese Buchung ist die Höchstzahl an Zuordnungsereignissen erreicht.</p>}
   <button type="submit" className="primary" disabled={locked||busy||linksLoading||!optionsReady||!linksReady||duplicate||links.length>=500||!journalId||!selected} style={{justifySelf:'start'}}>Vorgang dieser Buchung zuordnen</button>
  </form>
  {nextBefore!==null&&<button type="button" className="secondary-action" disabled={busy} onClick={()=>void loadOptions(nextBefore)}>Weitere Finanzvorgänge laden</button>}
  {optionsReady&&!options.length&&!busy&&<p>Noch keine Finanzvorgänge vorhanden.</p>}
  {journalId&&<div><h3>Zuordnungen und Korrekturen</h3>{linksLoading?<p>Zuordnungen werden geladen …</p>:!linksReady?<p>Zuordnungen konnten nicht geladen werden.</p>:!links.length?<p>Noch keine Finanzvorgänge zugeordnet.</p>:links.map(link=><article key={link.id} style={{borderTop:'1px solid #45474f',padding:'14px 0',display:'grid',gap:8}}><strong>{link.financeKind==='reversal'?'Storno · ':''}{link.financeDescription}</strong><p>{link.financeDate} · {link.financeDirection==='income'?'Einnahme':'Ausgabe'} · {euros(link.financeAmountCents)}{link.financeReversed?' · Finanzvorgang storniert':''} · ID {link.financeEntryId}<br/>{link.unlinkId?'Korrigiert':'Aktiv'} · zugeordnet am {link.createdAt}</p>{link.unlinkId&&<p>Korrektur am {link.unlinkedAt} · Grund: {link.unlinkReason}</p>}{!link.unlinkId&&(correcting===link.id?<form onSubmit={e=>unlink(e,link)} style={{display:'grid',gap:10,maxWidth:520}}><label style={field}>Grund der Korrektur<input style={input} maxLength={250} value={reason} disabled={locked} onChange={e=>setReason(e.target.value)} required/></label><div><button className="secondary-action" disabled={locked||busy||!reason.trim()} type="submit">Zuordnung mit Begründung korrigieren</button> <button className="secondary-action" type="button" disabled={locked} onClick={()=>{setCorrecting('');setReason('');}}>Abbrechen</button></div></form>:<button className="secondary-action" type="button" disabled={locked} style={{justifySelf:'start'}} onClick={()=>setCorrecting(link.id)}>Zuordnung korrigieren</button>)}</article>)}</div>}
 </section>;
}
