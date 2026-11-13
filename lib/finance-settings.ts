import type Database from 'better-sqlite3';
import type {FinanceSettingsDraft,FinanceSettingsEvent} from './finance';
import {FinanceConflict} from './finance-store';

/** Stored settings are historical user declarations, not an automated tax assessment. */
export const FINANCE_SETTINGS_SCHEMA=`
 CREATE TABLE IF NOT EXISTS finance_settings_events (
  id TEXT PRIMARY KEY, effective_on TEXT NOT NULL,
  tax_regime TEXT NOT NULL CHECK(tax_regime IN ('regular','small_business')),
  fiscal_mode TEXT NOT NULL CHECK(fiscal_mode IN ('calendar','different')),
  fiscal_start_month INTEGER NOT NULL CHECK(typeof(fiscal_start_month)='integer' AND fiscal_start_month BETWEEN 1 AND 12),
  fiscal_start_day INTEGER NOT NULL CHECK(typeof(fiscal_start_day)='integer' AND fiscal_start_day BETWEEN 1 AND 31),
  reason TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK((fiscal_mode='calendar' AND fiscal_start_month=1 AND fiscal_start_day=1) OR
        (fiscal_mode='different' AND NOT(fiscal_start_month=1 AND fiscal_start_day=1)))
 );
 -- Block replacement by either the primary key or SQLite's implicit rowid.
 CREATE TRIGGER IF NOT EXISTS finance_settings_insert_guard BEFORE INSERT ON finance_settings_events BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM finance_settings_events e WHERE e.id=NEW.id OR e.rowid=NEW.rowid) THEN RAISE(ABORT,'finance settings event already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS finance_settings_no_update BEFORE UPDATE ON finance_settings_events BEGIN SELECT RAISE(ABORT,'finance settings cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS finance_settings_no_delete BEFORE DELETE ON finance_settings_events BEGIN SELECT RAISE(ABORT,'finance settings cannot be deleted'); END;
`;
export function ensureFinanceSettingsSchema(database:Database.Database){database.exec(FINANCE_SETTINGS_SCHEMA);}
const columns=`rowid AS sequence,id,effective_on AS effectiveOn,tax_regime AS taxRegime,fiscal_mode AS fiscalMode,fiscal_start_month AS fiscalStartMonth,fiscal_start_day AS fiscalStartDay,reason,created_at AS createdAt`;
export function listFinanceSettings(database:Database.Database,before:number|null,limit=50):{events:FinanceSettingsEvent[];nextBefore:number|null}{
 const count=Math.max(1,Math.min(100,limit));
 const rows=database.prepare(`SELECT ${columns} FROM finance_settings_events WHERE (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?`).all(before,before,count+1) as FinanceSettingsEvent[];
 const events=rows.slice(0,count);
 return {events,nextBefore:rows.length>count?events[events.length-1].sequence:null};
}
export function createFinanceSettings(database:Database.Database,item:FinanceSettingsDraft,now:string):{event:FinanceSettingsEvent;created:boolean}{
 return database.transaction(()=>{
  const existing=database.prepare(`SELECT ${columns} FROM finance_settings_events WHERE id=?`).get(item.id) as FinanceSettingsEvent|undefined;
  if(existing){
   if(existing.effectiveOn!==item.effectiveOn||existing.taxRegime!==item.taxRegime||existing.fiscalMode!==item.fiscalMode||existing.fiscalStartMonth!==item.fiscalStartMonth||existing.fiscalStartDay!==item.fiscalStartDay||existing.reason!==item.reason)throw new FinanceConflict('Diese Konfigurations-ID wurde bereits anders verwendet.');
   return {event:existing,created:false};
  }
  database.prepare('INSERT INTO finance_settings_events(id,effective_on,tax_regime,fiscal_mode,fiscal_start_month,fiscal_start_day,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(item.id,item.effectiveOn,item.taxRegime,item.fiscalMode,item.fiscalStartMonth,item.fiscalStartDay,item.reason,now);
  return {event:database.prepare(`SELECT ${columns} FROM finance_settings_events WHERE id=?`).get(item.id) as FinanceSettingsEvent,created:true};
 })();
}
