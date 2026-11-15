'use client';
import {useEffect,useRef,useState} from 'react';

/** A separate dialog leaves the current editor, recording and script options mounted. */
export default function SessionReauthentication({onCancel,onSuccess}:{onCancel:()=>void;onSuccess:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const element=dialog.current;if(!element)return;element.showModal();return()=>{if(element.open)element.close();};},[]);
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy)return;setBusy(true);setError('');
  try{
   const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
   const data=await response.json();setPassword('');
   if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Anmeldung fehlgeschlagen.');
   onSuccess();
  }catch(error){setPassword('');setError(error instanceof Error?error.message:'Anmeldung fehlgeschlagen.');}
  finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="image-choice-dialog" aria-labelledby="session-reauth-title" onCancel={event=>{if(busy)event.preventDefault();else onCancel();}}>
  <h2 id="session-reauth-title">Erneut anmelden</h2>
  <p>Deine Sitzung ist nicht mehr gültig. Deine geöffneten Eingaben bleiben erhalten. Nach der Anmeldung entscheidest du selbst, ob du eine Aktion erneut startest.</p>
  <form onSubmit={submit}>
   <label htmlFor="session-reauth-password">Admin-Passwort</label>
   <input id="session-reauth-password" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required disabled={busy}/>
   {error&&<p className="error" role="alert">{error}</p>}
   <div className="image-choice-actions"><button type="button" className="image-choice-cancel" disabled={busy} onClick={onCancel}>Später</button><button type="submit" className="primary" disabled={busy}>{busy?'Anmeldung läuft …':'Anmelden'}</button></div>
  </form>
 </dialog>;
}
