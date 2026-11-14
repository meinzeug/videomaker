'use client';

import {useState} from 'react';
import {Download} from 'lucide-react';

/** Check availability before starting a browser-managed download. */
export default function ApkDownload({onError}:{onError:(message:string)=>void}) {
 const [checking,setChecking]=useState(false);
 async function start() {
  if(checking)return;
  setChecking(true);
  try{
   const response=await fetch('/api/apk',{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(12000)});
   if(response.status===401)throw new Error('Bitte melde dich erneut an, um KontraPrompter herunterzuladen.');
   if(response.status===404)throw new Error('Das KontraPrompter-APK ist derzeit nicht verfügbar.');
   if(!response.ok)throw new Error('Der Download konnte nicht gestartet werden.');
   const link=document.createElement('a');link.href='/api/apk';link.download='KontraPrompter-debug.apk';document.body.appendChild(link);link.click();link.remove();
  }catch(error){onError(error instanceof Error?error.message:'Der Download konnte nicht gestartet werden.');}
  finally{setChecking(false);}
 }
 return <button type="button" className="icon apk-download" title="KontraPrompter-Testversion (Debug) herunterladen" aria-label="KontraPrompter-Testversion (Debug) herunterladen" aria-busy={checking} disabled={checking} onClick={()=>void start()}><Download size={18} aria-hidden="true"/><span aria-hidden="true">DEBUG</span></button>;
}
