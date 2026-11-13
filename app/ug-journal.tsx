'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {parseEuroCents} from '@/lib/finance';
import {parseLedgerEntry,type AccountBalance,type AccountKind,type LedgerAccount,type LedgerJournal,type LedgerLine} from '@/lib/ug-ledger';
import {journalResponseDecision,parsePendingJournal,type PendingJournal} from './api/ledger/_safety';
import {JournalOutboxConflict,loadJournalOutbox,removeConfirmedJournalOutbox,saveJournalOutbox,subscribeJournalOutbox} from '@/lib/ug-journal-outbox';

const storageKey='videomaker-ug-journal-pending-v1';
const field:React.CSSProperties={display:'grid',gap:6,minWidth:0};
const input:React.CSSProperties={width:'100%',padding:'11px 12px',border:'1px solid #4b4d56',borderRadius:10,background:'#17191f',color:'#f5f5f7',font:'inherit'};
const layout:React.CSSProperties={display:'grid',gap:14,marginBottom:24};
const categories:Record<AccountKind,string>={asset:'Aktivkonto',liability:'Passivkonto',equity:'Eigenkapital',income:'Ertrag',expense:'Aufwand'};
type LineDraft={key:string;accountId:string;side:'debit'|'credit';amount:string};
const initialLines=():LineDraft[]=>[{key:'first',accountId:'',side:'debit',amount:''},{key:'second',accountId:'',side:'credit',amount:''}];
function today(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const value=(name:string)=>parts.find(part=>part.type===name)?.value||'';return `${value('year')}-${value('month')}-${value('day')}`;}
function euros(cents:string|bigint){
 try{let value=typeof cents==='bigint'?cents:BigInt(cents);const minus=value<0n;if(minus)value=-value;const whole=(value/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.');return `${minus?'−':''}${whole},${(value%100n).toString().padStart(2,'0')} €`;}catch{return '–';}
}
async function jsonResponse(response:Response):Promise<unknown>{try{return await response.json();}catch{return null;}}
function errorText(value:unknown,fallback:string){return value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as {error?:unknown}).error==='string'?(value as {error:string}).error:fallback;}
function endpoint(item:PendingJournal){return item.action==='account'?'/api/ledger/accounts':item.action==='entry'?'/api/ledger/journals':`/api/ledger/journals/${encodeURIComponent(String(item.body.entryId))}/reverse`;}

/** Explicitly preliminary, independently stored journal. No tax or closing calculations. */
export default function UgJournal({onGuardChange}:{onGuardChange?:(guarded:boolean)=>void}) {
 const [accounts,setAccounts]=useState<LedgerAccount[]>([]),[journals,setJournals]=useState<LedgerJournal[]>([]),[balances,setBalances]=useState<AccountBalance[]>([]);
 const [nextBefore,setNextBefore]=useState<number|null>(null),[loading,setLoading]=useState(false),[dataReady,setDataReady]=useState(false);
 const [pending,setPending]=useState<PendingJournal|null>(null),[restored,setRestored]=useState(false),[corrupt,setCorrupt]=useState(false),[storageUnavailable,setStorageUnavailable]=useState(false),[working,setWorking]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[showLogin,setShowLogin]=useState(false),[password,setPassword]=useState('');
 const [code,setCode]=useState(''),[accountName,setAccountName]=useState(''),[accountKind,setAccountKind]=useState<AccountKind>('asset');
 const [occurredOn,setOccurredOn]=useState(''),[description,setDescription]=useState(''),[lines,setLines]=useState<LineDraft[]>(initialLines);
 const [reversing,setReversing]=useState(''),[reversalDate,setReversalDate]=useState(''),[reason,setReason]=useState('');
 const inFlight=useRef(false),pendingRef=useRef<PendingJournal|null>(null),mounted=useRef(true);
 function assignPending(value:PendingJournal|null){pendingRef.current=value;setPending(value);}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{
  let active=true,revision=0;
  const refresh=async()=>{const ticket=++revision;try{
   const item=await loadJournalOutbox();if(!active||ticket!==revision)return;
   assignPending(item);setStorageUnavailable(false);
   if(item)setNotice('Ein unbestätigter Vorgang wurde wiederhergestellt. Bitte denselben Vorgang erneut prüfen und senden.');
   else setNotice(previous=>previous==='Ein unbestätigter Vorgang wurde wiederhergestellt. Bitte denselben Vorgang erneut prüfen und senden.'?'':previous);
  }catch{if(active&&ticket===revision){setStorageUnavailable(true);setError('Der lokale Journal-Speicher ist nicht verfügbar oder beschädigt. Es werden keine neuen Buchungen gesendet.');}}};
  const unsubscribe=subscribeJournalOutbox(()=>void refresh());
  void (async()=>{try{
   // Migrate any operation saved by an older version before discarding its tab-local copy.
   const raw=sessionStorage.getItem(storageKey);
   if(raw){const legacy={...parsePendingJournal(raw),uncertain:true};await saveJournalOutbox(legacy);sessionStorage.removeItem(storageKey);}
   await refresh();
  }catch(error){if(active){setCorrupt(true);setError(error instanceof JournalOutboxConflict?'Ein älterer Vorgang dieses Tabs und ein anderer offener Vorgang müssen getrennt geprüft werden. Es werden keine neuen Buchungen gesendet.':'Ein älterer Zwischenstand konnte nicht sicher übernommen werden. Es werden keine neuen Buchungen gesendet.');}}
  finally{if(active){setOccurredOn(today());setReversalDate(today());setRestored(true);}}})();
  return()=>{active=false;unsubscribe();};
 },[]);
 const guarded=!restored||!!pending||corrupt||working;
 useEffect(()=>{onGuardChange?.(guarded);},[guarded,onGuardChange]);
 useEffect(()=>()=>{onGuardChange?.(false);},[onGuardChange]);
 useEffect(()=>{
  if(!pending&&!corrupt&&!working)return;
  const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);
 },[pending,corrupt,working]);
 const reload=useCallback(async()=>{
  if(mounted.current){setLoading(true);setError('');}
  try{
   const responses=await Promise.all(['/api/ledger/accounts','/api/ledger/balances','/api/ledger/journals'].map(url=>fetch(url,{cache:'no-store'})));
   if(responses.some(response=>response.status===401||response.status===403)){if(mounted.current)setShowLogin(true);throw new Error('Die Sitzung ist abgelaufen. Bitte erneut anmelden.');}
   const data=await Promise.all(responses.map(jsonResponse));
   if(responses.some(response=>!response.ok))throw new Error('Konten und Journal konnten nicht geladen werden.');
   const [a,b,j]=data as [{accounts?:unknown},{balances?:unknown},{journals?:unknown;nextBefore?:unknown}];
   if(!a||!b||!j||!Array.isArray(a.accounts)||!Array.isArray(b.balances)||!Array.isArray(j.journals)||(j.nextBefore!==null&&typeof j.nextBefore!=='number'))throw new Error('Ungültige Serverantwort.');
   if(mounted.current){setAccounts(a.accounts as LedgerAccount[]);setBalances(b.balances as AccountBalance[]);setJournals(j.journals as LedgerJournal[]);setNextBefore(j.nextBefore as number|null);setDataReady(true);}
  }catch(e){if(mounted.current){setDataReady(false);setError(e instanceof Error?e.message:'Journal konnte nicht geladen werden.');}}
  finally{if(mounted.current)setLoading(false);}
 },[]);
 useEffect(()=>{void reload();},[reload]);
 const totals=useMemo(()=>{
  let debit=0n,credit=0n;let valid=true;
  for(const line of lines){const cents=parseEuroCents(line.amount);if(cents===null||!accounts.some(account=>account.id===line.accountId)){valid=false;continue;}if(line.side==='debit')debit+=BigInt(cents);else credit+=BigInt(cents);}
  return {debit,credit,valid:valid&&new Set(lines.map(line=>line.accountId)).size>=2&&debit>0n&&debit===credit};
 },[lines,accounts]);
 const locked=!restored||storageUnavailable||corrupt||!!pending||working||!dataReady||loading;
 async function send(item:PendingJournal){
  if(inFlight.current||corrupt||storageUnavailable)return;
  const dispatched={...item,uncertain:true};
  // Set the in-memory guard synchronously and commit the durable outbox before POST.
  inFlight.current=true;setWorking(true);onGuardChange?.(true);setError('');setNotice('');
  try{
   try{await saveJournalOutbox(dispatched);}catch(error){
    if(error instanceof JournalOutboxConflict){const current=await loadJournalOutbox();if(mounted.current){assignPending(current);setError('Ein anderer Vorgang ist noch offen. Bitte zuerst diesen prüfen.');}}
    else if(mounted.current){setStorageUnavailable(true);setError('Der Vorgang wurde nicht gesendet: Der lokale Journal-Speicher ist nicht verfügbar.');}
    return;
   }
   if(!mounted.current)return;
   assignPending(dispatched);
   const response=await fetch(endpoint(dispatched),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(dispatched.body)});
   const data=await jsonResponse(response),decision=journalResponseDecision(dispatched,response.status,data);
   if(!mounted.current)return;
   if(decision==='confirmed'){
    try{
     // Another tab may already have confirmed this operation and started another one.
     await removeConfirmedJournalOutbox(dispatched);
     const current=await loadJournalOutbox();if(!mounted.current)return;assignPending(current);
     if(item.action==='account'){setCode('');setAccountName('');}
     if(item.action==='entry'){setDescription('');setLines(initialLines());}
     if(item.action==='reversal'){setReversing('');setReason('');}
     setShowLogin(false);setNotice(item.action==='account'?'Konto gespeichert.':item.action==='entry'?'Buchung gespeichert.':'Storno gespeichert; die ursprüngliche Buchung bleibt erhalten.');
     await reload();
    }catch{if(mounted.current)setError('Die Antwort wurde empfangen, aber der lokale Vorgang konnte nicht sicher abgeschlossen werden. Bitte denselben Vorgang erneut prüfen.');}
   }else if(decision==='reauth'){
    setShowLogin(true);setError('Anmeldung oder Anfrage wurde abgelehnt. Der Vorgang bleibt mit derselben ID erhalten.');
   }else{
    setError(errorText(data,'Der Speicherstatus ist nicht bestätigt. Bitte denselben Vorgang erneut senden; keine neue Buchung anlegen.'));
   }
  }catch{
   if(mounted.current)setError('Die Verbindung wurde unterbrochen. Der Speicherstatus ist unklar; bitte denselben Vorgang erneut senden.');
  }finally{inFlight.current=false;if(mounted.current)setWorking(false);}
 }
 async function login(event:React.FormEvent){
  event.preventDefault();if(inFlight.current||!password)return;
  const entered=password;setPassword('');inFlight.current=true;setWorking(true);setError('');let success=false;
  try{
   const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:entered})});
   const data=await jsonResponse(response);if(!response.ok)throw new Error(errorText(data,'Anmeldung fehlgeschlagen.'));
   success=true;if(mounted.current){setShowLogin(false);setNotice('Sitzung erneuert.');}
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Anmeldung fehlgeschlagen.');}
  finally{inFlight.current=false;if(mounted.current)setWorking(false);}
  if(success&&mounted.current){const saved=pendingRef.current;if(saved)await send(saved);else await reload();}
 }
 function submitAccount(event:React.FormEvent){
  event.preventDefault();if(locked||inFlight.current)return;
  const normalizedCode=code.trim().toUpperCase(),name=accountName.trim();
  if(!/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(normalizedCode)||!name||name.length>160||/[\u0000-\u001f\u007f]/.test(name)){setError('Bitte eine gültige Kontonummer und einen Kontonamen eingeben.');return;}
  if(accounts.some(account=>account.code.toUpperCase()===normalizedCode)){setError('Diese Kontonummer existiert bereits.');return;}
  void send({version:1,action:'account',body:{id:crypto.randomUUID(),code:normalizedCode,name,kind:accountKind},uncertain:false});
 }
 function submitJournal(event:React.FormEvent){
  event.preventDefault();if(locked||inFlight.current)return;
  try{
   const parsedLines:LedgerLine[]=lines.map(line=>{const cents=parseEuroCents(line.amount);if(cents===null)throw new Error('Bitte alle Beträge in Euro mit höchstens zwei Nachkommastellen eingeben.');return {accountId:line.accountId,side:line.side,amountCents:cents};});
   const body=parseLedgerEntry({id:crypto.randomUUID(),occurredOn,description,lines:parsedLines});
   void send({version:1,action:'entry',body,uncertain:false});
  }catch(e){setError(e instanceof Error?e.message:'Ungültige Buchung.');}
 }
 function submitReversal(event:React.FormEvent){
  event.preventDefault();if(locked||inFlight.current)return;
  const normalized=reason.trim();if(!normalized||normalized.length>250||/[\u0000-\u001f\u007f]/.test(normalized)){setError('Bitte einen gültigen Stornogrund eingeben.');return;}
  if(!window.confirm('Diese Buchung stornieren? Das Original bleibt sichtbar und das Storno wird unwiderruflich ergänzt.'))return;
  void send({version:1,action:'reversal',body:{id:crypto.randomUUID(),entryId:reversing,occurredOn:reversalDate,reason:normalized},uncertain:false});
 }
 function updateLine(key:string,patch:Partial<LineDraft>){setLines(items=>items.map(line=>line.key===key?{...line,...patch}:line));}
 async function more(){
  if(loading||nextBefore===null)return;setLoading(true);setError('');
  try{const response=await fetch(`/api/ledger/journals?before=${encodeURIComponent(nextBefore)}`,{cache:'no-store'});const data=await jsonResponse(response) as {journals?:unknown;nextBefore?:unknown}|null;if(response.status===401||response.status===403){setShowLogin(true);throw new Error('Die Sitzung ist abgelaufen. Bitte erneut anmelden.');}if(!response.ok||!data||!Array.isArray(data.journals)||(data.nextBefore!==null&&typeof data.nextBefore!=='number'))throw new Error('Weitere Buchungen konnten nicht geladen werden.');setJournals(items=>[...items,...data.journals as LedgerJournal[]]);setNextBefore(data.nextBefore as number|null);}
  catch(e){setError(e instanceof Error?e.message:'Weitere Buchungen konnten nicht geladen werden.');}finally{setLoading(false);}
 }
 return <div className="ug-journal">
  <div className="section-heading large"><div><p className="eyebrow">UG / JOURNAL</p><h1>Soll &amp; Haben<span>.</span></h1><p>Manuelle, ausgeglichene Buchungen mit eigenem Kontenplan und nachvollziehbarem Storno.</p></div></div>
  <section className="panel" style={{...layout,maxWidth:960}} aria-label="Journalhinweise"><h2>Vorläufiges Journal</h2><p>Dieses Journal ist getrennt von der Einnahmen- und Ausgabenübersicht. Es berechnet keine Steuern, keinen UG-Abschluss und keine Rücklage. Belegbindung, Periodenabschluss, Exporte und ein GoBD-Nachweis fehlen noch.</p><p>Einträge und Konten können nicht überschrieben oder gelöscht werden. Korrekturen erfolgen durch eine zusätzliche Stornobuchung.</p></section>
  {(pending||corrupt||storageUnavailable)&&<section className="panel" style={{...layout,maxWidth:960}} aria-label="Unbestätigter Vorgang"><h2>Speicherstatus</h2>{pending?<><p>Ein Vorgang ist noch nicht bestätigt. Seine ID und Daten bleiben lokal in diesem Browserprofil erhalten, auch nach dem Schließen des Tabs; ein erneuter Versuch verwendet dieselbe ID. Browserdaten dürfen dafür nicht gelöscht werden.</p><p>Vorgang: {pending.action==='account'?'Konto anlegen':pending.action==='entry'?'Buchung erfassen':'Buchung stornieren'} · ID {String(pending.body.id)}</p><button className="secondary-action" type="button" disabled={working} onClick={()=>void send(pending)}>Denselben Vorgang erneut senden</button></>:<p>Der lokale Speicher kann nicht sicher verarbeitet werden. Neue Vorgänge bleiben gesperrt, bis er wieder verfügbar ist.</p>}</section>}
  {showLogin&&<section className="panel" style={{...layout,maxWidth:640}}><h2>Erneut anmelden</h2><p>Ein offener Vorgang bleibt dabei erhalten und wird nach erfolgreicher Anmeldung mit derselben ID erneut gesendet.</p><form onSubmit={login} style={{display:'grid',gap:12}}><label style={field}>Studio-Passwort<input style={input} type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={working} required/></label><button className="primary" type="submit" disabled={working||!password}>{pending?'Anmelden und erneut senden':'Anmelden'}</button></form></section>}
  {error&&<p role="alert" className="error" style={{marginBottom:16}}>{error}</p>}{notice&&<p role="status" style={{marginBottom:16}}>{notice}</p>}
  <button className="secondary-action" type="button" disabled={loading||working} onClick={()=>void reload()}>{loading?'Lädt …':'Konten und Journal aktualisieren'}</button>
  <section className="panel" style={{...layout,marginTop:24,maxWidth:960}} aria-label="Kontenplan"><div><p className="eyebrow">01 / KONTENPLAN</p><h2>Konto anlegen</h2></div><form onSubmit={submitAccount} style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,180px),1fr))',gap:12}}><label style={field}>Kontonummer<input style={input} required maxLength={30} value={code} disabled={locked} onChange={e=>setCode(e.target.value)} placeholder="z. B. 1200"/></label><label style={field}>Kontoname<input style={input} required maxLength={160} value={accountName} disabled={locked} onChange={e=>setAccountName(e.target.value)} placeholder="z. B. Bank"/></label><label style={field}>Kontoart<select style={input} value={accountKind} disabled={locked} onChange={e=>setAccountKind(e.target.value as AccountKind)}>{Object.entries(categories).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className="primary" disabled={locked} type="submit" style={{alignSelf:'end'}}>{working?'Wird geprüft …':'Konto speichern'}</button></form>{!accounts.length&&dataReady&&<p>Noch keine Konten angelegt.</p>}</section>
  <section className="panel" style={{...layout,maxWidth:960}} aria-label="Buchung erfassen"><div><p className="eyebrow">02 / BUCHUNG</p><h2>Vorgang buchen</h2></div><p>Mindestens zwei verschiedene Konten; Soll und Haben müssen centgenau übereinstimmen.</p><form onSubmit={submitJournal} style={{display:'grid',gap:14}}><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,210px),1fr))',gap:12}}><label style={field}>Buchungsdatum<input style={input} type="date" required value={occurredOn} disabled={locked} onChange={e=>setOccurredOn(e.target.value)}/></label><label style={field}>Beschreibung<input style={input} required maxLength={250} value={description} disabled={locked} onChange={e=>setDescription(e.target.value)}/></label></div>{lines.map((line,index)=><fieldset key={line.key} style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,160px),1fr))',gap:10,border:'1px solid #45474f',borderRadius:12,padding:12}}><legend>Zeile {index+1}</legend><label style={field}>Konto<select style={input} value={line.accountId} disabled={locked} required onChange={e=>updateLine(line.key,{accountId:e.target.value})}><option value="">Konto auswählen</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label><label style={field}>Seite<select style={input} value={line.side} disabled={locked} onChange={e=>updateLine(line.key,{side:e.target.value as 'debit'|'credit'})}><option value="debit">Soll</option><option value="credit">Haben</option></select></label><label style={field}>Betrag in EUR<input style={input} inputMode="decimal" required maxLength={12} value={line.amount} disabled={locked} placeholder="z. B. 120,50" onChange={e=>updateLine(line.key,{amount:e.target.value})}/></label>{lines.length>2&&<button className="secondary-action" type="button" disabled={locked} style={{alignSelf:'end'}} onClick={()=>setLines(items=>items.filter(item=>item.key!==line.key))}>Zeile entfernen</button>}</fieldset>)}<button className="secondary-action" type="button" disabled={locked||lines.length>=128} onClick={()=>setLines(items=>[...items,{key:crypto.randomUUID(),accountId:'',side:'debit',amount:''}])} style={{justifySelf:'start'}}>Zeile hinzufügen</button><p aria-live="polite">Soll: <strong>{euros(totals.debit)}</strong> · Haben: <strong>{euros(totals.credit)}</strong> · {totals.valid?'Ausgeglichen':'Noch nicht ausgeglichen'}</p><button className="primary" type="submit" disabled={locked||!totals.valid||!description.trim()||!occurredOn} style={{justifySelf:'start'}}>Buchung speichern</button></form></section>
  <section className="panel" style={{...layout,maxWidth:960}} aria-label="Kontensalden"><div><p className="eyebrow">03 / SALDEN</p><h2>Kontenübersicht</h2></div>{!balances.length?<p>Noch keine Salden vorhanden.</p>:<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',textAlign:'left'}}><thead><tr><th>Konto</th><th>Soll gesamt</th><th>Haben gesamt</th><th>Saldo Soll − Haben</th></tr></thead><tbody>{balances.map(balance=><tr key={balance.account.id}><td>{balance.account.code} · {balance.account.name}</td><td>{euros(balance.debitCents)}</td><td>{euros(balance.creditCents)}</td><td>{euros(balance.netDebitCents)}</td></tr>)}</tbody></table></div>}<p>Der angezeigte Saldo ist rechnerisch Soll minus Haben; daraus folgt noch keine steuerliche Einordnung.</p></section>
  <section className="panel" style={{...layout,maxWidth:960}} aria-label="Buchungsjournal"><div><p className="eyebrow">04 / JOURNAL</p><h2>Buchungen</h2></div>{!journals.length&&dataReady?<p>Noch keine Buchungen.</p>:journals.map(journal=><article key={journal.id} style={{borderTop:'1px solid #45474f',padding:'16px 0',display:'grid',gap:8}}><div><strong>{journal.kind==='reversal'?'Storno · ':''}{journal.description}</strong><p>{journal.occurredOn} · ID {journal.id}{journal.reversed?' · storniert':''}</p>{journal.reversalReason&&<p>Stornogrund: {journal.reversalReason}</p>}</div><ul>{journal.lines.map((line,index)=>{const account=accounts.find(a=>a.id===line.accountId);return <li key={index}>{line.side==='debit'?'Soll':'Haben'} · {account?`${account.code} ${account.name}`:line.accountId} · {euros(BigInt(line.amountCents))}</li>;})}</ul>{journal.kind==='entry'&&!journal.reversed&&(reversing===journal.id?<form onSubmit={submitReversal} style={{display:'grid',gap:10,maxWidth:520}}><label style={field}>Stornodatum<input style={input} type="date" required value={reversalDate} disabled={locked} onChange={e=>setReversalDate(e.target.value)}/></label><label style={field}>Stornogrund<input style={input} required maxLength={250} value={reason} disabled={locked} onChange={e=>setReason(e.target.value)}/></label><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button className="secondary-action" disabled={locked} type="submit">Storno bestätigen</button><button className="secondary-action" disabled={locked} type="button" onClick={()=>{setReversing('');setReason('');}}>Abbrechen</button></div></form>:<button className="secondary-action" type="button" disabled={locked} style={{justifySelf:'start'}} onClick={()=>{setReversing(journal.id);setReason('');}}>Stornieren</button>)}</article>)}{nextBefore!==null&&<button className="secondary-action" type="button" disabled={loading||working} onClick={()=>void more()}>{loading?'Lädt …':'Weitere Buchungen laden'}</button>}</section>
 </div>;
}
