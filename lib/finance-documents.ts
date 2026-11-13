import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {MAX_FINANCE_DOCUMENT_BYTES,MAX_FINANCE_DOCUMENTS_PER_ENTRY,MAX_FINANCE_DOCUMENT_TOTAL_BYTES,isFinanceId,validFinanceDocumentName,type FinanceDocument} from './finance';
import {FinanceConflict,FinanceNotFound} from './finance-store';

/** Immutable application records, not a substitute for audited backups or GoBD compliance. */
export const FINANCE_DOCUMENT_SCHEMA=`
 CREATE TABLE IF NOT EXISTS finance_documents (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, original_name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(typeof(size)='integer' AND size>0 AND size<=10485760),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64), created_at TEXT NOT NULL,
  data BLOB NOT NULL CHECK(typeof(data)='blob' AND length(data)=size),
  UNIQUE(entry_id,sha256)
 );
 CREATE INDEX IF NOT EXISTS finance_documents_entry_idx ON finance_documents(entry_id,created_at,id);
 -- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is off.
 -- Guard every conflict key, including the implicit rowid, before replacement.
 CREATE TRIGGER IF NOT EXISTS finance_documents_insert_guard BEFORE INSERT ON finance_documents BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM finance_documents d WHERE d.id=NEW.id OR d.rowid=NEW.rowid OR (d.entry_id=NEW.entry_id AND d.sha256=NEW.sha256)) THEN RAISE(ABORT,'finance document already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS finance_documents_no_update BEFORE UPDATE ON finance_documents BEGIN SELECT RAISE(ABORT,'finance documents cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS finance_documents_no_delete BEFORE DELETE ON finance_documents BEGIN SELECT RAISE(ABORT,'finance documents cannot be deleted'); END;
`;
export function ensureFinanceDocumentsSchema(database:Database.Database){database.exec(FINANCE_DOCUMENT_SCHEMA);}
export class FinanceDocumentLimit extends Error {}
export class FinanceDocumentCorrupt extends Error {}
const metadata=`id,entry_id AS entryId,original_name AS originalName,size,sha256,created_at AS createdAt`;
function entryExists(database:Database.Database,entryId:string){
 return !!database.prepare('SELECT 1 FROM finance_entries WHERE id=?').get(entryId);
}
export function listFinanceDocuments(database:Database.Database,entryId:string):FinanceDocument[]{
 if(!isFinanceId(entryId)||!entryExists(database,entryId))throw new FinanceNotFound('Finanzvorgang nicht gefunden.');
 return database.prepare(`SELECT ${metadata} FROM finance_documents WHERE entry_id=? ORDER BY created_at,id`).all(entryId) as FinanceDocument[];
}
export function storeFinanceDocument(database:Database.Database,input:{id:string;entryId:string;originalName:string;data:Buffer},now:string):{document:FinanceDocument;created:boolean}{
 const {id,entryId,originalName,data}=input;
 if(!isFinanceId(id)||!isFinanceId(entryId)||!validFinanceDocumentName(originalName)||!Buffer.isBuffer(data)||data.length===0||data.length>MAX_FINANCE_DOCUMENT_BYTES)throw new Error('Ungültiger Beleg.');
 const sha256=createHash('sha256').update(data).digest('hex');
 return database.transaction(()=>{
  if(!entryExists(database,entryId))throw new FinanceNotFound('Finanzvorgang nicht gefunden.');
  const existing=database.prepare(`SELECT ${metadata} FROM finance_documents WHERE id=?`).get(id) as FinanceDocument|undefined;
  if(existing){
   if(existing.entryId!==entryId||existing.originalName!==originalName||existing.sha256!==sha256||existing.size!==data.length)throw new FinanceConflict('Diese Beleg-ID wurde bereits anders verwendet.');
   // A retry must not report success when the previously stored bytes are damaged.
   return {document:readFinanceDocument(database,entryId,id).document,created:false};
  }
  const duplicate=database.prepare('SELECT 1 FROM finance_documents WHERE entry_id=? AND sha256=?').get(entryId,sha256);
  if(duplicate)throw new FinanceConflict('Diese Datei ist diesem Vorgang bereits zugeordnet.');
  const entryCount=database.prepare('SELECT count(*) AS count FROM finance_documents WHERE entry_id=?').get(entryId) as {count:number};
  if(entryCount.count>=MAX_FINANCE_DOCUMENTS_PER_ENTRY)throw new FinanceDocumentLimit('Für diesen Vorgang ist die maximale Anzahl an Belegen erreicht.');
  const total=database.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM finance_documents').get() as {bytes:number};
  if(total.bytes+data.length>MAX_FINANCE_DOCUMENT_TOTAL_BYTES)throw new FinanceDocumentLimit('Der verfügbare Platz für die Belegablage ist ausgeschöpft.');
  database.prepare('INSERT INTO finance_documents(id,entry_id,original_name,size,sha256,created_at,data) VALUES(?,?,?,?,?,?,?)').run(id,entryId,originalName,data.length,sha256,now,data);
  return {document:{id,entryId,originalName,size:data.length,sha256,createdAt:now},created:true};
 })();
}
export function readFinanceDocument(database:Database.Database,entryId:string,id:string):{document:FinanceDocument;data:Buffer}{
 if(!isFinanceId(entryId)||!isFinanceId(id))throw new FinanceNotFound('Beleg nicht gefunden.');
 const row=database.prepare(`SELECT ${metadata},data FROM finance_documents WHERE entry_id=? AND id=?`).get(entryId,id) as (FinanceDocument&{data:Buffer})|undefined;
 if(!row)throw new FinanceNotFound('Beleg nicht gefunden.');
 const {data,...document}=row;
 if(!Buffer.isBuffer(data)||data.length!==document.size||createHash('sha256').update(data).digest('hex')!==document.sha256)throw new FinanceDocumentCorrupt('Belegprüfung fehlgeschlagen.');
 return {document,data};
}
