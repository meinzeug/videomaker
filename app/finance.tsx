'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {parseEuroCents,parseFinanceSettings,validFinanceDocumentName,MAX_FINANCE_DOCUMENT_BYTES,type FinanceEntry,type FinanceDirection,type FinanceDocument,type FinanceSettingsDraft,type FinanceSettingsEvent} from '@/lib/finance';
import type {Channel} from '@/lib/channels';
import {listFinanceOutbox,removeConfirmedFinanceOutbox,saveFinanceOutbox,subscribeFinanceOutbox,type FinanceOutboxItem} from '@/lib/finance-outbox';

type PendingEntry={action:'entry';id:string;direction:FinanceDirection;amountCents:number;occurredOn:string;description:string;counterparty:string;reference:string;channelId:string|null};
type PendingReversal={action:'reversal';id:string;entryId:string;reason:string};
type Pending=PendingEntry|PendingReversal;
const field:React.CSSProperties={display:'grid',gap:6};
const input:React.CSSProperties={width:'100%',padding:'11px 12px',border:'1px solid #444',borderRadius:8,background:'#171719',color:'#fff',font:'inherit'};
const section:React.CSSProperties={display:'grid',gap:14,marginBottom:24};
const labels:Record<string,string>={youtube:'YouTube',tiktok:'TikTok',instagram:'Instagram',facebook:'Facebook',other:'Andere'};
function localDate(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
const amount=(cents:number)=>new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(cents/100);
const date=(value:string)=>value.split('-').reverse().join('.');

class WriteFailure extends Error {
 constructor(message:string,readonly status:number|null,readonly definitive:boolean){super(message);}
}
/** A successful HTTP status alone does not prove that this particular write was saved. */
async function verifyWrite(response:Response,id:string,key:'entry'|'document'|'event',entryId?:string):Promise<void>{
 const data:unknown=await response.json().catch(()=>null);
 const body=data&&typeof data==='object'&&!Array.isArray(data)?data as Record<string,unknown>:null;
 if(!response.ok){
  const message=typeof body?.error==='string'?body.error:'Der Vorgang konnte nicht bestätigt werden.';
  const definitive=[400,404,409,413,415,422].includes(response.status)&&typeof body?.error==='string';
  throw new WriteFailure(message,response.status,definitive);
 }
 const result=body?.[key];
 const record=result&&typeof result==='object'&&!Array.isArray(result)?result as Record<string,unknown>:null;
 if(typeof body?.created!=='boolean'||record?.id!==id||(entryId!==undefined&&record.entryId!==entryId))
  throw new WriteFailure('Die Serverantwort bestätigt diesen Vorgang nicht.',response.status,false);
}
function writeFailure(error:unknown,wasUncertain:boolean):{message:string;discard:boolean;reauth:boolean}{
 if(error instanceof WriteFailure){
  if(error.definitive&&!wasUncertain)return {message:`Der Server hat den Vorgang abgelehnt. Er bleibt lokal erhalten: ${error.message}`,discard:false,reauth:false};
  if(error.status===401||error.status===403)return {message:'Die Anmeldung muss erneuert werden. Der Vorgang bleibt für denselben erneuten Versuch erhalten.',discard:false,reauth:true};
  return {message:`Speicherstatus unklar. Bitte denselben Vorgang erneut versuchen. ${error.message}`,discard:false,reauth:false};
 }
 return {message:'Speicherstatus unklar. Bitte denselben Vorgang erneut versuchen.',discard:false,reauth:false};
}

class OutboxError extends Error {}
async function executeFinanceOutbox(item:FinanceOutboxItem){
 try{await saveFinanceOutbox(item);}catch{throw new OutboxError('Der Vorgang konnte nicht sicher auf diesem Gerät gespeichert werden. Es wurde keine Anfrage gesendet. Bitte Speicherplatz und Browsereinstellungen prüfen.');}
 let response:Response;
 if(item.kind==='document')response=await fetch(`/api/finance/${encodeURIComponent(item.entryId)}/documents`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Finance-Document-Id':item.id,'X-Finance-Filename':encodeURIComponent(item.filename)},body:item.blob});
 else response=await fetch(item.kind==='settings'?'/api/finance/settings':'/api/finance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item.payload)});
 await verifyWrite(response,item.id,item.kind==='document'?'document':item.kind==='settings'?'event':'entry',item.kind==='document'?item.entryId:undefined);
 try{await removeConfirmedFinanceOutbox(item.id);}catch{throw new OutboxError('Der Server hat den Vorgang bestätigt, aber die lokale Warteschlange konnte nicht bereinigt werden. Ein erneuter Versuch verwendet dieselbe ID.');}
}
function FinanceOutbox({disabled,onGuardChange,onConfirmed}:{disabled:boolean;onGuardChange:(v:boolean)=>void;onConfirmed:()=>void}){
 const [items,setItems]=useState<FinanceOutboxItem[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(''),[needsLogin,setNeedsLogin]=useState(false);
 const inFlight=useRef(false),mounted=useRef(true);
 const load=useCallback(async()=>{try{const next=await listFinanceOutbox();if(mounted.current){setItems(next.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)));setError('');}}catch{if(mounted.current)setError('Die lokale Finanz-Warteschlange ist nicht lesbar. Bitte Browserspeicher prüfen.');}},[]);
 useEffect(()=>{mounted.current=true;void load();const unsubscribe=subscribeFinanceOutbox(()=>void load());return()=>{mounted.current=false;unsubscribe();};},[load]);
 async function retry(item:FinanceOutboxItem){
  if(inFlight.current)return;inFlight.current=true;onGuardChange(true);setBusy(item.id);setError('');
  try{await executeFinanceOutbox(item);if(mounted.current){setNeedsLogin(false);onConfirmed();await load();}}
  catch(e){if(mounted.current){const failure=writeFailure(e,true);setNeedsLogin(failure.reauth);setError(e instanceof OutboxError?e.message:failure.message);}}
  finally{inFlight.current=false;if(mounted.current){setBusy('');onGuardChange(false);}}
 }
 if(!items.length&&!error)return null;
 return <section className="panel" style={{...section,maxWidth:760}} aria-label="Offene Finanzvorgänge"><div><p className="eyebrow">WIEDERHERSTELLUNG</p><h2>Offene Finanzvorgänge</h2></div>
  <p>Diese Vorgänge liegen bis zur bestätigten Speicherung lokal in diesem Browserprofil. Browserdaten löschen, privates Surfen, Geräteverlust oder Speicherbereinigung können sie entfernen. Belege und Finanzdaten sind dort für Personen mit Zugriff auf dieses Profil lesbar. Sie werden nicht automatisch erneut gesendet.</p>
  {items.map(item=><div key={item.id} style={{borderTop:'1px solid #333',padding:'12px 0',display:'grid',gap:6}}><strong>{item.kind==='document'?`Beleg: ${item.filename}`:item.kind==='settings'?'UG-Rahmendaten':item.payload.action==='reversal'?'Stornierung':'Finanzeintrag'}</strong><small>Vorgangs-ID: {item.id} · lokal gesichert {new Date(item.createdAt).toLocaleString('de-DE')}</small><button type="button" className="secondary-action" disabled={disabled||!!busy||needsLogin} onClick={()=>void retry(item)}>{busy===item.id?'Prüft und speichert …':'Denselben Vorgang erneut versuchen'}</button></div>)}
  {needsLogin&&<FinanceReauthentication onSuccess={()=>{setNeedsLogin(false);setError('Anmeldung erneuert. Bitte Vorgang erneut versuchen.');}}/>}{error&&<p className="error" role="alert">{error}</p>}
 </section>;
}

/** Reauthenticate without unmounting the pending operation or its in-memory file. */
function FinanceReauthentication({onSuccess}:{onSuccess:()=>void}){
 const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy)return;const value=password;setPassword('');setBusy(true);setError('');
  try{
   const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:value})});
   const result=await response.json().catch(()=>null);
   if(!response.ok||result?.ok!==true)throw new Error(typeof result?.error==='string'?result.error:'Anmeldung konnte nicht bestätigt werden.');
   onSuccess();
  }catch(error){setError(error instanceof Error?error.message:'Anmeldung fehlgeschlagen.');}finally{setBusy(false);}
 }
 return <form onSubmit={submit} style={{display:'grid',gap:8,maxWidth:480}}>
  <p>Bitte erneut anmelden. Die offenen Daten bleiben für den gleichen Versuch erhalten.</p>
  <label style={field}>Studio-Passwort<input style={input} type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={event=>setPassword(event.target.value)}/></label>
  <button className="secondary-action" type="submit" disabled={busy||!password}>{busy?'Meldet an …':'Erneut anmelden'}</button>
  {error&&<p className="error" role="alert">{error}</p>}
 </form>;
}

export default function Finance({channels,onGuardChange}:{channels:Channel[];onGuardChange?:(guarded:boolean)=>void}) {
 const [direction,setDirection]=useState<FinanceDirection>('income');
 const [occurredOn,setOccurredOn]=useState(localDate);
 const [amountText,setAmountText]=useState('');
 const [description,setDescription]=useState('');
 const [counterparty,setCounterparty]=useState('');
 const [reference,setReference]=useState('');
 const [channelId,setChannelId]=useState('');
 const [entries,setEntries]=useState<FinanceEntry[]>([]);
 const [nextBefore,setNextBefore]=useState<number|null>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [listReady,setListReady]=useState(false),[listError,setListError]=useState('');
 const [pending,setPending]=useState<Pending|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const [reversing,setReversing]=useState(''),[reason,setReason]=useState('');
 const [documentEntryId,setDocumentEntryId]=useState('');
 const [documentGuard,setDocumentGuard]=useState(false),[settingsGuard,setSettingsGuard]=useState(false);
 const [needsLogin,setNeedsLogin]=useState(false);
 const inFlight=useRef(false);
 const uncertain=useRef(false);
 const mounted=useRef(true);
 const guards=useRef({entry:false,document:false,settings:false,outbox:false});
 const publishGuard=useCallback(()=>onGuardChange?.(guards.current.entry||guards.current.document||guards.current.settings||guards.current.outbox),[onGuardChange]);
 const updateOutboxGuard=useCallback((value:boolean)=>{guards.current.outbox=value;publishGuard();},[publishGuard]);
 const updateDocumentGuard=useCallback((value:boolean)=>{guards.current.document=value;setDocumentGuard(value);publishGuard();},[publishGuard]);
 const updateSettingsGuard=useCallback((value:boolean)=>{guards.current.settings=value;setSettingsGuard(value);publishGuard();},[publishGuard]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;onGuardChange?.(false);};},[onGuardChange]);
 const refresh=useCallback(async(before:number|null=null)=>{
  const suffix=before===null?'':`?before=${encodeURIComponent(before)}`;
  const response=await fetch(`/api/finance${suffix}`,{cache:'no-store'});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Einträge konnten nicht geladen werden.');
  if(!Array.isArray(data.entries))throw new Error('Ungültige Serverantwort.');
  if(mounted.current){setEntries(items=>before===null?data.entries:[...items,...data.entries]);setNextBefore(data.nextBefore);setListReady(true);setListError('');}
 },[]);
 useEffect(()=>{let active=true;setLoading(true);refresh().catch(e=>{if(active)setListError(e instanceof Error?e.message:'Einträge konnten nicht geladen werden.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[refresh]);
 useEffect(()=>{
  const guard=(event:BeforeUnloadEvent)=>{if(!guards.current.entry&&!guards.current.document&&!guards.current.settings&&!guards.current.outbox)return;event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
 },[]);
 async function send(item:Pending){
  if(inFlight.current)return;inFlight.current=true;guards.current.entry=true;publishGuard();setBusy(true);setError('');setNotice('');setPending(item);
  try{
   await executeFinanceOutbox({id:item.id,kind:'entry',createdAt:new Date().toISOString(),payload:{...item}});
   if(!mounted.current)return;
   uncertain.current=false;setNeedsLogin(false);setPending(null);
   if(item.action==='entry'){setAmountText('');setDescription('');setCounterparty('');setReference('');setNotice('Eintrag gespeichert.');}
   else {setReversing('');setReason('');setNotice('Stornierung gespeichert; der ursprüngliche Eintrag bleibt sichtbar.');}
   try{await refresh();}catch{setListError('Gespeichert, aber die Liste konnte nicht aktualisiert werden.');}
  }catch(e){if(mounted.current){const failure=writeFailure(e,uncertain.current);if(failure.discard){setPending(null);setNeedsLogin(false);}else{uncertain.current=true;if(failure.reauth)setNeedsLogin(true);}setError(e instanceof OutboxError?e.message:failure.message);}}
  finally{inFlight.current=false;if(mounted.current){setBusy(false);guards.current.entry=uncertain.current;publishGuard();}}
 }
 function submit(event:React.FormEvent){
  event.preventDefault();if(inFlight.current||pending)return;
  const cents=parseEuroCents(amountText);if(cents===null){setError('Bitte einen Betrag größer als null mit höchstens zwei Nachkommastellen eingeben.');return;}
  if(!description.trim()){setError('Bitte eine Beschreibung eingeben.');return;}
  uncertain.current=false;setNeedsLogin(false);
  void send({action:'entry',id:crypto.randomUUID(),direction,occurredOn,amountCents:cents,description,counterparty,reference,channelId:channelId||null});
 }
 function reverse(id:string){
  if(inFlight.current||pending)return;
  if(!reason.trim()){setError('Bitte einen Stornogrund eingeben.');return;}
  if(!window.confirm('Eintrag mit diesem Grund stornieren? Der ursprüngliche Eintrag bleibt erhalten.'))return;
  uncertain.current=false;setNeedsLogin(false);
  void send({action:'reversal',id:crypto.randomUUID(),entryId:id,reason});
 }
 async function more(){if(nextBefore===null||loading)return;setLoading(true);try{await refresh(nextBefore);}catch(e){setListError(e instanceof Error?e.message:'Weitere Einträge konnten nicht geladen werden.');}finally{if(mounted.current)setLoading(false);}}
 async function reload(){if(loading)return;setLoading(true);try{await refresh();}catch(e){setListError(e instanceof Error?e.message:'Einträge konnten nicht geladen werden.');}finally{if(mounted.current)setLoading(false);}}
 const locked=busy||pending!==null||documentGuard||settingsGuard||!listReady||!!listError;
 return <>
  <div className="section-heading large"><div><p className="eyebrow">FINANZEN / UG</p><h1>Einnahmen &amp; Ausgaben<span>.</span></h1><p>Vorläufige Erfassung deiner Agentur. Einträge bleiben nachvollziehbar und können mit Grund storniert werden.</p></div></div>
  <FinanceOutbox disabled={busy||!!pending||documentGuard||settingsGuard} onGuardChange={updateOutboxGuard} onConfirmed={()=>{void refresh().catch(()=>setListError('Die Liste konnte nicht aktualisiert werden.'));}}/>
  <FinanceSettings disabled={busy||!!pending||documentGuard} onGuardChange={updateSettingsGuard}/>
  <section className="panel" style={{...section,maxWidth:760}} aria-label="Finanzeintrag erfassen">
   <div><p className="eyebrow">NEUER EINTRAG</p><h2>Vorgang erfassen</h2></div>
   <p className="muted">Nur EUR, ohne Steueraufteilung. Originaldateien kannst du nach dem Speichern einem Vorgang zuordnen. Dieser Bereich ersetzt noch keine vollständige Buchhaltung oder revisionssichere Belegablage.</p>
   <form onSubmit={submit} style={{display:'grid',gap:14}}>
    <label style={field}>Art<select style={input} value={direction} disabled={locked} onChange={e=>setDirection(e.target.value as FinanceDirection)}><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select></label>
    <label style={field}>Datum<input style={input} type="date" required value={occurredOn} disabled={locked} onChange={e=>setOccurredOn(e.target.value)}/></label>
    <label style={field}>Betrag in EUR<input style={input} type="text" inputMode="decimal" required maxLength={12} value={amountText} placeholder="z. B. 120,50" disabled={locked} onChange={e=>setAmountText(e.target.value)}/></label>
    <label style={field}>Beschreibung<input style={input} required maxLength={250} value={description} disabled={locked} onChange={e=>setDescription(e.target.value)}/></label>
    <label style={field}>Gegenpartei (optional)<input style={input} maxLength={160} value={counterparty} disabled={locked} onChange={e=>setCounterparty(e.target.value)}/></label>
    <label style={field}>Belegnummer / Referenz (optional)<input style={input} maxLength={160} value={reference} disabled={locked} onChange={e=>setReference(e.target.value)}/></label>
    <label style={field}>Kanal (optional)<select style={input} value={channelId} disabled={locked} onChange={e=>setChannelId(e.target.value)}><option value="">Keinem Kanal zuordnen</option>{channels.map(channel=><option key={channel.id} value={channel.id}>{channel.name} · {labels[channel.platform]||channel.platform}</option>)}</select></label>
    <button className="primary" disabled={locked} type="submit" style={{justifySelf:'start'}}>{busy&&pending?.action==='entry'?'Speichert …':'Eintrag speichern'}</button>
   </form>
   {pending&&<div role="status"><p>Der letzte Speichervorgang ist noch nicht bestätigt. Die gleichen Daten werden beim erneuten Versuch nicht doppelt angelegt.</p>{needsLogin?<FinanceReauthentication onSuccess={()=>{setNeedsLogin(false);setError('Anmeldung erneuert. Bitte denselben Vorgang erneut versuchen.');}}/>:<button className="secondary-action" type="button" disabled={busy} onClick={()=>void send(pending)}>Denselben Vorgang erneut versuchen</button>}</div>}
   {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>
  <section className="panel" style={section} aria-label="Finanzeinträge">
   <div><p className="eyebrow">VERLAUF</p><h2>Erfasste Vorgänge</h2></div>
   {listError&&<div role="alert"><p>{listError}</p><button className="secondary-action" type="button" disabled={loading||documentGuard||settingsGuard||busy||!!pending} onClick={()=>void reload()}>Liste erneut laden</button></div>}
   {loading&&!entries.length?<p>Einträge werden geladen …</p>:!listReady?null:!entries.length?<p>Noch keine Vorgänge erfasst.</p>:entries.map(item=><article key={item.id} style={{borderTop:'1px solid #333',padding:'16px 0',display:'grid',gap:6}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}><strong>{item.kind==='reversal'?'Storno':item.direction==='income'?'Einnahme':'Ausgabe'} · {item.description}</strong><strong>{amount(item.amountCents)}</strong></div>
    <p className="muted">{date(item.occurredOn)}{item.counterparty?` · ${item.counterparty}`:''}{item.channelName?` · ${item.channelName} (${labels[item.channelPlatform||'']||item.channelPlatform})`:''}{item.reference?` · Belegreferenz ${item.reference}`:''}</p>
    <button className="secondary-action" type="button" disabled={locked} style={{justifySelf:'start'}} onClick={()=>setDocumentEntryId(current=>current===item.id?'':item.id)} aria-expanded={documentEntryId===item.id}>{documentEntryId===item.id?'Belege schließen':'Belege öffnen'}</button>
    {documentEntryId===item.id&&<FinanceDocuments key={item.id} entryId={item.id} disabled={busy||!!pending||settingsGuard||!listReady||!!listError} onGuardChange={updateDocumentGuard}/>}
    {item.kind==='reversal'?<p>Stornogrund: {item.reversalReason}</p>:item.reversed?<p>Storniert – ursprünglicher Eintrag bleibt erhalten.</p>:<>
     {reversing===item.id?<div style={{display:'grid',gap:8,maxWidth:520}}><label style={field}>Stornogrund<input style={input} required maxLength={250} value={reason} disabled={locked} onChange={e=>setReason(e.target.value)}/></label><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button className="secondary-action" type="button" disabled={locked} onClick={()=>reverse(item.id)}>Stornierung bestätigen</button><button className="secondary-action" type="button" disabled={locked} onClick={()=>{setReversing('');setReason('');}}>Abbrechen</button></div></div>:<button className="secondary-action" type="button" disabled={locked} style={{justifySelf:'start'}} onClick={()=>{setError('');setReversing(item.id);setReason('');}}>Stornieren</button>}
    </>}
   </article>)}
   {nextBefore!==null&&<button className="secondary-action" type="button" disabled={loading||documentGuard||settingsGuard||busy||!!pending} onClick={()=>void more()}>{loading?'Lädt …':'Weitere Einträge laden'}</button>}
  </section>
 </>;
}

type PendingDocument={id:string;file:File};
function FinanceDocuments({entryId,disabled,onGuardChange}:{entryId:string;disabled:boolean;onGuardChange:(guarded:boolean)=>void}){
 const [documents,setDocuments]=useState<FinanceDocument[]>([]),[ready,setReady]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [file,setFile]=useState<File|null>(null),[pending,setPending]=useState<PendingDocument|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [needsLogin,setNeedsLogin]=useState(false);
 const mounted=useRef(true),inFlight=useRef(false),uncertain=useRef(false),fileInput=useRef<HTMLInputElement>(null);
 const url=`/api/finance/${encodeURIComponent(entryId)}/documents`;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async()=>{
  const response=await fetch(url,{cache:'no-store'}),data=await response.json();
  if(!response.ok||!Array.isArray(data.documents))throw new Error(data.error||'Belege konnten nicht geladen werden.');
  if(mounted.current){setDocuments(data.documents);setReady(true);}
 },[url]);
 useEffect(()=>{let active=true;setLoading(true);load().catch(e=>{if(active)setError(e instanceof Error?e.message:'Belege konnten nicht geladen werden.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
 async function reload(){if(loading)return;setLoading(true);setError('');try{await load();}catch(e){setReady(false);setError(e instanceof Error?e.message:'Belege konnten nicht geladen werden.');}finally{if(mounted.current)setLoading(false);}}
 function choose(event:React.ChangeEvent<HTMLInputElement>){
  const item=event.target.files?.[0]||null;setError('');setNotice('');
  if(item&&(!validFinanceDocumentName(item.name)||item.size===0||item.size>MAX_FINANCE_DOCUMENT_BYTES)){setFile(null);event.target.value='';setError('Dateiname oder Dateigröße ist ungültig. Erlaubt sind Dateien bis 10 MiB.');return;}
  setFile(item);
 }
 async function send(item:PendingDocument){
  if(inFlight.current)return;inFlight.current=true;onGuardChange(true);setBusy(true);setPending(item);setError('');setNotice('');
  try{
   await executeFinanceOutbox({id:item.id,kind:'document',createdAt:new Date().toISOString(),entryId,filename:item.file.name,blob:item.file});
   if(!mounted.current)return;uncertain.current=false;setNeedsLogin(false);setPending(null);setFile(null);if(fileInput.current)fileInput.current.value='';setNotice('Originaldatei gespeichert.');
   try{await load();}catch{setReady(false);setError('Gespeichert, aber die Belegliste konnte nicht aktualisiert werden.');}
  }catch(e){if(mounted.current){const failure=writeFailure(e,uncertain.current);if(failure.discard){setPending(null);setNeedsLogin(false);}else{uncertain.current=true;if(failure.reauth)setNeedsLogin(true);}setError(e instanceof OutboxError?e.message:failure.message);}}
  finally{inFlight.current=false;if(mounted.current){setBusy(false);onGuardChange(uncertain.current);}}
 }
 return <div style={{display:'grid',gap:10,padding:'14px',background:'#1b1b1d',borderRadius:8}}>
  <strong>Belege zu diesem Vorgang</strong>
  <p className="muted">Originaldateien werden unverändert gespeichert und beim Download per SHA-256 geprüft. XML wird nicht ausgewertet. Maximal 10 MiB pro Datei, 50 Dateien je Vorgang und 512 MiB insgesamt. Eine revisionssichere Archivierung und Prüfung als E-Rechnung sind noch nicht vorhanden.</p>
  {loading&&!ready?<p>Belege werden geladen …</p>:ready&&documents.length===0?<p>Noch keine Dateien zugeordnet.</p>:null}
  {ready&&documents.map(doc=><div key={doc.id} style={{display:'grid',gap:4,padding:'8px 0',borderTop:'1px solid #353535',overflowWrap:'anywhere'}}>
   <strong>{doc.originalName}</strong><span className="muted">{(doc.size/1024/1024).toFixed(2)} MiB · gespeichert {new Date(doc.createdAt).toLocaleString('de-DE')}</span><small>SHA-256: <code>{doc.sha256}</code></small>
   <a className="secondary-action" style={{justifySelf:'start'}} href={`${url}/${encodeURIComponent(doc.id)}`}>Original herunterladen</a>
  </div>)}
  <label style={field}>Datei auswählen<input ref={fileInput} type="file" disabled={disabled||busy||!!pending||!ready} onChange={choose}/></label>
  <button className="secondary-action" type="button" style={{justifySelf:'start'}} disabled={disabled||busy||!!pending||!file||!ready} onClick={()=>{if(file){uncertain.current=false;setNeedsLogin(false);void send({id:crypto.randomUUID(),file});}}}>{busy?'Lädt hoch …':'Originaldatei speichern'}</button>
  {pending&&<div role="status"><p>Der letzte Upload ist noch nicht bestätigt. Ein erneuter Versuch verwendet dieselbe Beleg-ID.</p>{needsLogin?<FinanceReauthentication onSuccess={()=>{setNeedsLogin(false);setError('Anmeldung erneuert. Bitte denselben Upload erneut versuchen.');}}/>:<button className="secondary-action" type="button" disabled={disabled||busy} onClick={()=>void send(pending)}>Denselben Upload erneut versuchen</button>}</div>}
  {error&&<div role="alert"><p className="error">{error}</p>{!ready&&<button className="secondary-action" type="button" disabled={loading} onClick={()=>void reload()}>Belegliste erneut laden</button>}</div>}{notice&&<p role="status">{notice}</p>}
 </div>;
}

type PendingSettings=FinanceSettingsDraft;
function FinanceSettings({disabled,onGuardChange}:{disabled:boolean;onGuardChange:(guarded:boolean)=>void}){
 const [events,setEvents]=useState<FinanceSettingsEvent[]>([]),[nextBefore,setNextBefore]=useState<number|null>(null);
 const [ready,setReady]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[pending,setPending]=useState<PendingSettings|null>(null);
 const [taxRegime,setTaxRegime]=useState(''),[fiscalMode,setFiscalMode]=useState(''),[month,setMonth]=useState(''),[day,setDay]=useState(''),[effectiveOn,setEffectiveOn]=useState(''),[reason,setReason]=useState('');
 const [error,setError]=useState(''),[listError,setListError]=useState(''),[notice,setNotice]=useState('');
 const [needsLogin,setNeedsLogin]=useState(false);
 const mounted=useRef(true),inFlight=useRef(false),uncertain=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async(before:number|null=null)=>{
  const response=await fetch(`/api/finance/settings${before===null?'':`?before=${before}`}`,{cache:'no-store'}),data=await response.json();
  if(!response.ok||!Array.isArray(data.events))throw new Error(data.error||'Konfiguration konnte nicht geladen werden.');
  if(mounted.current){setEvents(items=>before===null?data.events:[...items,...data.events]);setNextBefore(data.nextBefore);setReady(true);setListError('');}
 },[]);
 useEffect(()=>{let active=true;setLoading(true);load().catch(e=>{if(active)setListError(e instanceof Error?e.message:'Konfiguration konnte nicht geladen werden.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
 async function reload(before:number|null=null){if(loading)return;setLoading(true);try{await load(before);}catch(e){setListError(e instanceof Error?e.message:'Konfiguration konnte nicht geladen werden.');}finally{if(mounted.current)setLoading(false);}}
 async function send(item:PendingSettings){
  if(inFlight.current)return;inFlight.current=true;onGuardChange(true);setBusy(true);setPending(item);setError('');setNotice('');
  try{
   await executeFinanceOutbox({id:item.id,kind:'settings',createdAt:new Date().toISOString(),payload:item});
   if(!mounted.current)return;uncertain.current=false;setNeedsLogin(false);setPending(null);setReason('');setNotice('Angabe gespeichert. Bereits vorhandene Vorgänge wurden nicht geändert.');
   try{await load();}catch{setListError('Gespeichert, aber der Verlauf konnte nicht aktualisiert werden.');}
  }catch(e){if(mounted.current){const failure=writeFailure(e,uncertain.current);if(failure.discard){setPending(null);setNeedsLogin(false);}else{uncertain.current=true;if(failure.reauth)setNeedsLogin(true);}setError(e instanceof OutboxError?e.message:failure.message);}}
  finally{inFlight.current=false;if(mounted.current){setBusy(false);onGuardChange(uncertain.current);}}
 }
 function submit(event:React.FormEvent){
  event.preventDefault();if(inFlight.current||pending)return;setError('');
  try{const item=parseFinanceSettings({id:crypto.randomUUID(),effectiveOn,taxRegime,fiscalMode,fiscalStartMonth:fiscalMode==='calendar'?1:Number(month),fiscalStartDay:fiscalMode==='calendar'?1:Number(day),reason});uncertain.current=false;setNeedsLogin(false);void send(item);}catch(e){setError(e instanceof Error?e.message:'Ungültige Angabe.');}
 }
 const locked=disabled||busy||!!pending||!ready||!!listError;
 return <section className="panel" style={{...section,maxWidth:760}} aria-label="UG-Rahmendaten">
  <details><summary style={{cursor:'pointer',fontSize:20,fontWeight:700}}>UG-Rahmendaten &amp; Verlauf</summary>
   <p className="muted" style={{margin:'12px 0'}}>Umsatzsteuer-Regelung und Geschäftsjahr werden nur als deine Angaben historisiert. Es erfolgen keine Steuerberechnung, Fristberechnung oder automatische Buchung. Die steuerliche Gültigkeit muss separat geprüft werden.</p>
   <form onSubmit={submit} style={{display:'grid',gap:12}}>
    <label style={field}>Gültig ab<input style={input} type="date" value={effectiveOn} required disabled={locked} onChange={e=>setEffectiveOn(e.target.value)}/></label>
    <label style={field}>Umsatzsteuer-Regelung<select style={input} value={taxRegime} required disabled={locked} onChange={e=>setTaxRegime(e.target.value)}><option value="">Bitte auswählen</option><option value="regular">Regelbesteuerung</option><option value="small_business">Kleinunternehmerregelung</option></select></label>
    <label style={field}>Geschäftsjahr<select style={input} value={fiscalMode} required disabled={locked} onChange={e=>{setFiscalMode(e.target.value);setMonth('');setDay('');}}><option value="">Bitte auswählen</option><option value="calendar">Kalenderjahr</option><option value="different">Abweichendes Geschäftsjahr</option></select></label>
    {fiscalMode==='different'&&<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:10}}><label style={field}>Beginn: Tag<select style={input} value={day} required disabled={locked} onChange={e=>setDay(e.target.value)}><option value="">Tag</option>{Array.from({length:31},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select></label><label style={field}>Beginn: Monat<select style={input} value={month} required disabled={locked} onChange={e=>setMonth(e.target.value)}><option value="">Monat</option>{Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>{new Intl.DateTimeFormat('de-DE',{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2025,i,1)))}</option>)}</select></label></div>}
    <label style={field}>Begründung<input style={input} maxLength={250} required disabled={locked} value={reason} onChange={e=>setReason(e.target.value)} placeholder="z. B. Ersteinrichtung"/></label>
    <button className="secondary-action" type="submit" disabled={locked} style={{justifySelf:'start'}}>{busy?'Speichert …':'Angabe mit Verlauf speichern'}</button>
   </form>
   {pending&&<div role="status"><p>Der letzte Speichervorgang ist noch nicht bestätigt. Ein erneuter Versuch verwendet dieselbe ID.</p>{needsLogin?<FinanceReauthentication onSuccess={()=>{setNeedsLogin(false);setError('Anmeldung erneuert. Bitte denselben Vorgang erneut versuchen.');}}/>:<button className="secondary-action" type="button" disabled={disabled||busy} onClick={()=>void send(pending)}>Denselben Vorgang erneut versuchen</button>}</div>}
   {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   <h3 style={{marginTop:20}}>Verlauf der Angaben</h3>
   {listError&&<div role="alert"><p>{listError}</p><button className="secondary-action" type="button" disabled={loading} onClick={()=>void reload()}>Verlauf erneut laden</button></div>}
   {loading&&!ready?<p>Lädt …</p>:!ready?null:events.length===0?<p>Noch keine Rahmendaten angegeben.</p>:events.map(item=><div key={item.id} style={{borderTop:'1px solid #333',padding:'12px 0',overflowWrap:'anywhere'}}><strong>Ab {date(item.effectiveOn)} · {item.taxRegime==='regular'?'Regelbesteuerung':'Kleinunternehmerregelung'}</strong><p>{item.fiscalMode==='calendar'?'Kalenderjahr':`Abweichendes Geschäftsjahr ab ${String(item.fiscalStartDay).padStart(2,'0')}.${String(item.fiscalStartMonth).padStart(2,'0')}.`}</p><p className="muted">{item.reason} · erfasst {new Date(item.createdAt).toLocaleString('de-DE')}</p></div>)}
   {nextBefore!==null&&<button className="secondary-action" type="button" disabled={loading} onClick={()=>void reload(nextBefore)}>Weitere Angaben laden</button>}
  </details>
 </section>;
}
