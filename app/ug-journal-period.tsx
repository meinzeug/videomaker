'use client';
import {useEffect,useRef,useState} from 'react';
import type {LedgerPeriodSummary} from '@/lib/ug-ledger-period';

const field:React.CSSProperties={display:'grid',gap:6,minWidth:0};
const input:React.CSSProperties={width:'100%',padding:'11px 12px',border:'1px solid #4b4d56',borderRadius:10,background:'#17191f',color:'#f5f5f7',font:'inherit'};
const euro=(text:string)=>{let value=BigInt(text),negative=value<0n;if(negative)value=-value;return `${negative?'−':''}${(value/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${(value%100n).toString().padStart(2,'0')} €`;};
type Report=LedgerPeriodSummary&{generatedAt:string};
type Props={locked:boolean;revision:number;onAuth:()=>void};

/** Arithmetic of posted rows only; the user selects the date interval. */
export default function UgJournalPeriod({locked,revision,onAuth}:Props){
 const [from,setFrom]=useState(''),[to,setTo]=useState(''),[report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
 useEffect(()=>{generation.current++;setReport(null);},[revision]);
 useEffect(()=>{if(locked){generation.current++;setReport(null);}},[locked]);
 async function submit(event:React.FormEvent){
  event.preventDefault();if(locked||busy||!from||!to)return;
  if(from>to){setReport(null);setError('Das Anfangsdatum darf nicht nach dem Enddatum liegen.');return;}
  const request=++generation.current;setBusy(true);setReport(null);setError('');
  try{
   const query=new URLSearchParams({from,to});const response=await fetch(`/api/ledger/period-summary?${query}`,{cache:'no-store'});
   if(response.status===401||response.status===403){onAuth();throw new Error('Bitte erneut anmelden.');}
   const value=await response.json().catch(()=>null);if(!response.ok)throw new Error(value&&typeof value.error==='string'?value.error:'Die Auswertung konnte nicht erstellt werden.');
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Ungültige Serverantwort.');
   const cents=(input:unknown)=>typeof input==='string'&&/^-?\d+$/.test(input);
   const accountRow=(item:unknown)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return false;
    const row=item as Record<string,unknown>,account=row.account;
    if(!account||typeof account!=='object'||Array.isArray(account))return false;
    const a=account as Record<string,unknown>;
    return ['id','code','name'].every(key=>typeof a[key]==='string')&&['debitCents','creditCents','netDebitCents'].every(key=>cents(row[key]));
   };
   if(value.from!==from||value.to!==to||!Array.isArray(value.accounts)||!Number.isSafeInteger(value.journalCount)||value.journalCount<0||!Number.isSafeInteger(value.lineCount)||value.lineCount<0||typeof value.generatedAt!=='string'||!Number.isFinite(Date.parse(value.generatedAt))||!['incomeCreditMinusDebitCents','expenseDebitMinusCreditCents','incomeLessExpenseCents'].every(key=>cents(value[key]))||!value.accounts.every(accountRow))throw new Error('Ungültige Serverantwort.');
   if(mounted.current&&generation.current===request)setReport(value as Report);
  }catch(e){if(mounted.current&&generation.current===request)setError(e instanceof Error?e.message:'Die Auswertung konnte nicht erstellt werden.');}finally{if(mounted.current)setBusy(false);}
 }
 return <section className="panel" style={{display:'grid',gap:14,marginBottom:24,maxWidth:960}} aria-label="Zeitraumauswertung">
  <div><p className="eyebrow">JOURNAL / ZEITRAUM</p><h2>Kontenbewegungen prüfen</h2></div>
  <p>Wähle Anfang und Ende selbst, auch bei einem abweichenden Geschäftsjahr. Die Auswertung umfasst nur die in diesem Zeitraum gebuchten Journalzeilen. Stornos zählen an ihrem eigenen Buchungsdatum; der heutige Kontenplan wird vollständig angezeigt.</p>
  <p>Die Zuordnung der Kontoarten stammt aus deinen Angaben. Die Differenz der Ertrags- und Aufwandskonten ist eine vorläufige Rechenhilfe, kein geprüfter Jahresüberschuss, keine Bilanz und keine Gewinn- und Verlustrechnung. Steuern, Abgrenzungen, Eröffnungswerte, Vollständigkeit und Abschlussbuchungen werden nicht geprüft.</p>
  <p>Eine UG-Rücklage wird hier nicht berechnet. Dafür sind unter anderem der maßgebliche Jahresüberschuss und ein möglicher Verlustvortrag zu klären. <a href="https://www.gesetze-im-internet.de/gmbhg/__5a.html" target="_blank" rel="noreferrer">§ 5a GmbHG ansehen</a></p>
  <form onSubmit={submit} style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,190px),1fr))',gap:12}}>
   <label style={field}>Von einschließlich<input style={input} type="date" required value={from} disabled={locked||busy} onChange={e=>{setFrom(e.target.value);setReport(null);}}/></label>
   <label style={field}>Bis einschließlich<input style={input} type="date" required value={to} disabled={locked||busy} onChange={e=>{setTo(e.target.value);setReport(null);}}/></label>
   <button type="submit" className="secondary-action" disabled={locked||busy||!from||!to} style={{alignSelf:'end'}}>{busy?'Auswertung läuft …':'Zeitraum auswerten'}</button>
  </form>
  {error&&<p role="alert" className="error">{error}</p>}
  {report&&<div style={{display:'grid',gap:12}} aria-live="polite">
   <h3>Gebuchte Bewegungen · {report.from} bis {report.to}</h3>
   <p>{report.journalCount} Journalbuchungen · {report.lineCount} Buchungszeilen · Stand {new Date(report.generatedAt).toLocaleString('de-DE')}<br/>Nach Änderungen in anderen Tabs oder Geräten erneut auswerten.</p>
   {report.journalCount===0&&<p>Für diesen Zeitraum sind keine Journalbuchungen vorhanden. Das belegt nicht, dass die Buchführung vollständig ist.</p>}
   <p>Ertragskonten, Haben − Soll: <strong>{euro(report.incomeCreditMinusDebitCents)}</strong><br/>Aufwandskonten, Soll − Haben: <strong>{euro(report.expenseDebitMinusCreditCents)}</strong><br/>Differenz dieser Konten: <strong>{euro(report.incomeLessExpenseCents)}</strong></p>
   {!report.accounts.length?<p>Kein Kontenplan vorhanden.</p>:<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',textAlign:'left'}}><thead><tr><th>Konto</th><th>Soll im Zeitraum</th><th>Haben im Zeitraum</th><th>Saldo Soll − Haben</th></tr></thead><tbody>{report.accounts.map(item=><tr key={item.account.id}><td>{item.account.code} · {item.account.name}</td><td>{euro(item.debitCents)}</td><td>{euro(item.creditCents)}</td><td>{euro(item.netDebitCents)}</td></tr>)}</tbody></table></div>}
  </div>}
 </section>;
}
