import type Database from 'better-sqlite3';
import {isFinanceId,type FinanceDocument} from './finance';
import {FinanceDocumentCorrupt,readFinanceDocument} from './finance-documents';
import {FinanceNotFound} from './finance-store';
import {LedgerConflict,LedgerNotFound,LedgerValidationError} from './ug-ledger';

/** Application-level immutable audit events; database-owner tampering and GoBD compliance are out of scope. */
export const UG_LEDGER_DOCUMENTS_SCHEMA=`
 CREATE TABLE IF NOT EXISTS ug_ledger_document_links (
  id TEXT PRIMARY KEY, journal_id TEXT NOT NULL, document_id TEXT NOT NULL, finance_entry_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  original_name TEXT NOT NULL, size INTEGER NOT NULL CHECK(typeof(size)='integer' AND size>0 AND size<=10485760),
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS ug_ledger_document_links_journal ON ug_ledger_document_links(journal_id,created_at,id);
 CREATE TABLE IF NOT EXISTS ug_ledger_document_unlinks (
  id TEXT PRIMARY KEY, link_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 250), created_at TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS ug_ledger_document_links_insert_guard BEFORE INSERT ON ug_ledger_document_links BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_document_links WHERE rowid=NEW.rowid) THEN RAISE(ABORT,'link rowid already exists') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_document_links WHERE id=NEW.id) THEN RAISE(ABORT,'link already exists') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ug_ledger_journals WHERE id=NEW.journal_id) THEN RAISE(ABORT,'journal not found') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM finance_documents d WHERE d.id=NEW.document_id AND d.entry_id=NEW.finance_entry_id AND d.sha256=NEW.sha256 AND d.original_name=NEW.original_name AND d.size=NEW.size) THEN RAISE(ABORT,'document snapshot mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_document_links l WHERE l.journal_id=NEW.journal_id AND l.document_id=NEW.document_id AND NOT EXISTS(SELECT 1 FROM ug_ledger_document_unlinks u WHERE u.link_id=l.id)) THEN RAISE(ABORT,'active link already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_document_links_no_update BEFORE UPDATE ON ug_ledger_document_links BEGIN SELECT RAISE(ABORT,'links cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_document_links_no_delete BEFORE DELETE ON ug_ledger_document_links BEGIN SELECT RAISE(ABORT,'links cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_document_unlinks_insert_guard BEFORE INSERT ON ug_ledger_document_unlinks BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_document_unlinks WHERE rowid=NEW.rowid) THEN RAISE(ABORT,'unlink rowid already exists') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_document_unlinks WHERE id=NEW.id OR link_id=NEW.link_id) THEN RAISE(ABORT,'unlink already exists') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ug_ledger_document_links WHERE id=NEW.link_id) THEN RAISE(ABORT,'link not found') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_document_unlinks_no_update BEFORE UPDATE ON ug_ledger_document_unlinks BEGIN SELECT RAISE(ABORT,'unlink events cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_document_unlinks_no_delete BEFORE DELETE ON ug_ledger_document_unlinks BEGIN SELECT RAISE(ABORT,'unlink events cannot be deleted'); END;
`;
export function ensureLedgerDocumentsSchema(db:Database.Database){db.exec(UG_LEDGER_DOCUMENTS_SCHEMA);}
export type LedgerDocumentLink={id:string;journalId:string;documentId:string;financeEntryId:string;sha256:string;originalName:string;size:number;createdAt:string;unlinkId:string|null;unlinkReason:string|null;unlinkedAt:string|null};
export type LedgerDocumentOption=FinanceDocument&{sequence:number;financeDescription:string;financeDate:string;financeDirection:string};
const columns=`l.id,l.journal_id AS journalId,l.document_id AS documentId,l.finance_entry_id AS financeEntryId,l.sha256,l.original_name AS originalName,l.size,l.created_at AS createdAt,u.id AS unlinkId,u.reason AS unlinkReason,u.created_at AS unlinkedAt`;
function linkById(db:Database.Database,id:string){return db.prepare(`SELECT ${columns} FROM ug_ledger_document_links l LEFT JOIN ug_ledger_document_unlinks u ON u.link_id=l.id WHERE l.id=?`).get(id) as LedgerDocumentLink|undefined;}
function checkedId(value:unknown):string{if(!isFinanceId(value))throw new LedgerValidationError('Ungültige ID.');return value;}
function inputRecord(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new LedgerValidationError('Ungültige Anfrage.');return value as Record<string,unknown>;}
function checkTime(now:string){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)throw new LedgerValidationError('Ungültiger Zeitstempel.');}
function verifiedDocument(db:Database.Database,entry:string,id:string){try{return readFinanceDocument(db,entry,id);}catch(error){if(error instanceof FinanceDocumentCorrupt)throw new LedgerConflict('Der Originalbeleg hat die Integritätsprüfung nicht bestanden.');if(error instanceof FinanceNotFound)throw new LedgerNotFound('Originalbeleg nicht gefunden.');throw error;}}
function verifySnapshot(db:Database.Database,link:LedgerDocumentLink){
 const result=verifiedDocument(db,link.financeEntryId,link.documentId), d=result.document;
 if(d.sha256!==link.sha256||d.size!==link.size||d.originalName!==link.originalName)throw new LedgerConflict('Der Originalbeleg stimmt nicht mehr mit der gespeicherten Zuordnung überein.');
 return result;
}
export function listLedgerDocumentOptions(db:Database.Database,before:number|null,limit=50):{documents:LedgerDocumentOption[];nextBefore:number|null}{
 if(before!==null&&(!Number.isSafeInteger(before)||before<=0))throw new LedgerValidationError('Ungültige Seitenposition.');
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new LedgerValidationError('Ungültige Seitengröße.');
 const rows=db.prepare(`SELECT d.rowid AS sequence,d.id,d.entry_id AS entryId,d.original_name AS originalName,d.size,d.sha256,d.created_at AS createdAt,e.description AS financeDescription,e.occurred_on AS financeDate,e.direction AS financeDirection FROM finance_documents d JOIN finance_entries e ON e.id=d.entry_id WHERE (? IS NULL OR d.rowid<?) ORDER BY d.rowid DESC LIMIT ?`).all(before,before,limit+1) as LedgerDocumentOption[];
 const page=rows.slice(0,limit);return {documents:page,nextBefore:rows.length>limit?page[page.length-1].sequence:null};
}
export function listLedgerDocumentLinks(db:Database.Database,journalId:string):LedgerDocumentLink[]{
 checkedId(journalId);if(!db.prepare('SELECT 1 FROM ug_ledger_journals WHERE id=?').get(journalId))throw new LedgerNotFound('Buchung nicht gefunden.');
 return db.prepare(`SELECT ${columns} FROM ug_ledger_document_links l LEFT JOIN ug_ledger_document_unlinks u ON u.link_id=l.id WHERE l.journal_id=? ORDER BY l.rowid DESC LIMIT 501`).all(journalId) as LedgerDocumentLink[];
}
export function attachLedgerDocument(db:Database.Database,journalId:string,input:unknown,now:string):{link:LedgerDocumentLink;created:boolean}{
 checkedId(journalId);const item=inputRecord(input),id=checkedId(item.id),documentId=checkedId(item.documentId),entryId=checkedId(item.financeEntryId),sha256=item.sha256;checkTime(now);
 if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw new LedgerValidationError('Ungültiger Beleg-Hash.');
 return db.transaction(()=>{
  const existing=linkById(db,id);
  if(existing){if(existing.journalId!==journalId||existing.documentId!==documentId||existing.financeEntryId!==entryId||existing.sha256!==sha256)throw new LedgerConflict('Diese Zuordnungs-ID wurde bereits anders verwendet.');verifySnapshot(db,existing);return {link:existing,created:false};}
  if(!db.prepare('SELECT 1 FROM ug_ledger_journals WHERE id=?').get(journalId))throw new LedgerNotFound('Buchung nicht gefunden.');
  const {document}=verifiedDocument(db,entryId,documentId);
  if(document.sha256!==sha256)throw new LedgerConflict('Der Beleg hat sich seit der Auswahl geändert. Bitte die Auswahl erneut prüfen.');
  const duplicate=db.prepare('SELECT 1 FROM ug_ledger_document_links l WHERE l.journal_id=? AND l.document_id=? AND NOT EXISTS(SELECT 1 FROM ug_ledger_document_unlinks u WHERE u.link_id=l.id)').get(journalId,documentId);
  if(duplicate)throw new LedgerConflict('Dieser Beleg ist der Buchung bereits zugeordnet.');
  const count=db.prepare('SELECT COUNT(*) AS n FROM ug_ledger_document_links WHERE journal_id=?').get(journalId) as {n:number};
  if(count.n>=500)throw new LedgerConflict('Für diese Buchung wurde die Höchstzahl an Zuordnungsereignissen erreicht.');
  db.prepare('INSERT INTO ug_ledger_document_links(id,journal_id,document_id,finance_entry_id,sha256,original_name,size,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,journalId,documentId,entryId,document.sha256,document.originalName,document.size,now);
  return {link:linkById(db,id)!,created:true};
 })();
}
export function unlinkLedgerDocument(db:Database.Database,journalId:string,linkId:string,input:unknown,now:string):{link:LedgerDocumentLink;created:boolean}{
 checkedId(journalId);checkedId(linkId);const item=inputRecord(input),id=checkedId(item.id);checkTime(now);
 if(typeof item.reason!=='string'||/[\u0000-\u001f\u007f]/.test(item.reason)||!item.reason.trim()||item.reason.trim().length>250)throw new LedgerValidationError('Begründung ist ungültig.');
 const reason=item.reason.trim();return db.transaction(()=>{
  const previous=db.prepare('SELECT id,link_id AS linkId,reason FROM ug_ledger_document_unlinks WHERE id=?').get(id) as {id:string;linkId:string;reason:string}|undefined;
  if(previous){if(previous.linkId!==linkId||previous.reason!==reason)throw new LedgerConflict('Diese Korrektur-ID wurde bereits anders verwendet.');const link=linkById(db,linkId);if(!link||link.journalId!==journalId)throw new LedgerConflict('Diese Korrektur-ID wurde bereits anders verwendet.');return {link,created:false};}
  const link=linkById(db,linkId);if(!link||link.journalId!==journalId)throw new LedgerNotFound('Zuordnung nicht gefunden.');
  if(link.unlinkId)throw new LedgerConflict('Diese Zuordnung wurde bereits korrigiert.');
  db.prepare('INSERT INTO ug_ledger_document_unlinks(id,link_id,reason,created_at) VALUES(?,?,?,?)').run(id,linkId,reason,now);return {link:linkById(db,linkId)!,created:true};
 })();
}
/** Downloads compare both the current bytes and the immutable snapshot captured at linking. */
export function readLinkedLedgerDocument(db:Database.Database,linkId:string){checkedId(linkId);const link=linkById(db,linkId);if(!link)throw new LedgerNotFound('Zuordnung nicht gefunden.');return verifySnapshot(db,link);}
