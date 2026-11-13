/** Local recovery queue. IndexedDB is browser/profile/device local and can be cleared or evicted. */
import type {FinanceSettingsDraft} from './finance';

type EntryPayload={action:'entry'|'reversal';id:string;[key:string]:unknown};
export type FinanceOutboxItem =
 | {id:string;kind:'entry';createdAt:string;payload:EntryPayload}
 | {id:string;kind:'settings';createdAt:string;payload:FinanceSettingsDraft}
 | {id:string;kind:'document';createdAt:string;entryId:string;filename:string;blob:Blob};
const DB_NAME='videomaker-finance-outbox',STORE='operations',CHANGE='videomaker-finance-outbox-change';
function changed(){window.dispatchEvent(new Event(CHANGE));if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(CHANGE);channel.postMessage('changed');channel.close();}}
export function subscribeFinanceOutbox(callback:()=>void){
 window.addEventListener(CHANGE,callback);window.addEventListener('focus',callback);
 const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel(CHANGE):null;
 if(channel)channel.onmessage=callback;
 return()=>{window.removeEventListener(CHANGE,callback);window.removeEventListener('focus',callback);channel?.close();};
}
async function database():Promise<IDBDatabase>{
 if(typeof indexedDB==='undefined')throw new Error('Lokaler Speicher ist in diesem Browser nicht verfügbar.');
 return new Promise((resolve,reject)=>{let blocked=false;const request=indexedDB.open(DB_NAME,1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'id'});};
  request.onerror=()=>reject(request.error||new Error('Lokaler Speicher konnte nicht geöffnet werden.'));
  request.onblocked=()=>{blocked=true;reject(new Error('Lokaler Speicher wird durch einen anderen Tab blockiert.'));};
  request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
 });
}
async function run<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
 const db=await database();
 try{return await new Promise<T>((resolve,reject)=>{let value:T;const tx=mode==='readwrite'?db.transaction(STORE,mode,{durability:'strict'}):db.transaction(STORE,mode),req=operation(tx.objectStore(STORE));
  req.onsuccess=()=>{value=req.result;};
  tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error||req.error||new Error('Lokaler Speichervorgang fehlgeschlagen.'));tx.onerror=()=>{};
 });}finally{db.close();}
}
export async function listFinanceOutbox():Promise<FinanceOutboxItem[]>{return (await run('readonly',store=>store.getAll())) as FinanceOutboxItem[];}
async function same(a:FinanceOutboxItem,b:FinanceOutboxItem){
 if(a.id!==b.id||a.kind!==b.kind)return false;
 if(a.kind==='document'&&b.kind==='document'){
  if(a.entryId!==b.entryId||a.filename!==b.filename||a.blob.size!==b.blob.size)return false;
  const [x,y]=await Promise.all([a.blob.arrayBuffer(),b.blob.arrayBuffer()]);const left=new Uint8Array(x),right=new Uint8Array(y);
  return left.every((byte,i)=>byte===right[i]);
 }
 return 'payload' in a&&'payload' in b&&JSON.stringify(a.payload)===JSON.stringify(b.payload);
}
/** Never overwrite an existing operation. Wait for the transaction commit before any POST. */
export async function saveFinanceOutbox(item:FinanceOutboxItem):Promise<void>{
 try{await run('readwrite',store=>store.add(item));changed();}
 catch(error){
  const existing=await run('readonly',store=>store.get(item.id)) as FinanceOutboxItem|undefined;
  if(!existing||!await same(existing,item))throw error;
 }
}
/** Only call after validating the server's exact success response. */
export async function removeConfirmedFinanceOutbox(id:string):Promise<void>{await run('readwrite',store=>store.delete(id));changed();}
