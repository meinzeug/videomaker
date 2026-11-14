import type Database from 'better-sqlite3';
import {isFinanceId} from './finance.ts';
import {LedgerConflict,LedgerNotFound,LedgerValidationError} from './ug-ledger.ts';

/** Explicit cross-reference events only: no accounting or tax inference. */
export const UG_LEDGER_FINANCE_LINKS_SCHEMA=`
 CREATE TABLE IF NOT EXISTS ug_ledger_finance_links (
  id TEXT PRIMARY KEY, journal_id TEXT NOT NULL, finance_entry_id TEXT NOT NULL, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS ug_ledger_finance_links_journal ON ug_ledger_finance_links(journal_id,id);
 CREATE INDEX IF NOT EXISTS ug_ledger_finance_links_finance ON ug_ledger_finance_links(finance_entry_id,id);
 CREATE TABLE IF NOT EXISTS ug_ledger_finance_unlinks (
  id TEXT PRIMARY KEY, link_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 250), created_at TEXT NOT NULL
 );
 -- Every accepted request has a durable receipt, including concurrent requests
 -- for the same active pair. A later correction never reactivates that receipt.
 CREATE TABLE IF NOT EXISTS ug_ledger_finance_link_requests (
  id TEXT PRIMARY KEY, link_id TEXT, journal_id TEXT NOT NULL, finance_entry_id TEXT NOT NULL,
  expected_link_id TEXT, expected_unlink_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('linked','stale','limit')),
  created_at TEXT NOT NULL, CHECK(expected_link_id IS NOT NULL OR expected_unlink_id IS NULL),
  CHECK((outcome='linked' AND link_id IS NOT NULL) OR (outcome<>'linked' AND link_id IS NULL))
 );
 CREATE TABLE IF NOT EXISTS ug_ledger_finance_unlink_requests (
  id TEXT PRIMARY KEY, link_id TEXT NOT NULL, journal_id TEXT NOT NULL, reason TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('corrected','already_corrected')), created_at TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_links_insert_guard BEFORE INSERT ON ug_ledger_finance_links BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_links WHERE id=NEW.id OR rowid=NEW.rowid) THEN RAISE(ABORT,'link already exists') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_link_requests WHERE id=NEW.id) THEN RAISE(ABORT,'request already exists') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ug_ledger_journals WHERE id=NEW.journal_id) THEN RAISE(ABORT,'journal not found') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM finance_entries WHERE id=NEW.finance_entry_id) THEN RAISE(ABORT,'finance entry not found') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_links l WHERE l.journal_id=NEW.journal_id AND l.finance_entry_id=NEW.finance_entry_id AND NOT EXISTS(SELECT 1 FROM ug_ledger_finance_unlinks u WHERE u.link_id=l.id)) THEN RAISE(ABORT,'active link already exists') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM ug_ledger_finance_links WHERE journal_id=NEW.journal_id)>=500 THEN RAISE(ABORT,'journal link limit reached') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_links_no_update BEFORE UPDATE ON ug_ledger_finance_links BEGIN SELECT RAISE(ABORT,'links cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_links_no_delete BEFORE DELETE ON ug_ledger_finance_links BEGIN SELECT RAISE(ABORT,'links cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_unlinks_insert_guard BEFORE INSERT ON ug_ledger_finance_unlinks BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_unlinks WHERE id=NEW.id OR rowid=NEW.rowid OR link_id=NEW.link_id) THEN RAISE(ABORT,'unlink already exists') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ug_ledger_finance_links WHERE id=NEW.link_id) THEN RAISE(ABORT,'link not found') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_unlinks_no_update BEFORE UPDATE ON ug_ledger_finance_unlinks BEGIN SELECT RAISE(ABORT,'unlink events cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_unlinks_no_delete BEFORE DELETE ON ug_ledger_finance_unlinks BEGIN SELECT RAISE(ABORT,'unlink events cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_link_requests_insert_guard BEFORE INSERT ON ug_ledger_finance_link_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_link_requests WHERE id=NEW.id OR rowid=NEW.rowid) THEN RAISE(ABORT,'request already exists') END;
  SELECT CASE WHEN NEW.outcome='linked' AND NOT EXISTS(SELECT 1 FROM ug_ledger_finance_links WHERE id=NEW.link_id AND journal_id=NEW.journal_id AND finance_entry_id=NEW.finance_entry_id) THEN RAISE(ABORT,'request link mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_links WHERE id=NEW.id AND id<>NEW.link_id) THEN RAISE(ABORT,'request ID belongs to another link') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_link_requests_no_update BEFORE UPDATE ON ug_ledger_finance_link_requests BEGIN SELECT RAISE(ABORT,'requests cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_link_requests_no_delete BEFORE DELETE ON ug_ledger_finance_link_requests BEGIN SELECT RAISE(ABORT,'requests cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_unlink_requests_insert_guard BEFORE INSERT ON ug_ledger_finance_unlink_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_finance_unlink_requests WHERE id=NEW.id OR rowid=NEW.rowid) THEN RAISE(ABORT,'unlink request already exists') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ug_ledger_finance_links WHERE id=NEW.link_id AND journal_id=NEW.journal_id) THEN RAISE(ABORT,'unlink request link mismatch') END;
  SELECT CASE WHEN NEW.outcome='corrected' AND NOT EXISTS(SELECT 1 FROM ug_ledger_finance_unlinks WHERE id=NEW.id AND link_id=NEW.link_id AND reason=NEW.reason) THEN RAISE(ABORT,'unlink request correction mismatch') END;
  SELECT CASE WHEN NEW.outcome='already_corrected' AND NOT EXISTS(SELECT 1 FROM ug_ledger_finance_unlinks WHERE link_id=NEW.link_id) THEN RAISE(ABORT,'unlink request needs correction') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_unlink_requests_no_update BEFORE UPDATE ON ug_ledger_finance_unlink_requests BEGIN SELECT RAISE(ABORT,'unlink requests cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_finance_unlink_requests_no_delete BEFORE DELETE ON ug_ledger_finance_unlink_requests BEGIN SELECT RAISE(ABORT,'unlink requests cannot be deleted'); END;
`;
export function ensureLedgerFinanceLinksSchema(db:Database.Database){db.exec(UG_LEDGER_FINANCE_LINKS_SCHEMA);}
export type LedgerFinanceLink={id:string;journalId:string;financeEntryId:string;createdAt:string;financeDate:string;financeDescription:string;financeDirection:'income'|'expense';financeKind:'entry'|'reversal';financeAmountCents:number;financeReversedEntryId:string|null;financeReversed:boolean;unlinkId:string|null;unlinkReason:string|null;unlinkedAt:string|null};
type LinkRow=Omit<LedgerFinanceLink,'financeReversed'>&{financeReversed:number;sourceId:string|null;journalSourceId:string|null};
const columns=`l.id,l.journal_id AS journalId,l.finance_entry_id AS financeEntryId,l.created_at AS createdAt,e.id AS sourceId,j.id AS journalSourceId,e.occurred_on AS financeDate,e.description AS financeDescription,e.direction AS financeDirection,e.kind AS financeKind,e.amount_cents AS financeAmountCents,e.reversed_entry_id AS financeReversedEntryId,EXISTS(SELECT 1 FROM finance_entries r WHERE r.reversed_entry_id=e.id) AS financeReversed,u.id AS unlinkId,u.reason AS unlinkReason,u.created_at AS unlinkedAt`;
const joins='FROM ug_ledger_finance_links l LEFT JOIN finance_entries e ON e.id=l.finance_entry_id LEFT JOIN ug_ledger_journals j ON j.id=l.journal_id LEFT JOIN ug_ledger_finance_unlinks u ON u.link_id=l.id';
const present=(row:LinkRow):LedgerFinanceLink=>{const {sourceId,journalSourceId,...rest}=row;if(!sourceId)throw new Error('Finanzvorgang einer Zuordnung fehlt.');if(!journalSourceId)throw new Error('Journalbuchung einer Zuordnung fehlt.');return {...rest,financeReversed:!!row.financeReversed};};
function byId(db:Database.Database,id:string){const row=db.prepare(`SELECT ${columns} ${joins} WHERE l.id=?`).get(id) as LinkRow|undefined;return row?present(row):undefined;}
function checkedId(value:unknown):string{if(!isFinanceId(value))throw new LedgerValidationError('Ungültige ID.');return value;}
function inputRecord(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new LedgerValidationError('Ungültige Anfrage.');return value as Record<string,unknown>;}
function checkTime(value:string){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new LedgerValidationError('Ungültiger Zeitstempel.');}
export function listLedgerFinanceLinks(db:Database.Database,journalId:string):LedgerFinanceLink[]{
 checkedId(journalId);if(!db.prepare('SELECT 1 FROM ug_ledger_journals WHERE id=?').get(journalId))throw new LedgerNotFound('Buchung nicht gefunden.');
 const rows=db.prepare(`SELECT ${columns} ${joins} WHERE l.journal_id=? ORDER BY l.rowid DESC LIMIT 501`).all(journalId) as LinkRow[];
 return rows.map(present);
}
type LinkOutcome='linked'|'stale'|'limit';
type LinkRequest={linkId:string|null;journalId:string;financeEntryId:string;expectedLinkId:string|null;expectedUnlinkId:string|null;outcome:LinkOutcome};
export type LedgerFinanceAttachResult={requestId:string;journalId:string;financeEntryId:string;expectedLinkId:string|null;expectedUnlinkId:string|null;outcome:LinkOutcome;link:LedgerFinanceLink|null;created:boolean};
const nullableId=(value:unknown):string|null=>value===null?null:checkedId(value);
export function attachLedgerFinance(db:Database.Database,journalId:string,input:unknown,now:string):LedgerFinanceAttachResult{
 checkedId(journalId);const item=inputRecord(input),id=checkedId(item.id),financeEntryId=checkedId(item.financeEntryId),expectedLinkId=nullableId(item.expectedLinkId),expectedUnlinkId=nullableId(item.expectedUnlinkId);checkTime(now);
 if(expectedLinkId===null&&expectedUnlinkId!==null)throw new LedgerValidationError('Ungültiger beobachteter Zuordnungsstand.');
 return db.transaction(()=>{
  const request=db.prepare('SELECT link_id AS linkId,journal_id AS journalId,finance_entry_id AS financeEntryId,expected_link_id AS expectedLinkId,expected_unlink_id AS expectedUnlinkId,outcome FROM ug_ledger_finance_link_requests WHERE id=?').get(id) as LinkRequest|undefined;
  const base={requestId:id,journalId,financeEntryId,expectedLinkId,expectedUnlinkId};
  if(request){
   if(request.journalId!==journalId||request.financeEntryId!==financeEntryId||request.expectedLinkId!==expectedLinkId||request.expectedUnlinkId!==expectedUnlinkId)throw new LedgerConflict('Diese Zuordnungs-ID wurde bereits anders verwendet.');
   if(!db.prepare('SELECT 1 FROM ug_ledger_journals WHERE id=?').get(journalId)||!db.prepare('SELECT 1 FROM finance_entries WHERE id=?').get(financeEntryId))throw new Error('Quelle eines Zuordnungsbelegs fehlt.');
   const link=request.linkId?(byId(db,request.linkId)??null):null;
   if(request.outcome==='linked'&&(!link||link.journalId!==journalId||link.financeEntryId!==financeEntryId))throw new Error('Zuordnungsbeleg ist beschädigt.');
   return {...base,link,outcome:request.outcome,created:false};
  }
  if(byId(db,id))throw new LedgerConflict('Diese Zuordnungs-ID wurde bereits anders verwendet.');
  if(!db.prepare('SELECT 1 FROM ug_ledger_journals WHERE id=?').get(journalId))throw new LedgerNotFound('Buchung nicht gefunden.');
  if(!db.prepare('SELECT 1 FROM finance_entries WHERE id=?').get(financeEntryId))throw new LedgerNotFound('Finanzvorgang nicht gefunden.');
  const current=db.prepare('SELECT l.id,u.id AS unlinkId FROM ug_ledger_finance_links l LEFT JOIN ug_ledger_finance_unlinks u ON u.link_id=l.id WHERE l.journal_id=? AND l.finance_entry_id=? ORDER BY l.rowid DESC LIMIT 1').get(journalId,financeEntryId) as {id:string;unlinkId:string|null}|undefined;
  let outcome:LinkOutcome='linked',linkId:string|null=null,created=false;
  if((current?.id||null)!==expectedLinkId||(current?.unlinkId||null)!==expectedUnlinkId)outcome='stale';
  else if(current&&!current.unlinkId)linkId=current.id;
  else {
   const count=db.prepare('SELECT count(*) AS n FROM ug_ledger_finance_links WHERE journal_id=?').get(journalId) as {n:number};
   if(count.n>=500)outcome='limit';
   else {db.prepare('INSERT INTO ug_ledger_finance_links(id,journal_id,finance_entry_id,created_at) VALUES(?,?,?,?)').run(id,journalId,financeEntryId,now);linkId=id;created=true;}
  }
  db.prepare('INSERT INTO ug_ledger_finance_link_requests(id,link_id,journal_id,finance_entry_id,expected_link_id,expected_unlink_id,outcome,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,linkId,journalId,financeEntryId,expectedLinkId,expectedUnlinkId,outcome,now);
  return {...base,link:linkId?byId(db,linkId)!:null,outcome,created};
 }).immediate();
}
type UnlinkOutcome='corrected'|'already_corrected';
export type LedgerFinanceUnlinkResult={requestId:string;journalId:string;linkId:string;requestedReason:string;outcome:UnlinkOutcome;link:LedgerFinanceLink;created:boolean};
export function unlinkLedgerFinance(db:Database.Database,journalId:string,linkId:string,input:unknown,now:string):LedgerFinanceUnlinkResult{
 checkedId(journalId);checkedId(linkId);const item=inputRecord(input),id=checkedId(item.id);checkTime(now);
 if(typeof item.reason!=='string'||/[\u0000-\u001f\u007f]/.test(item.reason)||!item.reason.trim()||item.reason.trim().length>250)throw new LedgerValidationError('Begründung ist ungültig.');
 const reason=item.reason.trim();return db.transaction(()=>{
  const prior=db.prepare('SELECT link_id AS linkId,journal_id AS journalId,reason,outcome FROM ug_ledger_finance_unlink_requests WHERE id=?').get(id) as {linkId:string;journalId:string;reason:string;outcome:UnlinkOutcome}|undefined;
  const base={requestId:id,journalId,linkId,requestedReason:reason};
  if(prior){if(prior.linkId!==linkId||prior.journalId!==journalId||prior.reason!==reason)throw new LedgerConflict('Diese Korrektur-ID wurde bereits anders verwendet.');const link=byId(db,linkId);if(!link||link.journalId!==journalId)throw new Error('Korrekturbeleg ist beschädigt.');return {...base,link,outcome:prior.outcome,created:false};}
  const link=byId(db,linkId);if(!link||link.journalId!==journalId)throw new LedgerNotFound('Zuordnung nicht gefunden.');
  if(db.prepare('SELECT 1 FROM ug_ledger_finance_unlinks WHERE id=?').get(id))throw new LedgerConflict('Diese Korrektur-ID wurde bereits anders verwendet.');
  const outcome:UnlinkOutcome=link.unlinkId?'already_corrected':'corrected';
  if(outcome==='corrected')db.prepare('INSERT INTO ug_ledger_finance_unlinks(id,link_id,reason,created_at) VALUES(?,?,?,?)').run(id,linkId,reason,now);
  db.prepare('INSERT INTO ug_ledger_finance_unlink_requests(id,link_id,journal_id,reason,outcome,created_at) VALUES(?,?,?,?,?,?)').run(id,linkId,journalId,reason,outcome,now);
  return {...base,link:byId(db,linkId)!,outcome,created:outcome==='corrected'};
 }).immediate();
}
