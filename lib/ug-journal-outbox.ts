/** Durable, browser-profile-local single-operation outbox. Browser data can still be evicted or cleared. */
import {parsePendingJournal,type PendingJournal} from '@/app/api/ledger/_safety';

const DB='videomaker-ug-journal-outbox', STORE='operations', KEY='active', CHANGE='videomaker-ug-journal-outbox-change';
type RecordValue={key:string;item:PendingJournal};
export class JournalOutboxConflict extends Error {}
function parse(value:unknown):PendingJournal {
 if(!value||typeof value!=='object'||(value as RecordValue).key!==KEY)throw new Error('Gespeicherter Vorgang ist ungültig.');
 return {...parsePendingJournal(JSON.stringify((value as RecordValue).item)),uncertain:true};
}
function equal(left:PendingJournal,right:PendingJournal){return JSON.stringify({...left,uncertain:true})===JSON.stringify({...right,uncertain:true});}
function changed(){window.dispatchEvent(new Event(CHANGE));if(typeof BroadcastChannel!=='undefined'){const c=new BroadcastChannel(CHANGE);c.postMessage('changed');c.close();}}
export function subscribeJournalOutbox(callback:()=>void){
 window.addEventListener(CHANGE,callback);window.addEventListener('focus',callback);
 const c=typeof BroadcastChannel!=='undefined'?new BroadcastChannel(CHANGE):null;if(c)c.onmessage=callback;
 return()=>{window.removeEventListener(CHANGE,callback);window.removeEventListener('focus',callback);c?.close();};
}
async function database():Promise<IDBDatabase>{
 if(typeof indexedDB==='undefined')throw new Error('Lokaler Speicher ist nicht verfügbar.');
 return new Promise((resolve,reject)=>{let blocked=false;const request=indexedDB.open(DB,1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'key'});};
  request.onerror=()=>reject(request.error||new Error('Lokaler Speicher konnte nicht geöffnet werden.'));
  request.onblocked=()=>{blocked=true;reject(new Error('Lokaler Speicher wird durch einen anderen Tab blockiert.'));};
  request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
 });
}
export async function loadJournalOutbox():Promise<PendingJournal|null>{
 const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(KEY);let value:PendingJournal|null=null;
  req.onsuccess=()=>{try{value=req.result===undefined?null:parse(req.result);}catch{tx.abort();}};
  tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error||new Error('Gespeicherter Vorgang ist ungültig.'));tx.onerror=()=>{};
 });}finally{db.close();}
}
/** Atomically claim the only slot; never overwrite a different tab's operation. */
export async function saveJournalOutbox(item:PendingJournal):Promise<void>{
 const safe=parse({key:KEY,item});const db=await database();try{await new Promise<void>((resolve,reject)=>{
  let conflict=false;const tx=db.transaction(STORE,'readwrite',{durability:'strict'}),store=tx.objectStore(STORE),req=store.get(KEY);
  req.onsuccess=()=>{try{if(req.result!==undefined){if(!equal(parse(req.result),safe)){conflict=true;tx.abort();}}else store.add({key:KEY,item:safe});}catch{tx.abort();}};
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(conflict?new JournalOutboxConflict('Ein anderer Vorgang ist noch offen.'):tx.error||new Error('Lokaler Speichervorgang fehlgeschlagen.'));tx.onerror=()=>{};
 });}finally{db.close();}changed();
}
/** Delete only this exact confirmed operation, never another tab's successor. */
export async function removeConfirmedJournalOutbox(item:PendingJournal):Promise<boolean>{
 const safe=parse({key:KEY,item});const db=await database();let removed=false;
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite',{durability:'strict'}),store=tx.objectStore(STORE),req=store.get(KEY);
  req.onsuccess=()=>{try{if(req.result!==undefined&&equal(parse(req.result),safe)){store.delete(KEY);removed=true;}}catch{tx.abort();}};
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Lokaler Speichervorgang fehlgeschlagen.'));tx.onerror=()=>{};
 });}finally{db.close();}if(removed)changed();return removed;
}
