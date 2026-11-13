import type Database from 'better-sqlite3';
import type {FinanceDraft,FinanceEntry,FinanceReversal} from './finance';

/** Only a preliminary journal: immutability alone does not establish legal compliance. */
export const FINANCE_SCHEMA = `
 CREATE TABLE IF NOT EXISTS finance_entries (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('entry','reversal')),
  direction TEXT NOT NULL CHECK(direction IN ('income','expense')),
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0 AND amount_cents<=9999999999),
  occurred_on TEXT NOT NULL, description TEXT NOT NULL, counterparty TEXT NOT NULL,
  reference TEXT NOT NULL, channel_id TEXT, channel_name TEXT, channel_platform TEXT,
  created_at TEXT NOT NULL, reversed_entry_id TEXT UNIQUE, reversal_reason TEXT,
  CHECK((kind='entry' AND reversed_entry_id IS NULL AND reversal_reason IS NULL) OR
        (kind='reversal' AND reversed_entry_id IS NOT NULL AND reversal_reason IS NOT NULL))
 );
 CREATE INDEX IF NOT EXISTS finance_entries_date_idx ON finance_entries(occurred_on,id);
 -- Block implicit deletion by INSERT OR REPLACE even with recursive triggers disabled.
 CREATE TRIGGER IF NOT EXISTS finance_entries_insert_guard BEFORE INSERT ON finance_entries BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM finance_entries e WHERE e.id=NEW.id OR e.rowid=NEW.rowid OR (NEW.reversed_entry_id IS NOT NULL AND e.reversed_entry_id=NEW.reversed_entry_id)) THEN RAISE(ABORT,'finance entry already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS finance_entries_no_update BEFORE UPDATE ON finance_entries BEGIN SELECT RAISE(ABORT,'finance entries cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS finance_entries_no_delete BEFORE DELETE ON finance_entries BEGIN SELECT RAISE(ABORT,'finance entries cannot be deleted'); END;
`;
export function ensureFinanceSchema(database:Database.Database){database.exec(FINANCE_SCHEMA);}
const selectColumns=`e.rowid AS sequence,e.id,e.kind,e.direction,e.amount_cents AS amountCents,e.occurred_on AS occurredOn,e.description,e.counterparty,e.reference,e.channel_id AS channelId,e.channel_name AS channelName,e.channel_platform AS channelPlatform,e.created_at AS createdAt,e.reversed_entry_id AS reversedEntryId,e.reversal_reason AS reversalReason,EXISTS(SELECT 1 FROM finance_entries r WHERE r.reversed_entry_id=e.id) AS reversed`;
type FinanceRow=Omit<FinanceEntry,'reversed'>&{reversed:number};
const getRow=(database:Database.Database,id:string)=>database.prepare(`SELECT ${selectColumns} FROM finance_entries e WHERE e.id=?`).get(id) as FinanceRow|undefined;
const present=(row:FinanceRow):FinanceEntry=>({...row,reversed:!!row.reversed});
export class FinanceConflict extends Error {}
export class FinanceNotFound extends Error {}
export function listFinance(database:Database.Database,before:number|null,limit=50):{entries:FinanceEntry[];nextBefore:number|null}{
 const count=Math.max(1,Math.min(100,limit));
 const rows=database.prepare(`SELECT ${selectColumns} FROM finance_entries e WHERE (? IS NULL OR e.rowid<?) ORDER BY e.rowid DESC LIMIT ?`).all(before,before,count+1) as FinanceRow[];
 const more=rows.length>count;const items=rows.slice(0,count);
 return {entries:items.map(present),nextBefore:more?items[items.length-1].sequence:null};
}
export function createFinanceEntry(database:Database.Database,item:FinanceDraft,now:string):{entry:FinanceEntry;created:boolean}{
 return database.transaction(()=>{
  const existing=getRow(database,item.id);
  if(existing){
   if(existing.kind!=='entry'||existing.direction!==item.direction||existing.amountCents!==item.amountCents||existing.occurredOn!==item.occurredOn||existing.description!==item.description||existing.counterparty!==item.counterparty||existing.reference!==item.reference||existing.channelId!==item.channelId)throw new FinanceConflict('Diese Eintrags-ID wurde bereits anders verwendet.');
   return {entry:present(existing),created:false};
  }
  let channel:{name:string;platform:string}|undefined;
  if(item.channelId){channel=database.prepare('SELECT name,platform FROM channels WHERE id=?').get(item.channelId) as typeof channel;if(!channel)throw new FinanceNotFound('Kanal nicht gefunden.');}
  database.prepare(`INSERT INTO finance_entries(id,kind,direction,amount_cents,occurred_on,description,counterparty,reference,channel_id,channel_name,channel_platform,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id,'entry',item.direction,item.amountCents,item.occurredOn,item.description,item.counterparty,item.reference,item.channelId,channel?.name??null,channel?.platform??null,now);
  return {entry:present(getRow(database,item.id)!),created:true};
 })();
}
export function reverseFinanceEntry(database:Database.Database,item:FinanceReversal,now:string):{entry:FinanceEntry;created:boolean}{
 return database.transaction(()=>{
  const existing=getRow(database,item.id);
  if(existing){if(existing.kind!=='reversal'||existing.reversedEntryId!==item.entryId||existing.reversalReason!==item.reason)throw new FinanceConflict('Diese Eintrags-ID wurde bereits anders verwendet.');return {entry:present(existing),created:false};}
  const original=getRow(database,item.entryId);
  if(!original||original.kind!=='entry')throw new FinanceNotFound('Eintrag nicht gefunden.');
  if(original.reversed)throw new FinanceConflict('Dieser Eintrag wurde bereits storniert.');
  database.prepare(`INSERT INTO finance_entries(id,kind,direction,amount_cents,occurred_on,description,counterparty,reference,channel_id,channel_name,channel_platform,created_at,reversed_entry_id,reversal_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id,'reversal',original.direction,original.amountCents,original.occurredOn,original.description,original.counterparty,original.reference,original.channelId,original.channelName,original.channelPlatform,now,original.id,item.reason);
  return {entry:present(getRow(database,item.id)!),created:true};
 })();
}
