import type Database from 'better-sqlite3';

/**
 * Isolated double-entry journal prototype, not a finished UG accounting system.
 * It does not implement taxes, periods, closing, document retention, tax exports,
 * statutory reporting or GoBD compliance. Callers must provide trusted server
 * timestamps and protect every future API with authentication and authorization.
 *
 * References: https://www.gesetze-im-internet.de/hgb/__239.html and
 * https://www.gesetze-im-internet.de/gmbhg/__5a.html . Immutability triggers
 * alone do not satisfy these requirements or protect against a database owner.
 */
export const MAX_LEDGER_LINE_CENTS=9_999_999_999;
export const MAX_LEDGER_LINES=128;
export type AccountKind='asset'|'liability'|'equity'|'income'|'expense';
export type LedgerSide='debit'|'credit';
export type LedgerLine={accountId:string;side:LedgerSide;amountCents:number};
export type LedgerAccount={id:string;code:string;name:string;kind:AccountKind;createdAt:string};
export type LedgerJournal={sequence:number;id:string;occurredOn:string;description:string;createdAt:string;kind:'entry'|'reversal';reversalOf:string|null;reversalReason:string|null;lines:LedgerLine[];reversed:boolean};
export type AccountBalance={account:LedgerAccount;debitCents:string;creditCents:string;netDebitCents:string};
export class LedgerValidationError extends Error {}
export class LedgerConflict extends Error {}
export class LedgerNotFound extends Error {}

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value:unknown):string {
 if(typeof value!=='string'||!idPattern.test(value))throw new LedgerValidationError('Ungültige ID.');
 return value.toLowerCase();
}
function label(value:unknown,name:string,max:number):string {
 if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))throw new LedgerValidationError(`${name} ist ungültig.`);
 const result=value.trim();
 if(!result||result.length>max)throw new LedgerValidationError(`${name} ist ungültig.`);
 return result;
}
function day(value:unknown):string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new LedgerValidationError('Datum ist ungültig.');
 const [year,month,date]=value.split('-').map(Number);const d=new Date(Date.UTC(year,month-1,date));
 if(year<1900||year>9999||d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==date)throw new LedgerValidationError('Datum ist ungültig.');
 return value;
}
function timestamp(value:string):string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw new LedgerValidationError('Zeitstempel ist ungültig.');
 const canonical=value.length===20?value.slice(0,-1)+'.000Z':value;
 if(new Date(value).toISOString()!==canonical)throw new LedgerValidationError('Zeitstempel ist ungültig.');
 return value;
}
function object(input:unknown):Record<string,unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new LedgerValidationError('Ungültige Eingabe.');
 return input as Record<string,unknown>;
}
function parseAccount(input:unknown):Omit<LedgerAccount,'createdAt'>{
 const data=object(input);const code=label(data.code,'Kontonummer',30).toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9._-]*$/.test(code))throw new LedgerValidationError('Kontonummer ist ungültig.');
 if(!['asset','liability','equity','income','expense'].includes(String(data.kind)))throw new LedgerValidationError('Kontoart ist ungültig.');
 return {id:id(data.id),code,name:label(data.name,'Kontoname',160),kind:data.kind as AccountKind};
}
function parseLines(value:unknown):LedgerLine[]{
 if(!Array.isArray(value)||value.length<2||value.length>MAX_LEDGER_LINES)throw new LedgerValidationError('Eine Buchung benötigt mindestens zwei und höchstens 128 Zeilen.');
 const lines=value.map(raw=>{
  const line=object(raw),accountId=id(line.accountId);
  if(line.side!=='debit'&&line.side!=='credit')throw new LedgerValidationError('Soll oder Haben ist ungültig.');
  if(!Number.isSafeInteger(line.amountCents)||Number(line.amountCents)<=0||Number(line.amountCents)>MAX_LEDGER_LINE_CENTS)throw new LedgerValidationError('Betrag muss ein gültiger positiver Centbetrag sein.');
  return {accountId,side:line.side,amountCents:Number(line.amountCents)} as LedgerLine;
 });
 if(new Set(lines.map(line=>line.accountId)).size<2)throw new LedgerValidationError('Mindestens zwei verschiedene Konten sind erforderlich.');
 let debit=0n,credit=0n;
 for(const line of lines){if(line.side==='debit')debit+=BigInt(line.amountCents);else credit+=BigInt(line.amountCents);}
 if(debit===0n||debit!==credit)throw new LedgerValidationError('Soll und Haben müssen exakt ausgeglichen sein.');
 return lines;
}
export function parseLedgerEntry(input:unknown):{id:string;occurredOn:string;description:string;lines:LedgerLine[]}{
 const data=object(input);
 return {id:id(data.id),occurredOn:day(data.occurredOn),description:label(data.description,'Beschreibung',250),lines:parseLines(data.lines)};
}
function parseReversal(input:unknown):{id:string;entryId:string;occurredOn:string;reason:string}{
 const data=object(input),result={id:id(data.id),entryId:id(data.entryId),occurredOn:day(data.occurredOn),reason:label(data.reason,'Stornogrund',250)};
 if(result.id===result.entryId)throw new LedgerValidationError('Storno und Original benötigen verschiedene IDs.');
 return result;
}

/** Rows and account definitions are immutable through the application schema.
 * One complete entry, including its balanced lines, is committed as one row so
 * no externally observable half-posting exists. SQLite JSON1 is required. */
export const UG_LEDGER_SCHEMA=`
 CREATE TABLE IF NOT EXISTS ug_ledger_accounts (
  id TEXT PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('asset','liability','equity','income','expense')),
  created_at TEXT NOT NULL,
  CHECK(length(id)=36 AND id=lower(id) AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(code) BETWEEN 1 AND 30 AND code=upper(code) AND code NOT GLOB '*[^A-Z0-9._-]*' AND substr(code,1,1) GLOB '[A-Z0-9]' AND length(trim(name)) BETWEEN 1 AND 160)
 );
 CREATE TABLE IF NOT EXISTS ug_ledger_journals (
  id TEXT PRIMARY KEY, occurred_on TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('entry','reversal')), reversal_of TEXT UNIQUE, reversal_reason TEXT,
  lines_json TEXT NOT NULL CHECK(json_valid(lines_json) AND json_type(lines_json)='array'),
  CHECK(length(id)=36 AND id=lower(id) AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(trim(description)) BETWEEN 1 AND 250),
  CHECK(occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(occurred_on,1,4)>='1900' AND COALESCE(date(occurred_on,'+0 days'),'')=occurred_on),
  CHECK((kind='entry' AND reversal_of IS NULL AND reversal_reason IS NULL) OR (kind='reversal' AND reversal_of IS NOT NULL AND reversal_of<>id AND reversal_reason IS NOT NULL AND length(trim(reversal_reason)) BETWEEN 1 AND 250))
 );
 CREATE INDEX IF NOT EXISTS ug_ledger_journals_date_idx ON ug_ledger_journals(occurred_on,id);
 -- Separate trigger names ensure existing databases acquire the rowid protection.
 CREATE TRIGGER IF NOT EXISTS ug_ledger_accounts_rowid_guard BEFORE INSERT ON ug_ledger_accounts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_accounts WHERE rowid=NEW.rowid) THEN RAISE(ABORT,'account rowid already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_journals_rowid_guard BEFORE INSERT ON ug_ledger_journals BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_journals WHERE rowid=NEW.rowid) THEN RAISE(ABORT,'journal rowid already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_accounts_insert_guard BEFORE INSERT ON ug_ledger_accounts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_accounts WHERE id=NEW.id OR code=NEW.code COLLATE NOCASE) THEN RAISE(ABORT,'account already exists') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_accounts_no_update BEFORE UPDATE ON ug_ledger_accounts BEGIN SELECT RAISE(ABORT,'ledger accounts cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_accounts_no_delete BEFORE DELETE ON ug_ledger_accounts BEGIN SELECT RAISE(ABORT,'ledger accounts cannot be deleted'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_journals_insert_guard BEFORE INSERT ON ug_ledger_journals BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ug_ledger_journals WHERE id=NEW.id) THEN RAISE(ABORT,'journal already exists') END;
  SELECT CASE WHEN NEW.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM ug_ledger_journals WHERE reversal_of=NEW.reversal_of) THEN RAISE(ABORT,'journal already reversed') END;
  SELECT CASE WHEN NOT json_valid(NEW.lines_json) THEN RAISE(ABORT,'invalid journal lines') END;
  SELECT CASE WHEN json_type(NEW.lines_json)<>'array' OR json_array_length(NEW.lines_json)<2 OR json_array_length(NEW.lines_json)>128 THEN RAISE(ABORT,'invalid journal line count') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.lines_json) AS l WHERE
    json_type(l.value)<>'object' OR COALESCE(json_type(l.value,'$.accountId'),'')<>'text' OR
    COALESCE(json_type(l.value,'$.side'),'')<>'text' OR COALESCE(json_extract(l.value,'$.side'),'') NOT IN ('debit','credit') OR
    COALESCE(json_type(l.value,'$.amountCents'),'')<>'integer' OR json_extract(l.value,'$.amountCents')<=0 OR json_extract(l.value,'$.amountCents')>9999999999 OR
    NOT EXISTS(SELECT 1 FROM ug_ledger_accounts a WHERE a.id=json_extract(l.value,'$.accountId'))
   ) THEN RAISE(ABORT,'invalid journal line') END;
  SELECT CASE WHEN (SELECT COUNT(DISTINCT json_extract(l.value,'$.accountId')) FROM json_each(NEW.lines_json) AS l)<2 THEN RAISE(ABORT,'journal requires distinct accounts') END;
  SELECT CASE WHEN (SELECT SUM(CASE WHEN json_extract(l.value,'$.side')='debit' THEN json_extract(l.value,'$.amountCents') ELSE -json_extract(l.value,'$.amountCents') END) FROM json_each(NEW.lines_json) AS l)<>0 THEN RAISE(ABORT,'journal not balanced') END;
  SELECT CASE WHEN NEW.kind='reversal' AND NOT EXISTS(SELECT 1 FROM ug_ledger_journals j WHERE j.id=NEW.reversal_of AND j.kind='entry') THEN RAISE(ABORT,'original journal not found') END;
  SELECT CASE WHEN NEW.kind='reversal' AND NEW.description IS NOT (SELECT j.description FROM ug_ledger_journals j WHERE j.id=NEW.reversal_of) THEN RAISE(ABORT,'invalid reversal description') END;
  SELECT CASE WHEN NEW.kind='reversal' AND json_array_length(NEW.lines_json)<>(SELECT json_array_length(j.lines_json) FROM ug_ledger_journals j WHERE j.id=NEW.reversal_of) THEN RAISE(ABORT,'invalid reversal lines') END;
  SELECT CASE WHEN NEW.kind='reversal' AND EXISTS(
   SELECT 1 FROM json_each(NEW.lines_json) AS n LEFT JOIN json_each((SELECT j.lines_json FROM ug_ledger_journals j WHERE j.id=NEW.reversal_of)) AS o ON n.key=o.key
   WHERE o.key IS NULL OR json_extract(n.value,'$.accountId') IS NOT json_extract(o.value,'$.accountId') OR json_extract(n.value,'$.amountCents') IS NOT json_extract(o.value,'$.amountCents') OR json_extract(n.value,'$.side') IS NOT CASE json_extract(o.value,'$.side') WHEN 'debit' THEN 'credit' ELSE 'debit' END
  ) THEN RAISE(ABORT,'invalid reversal lines') END;
 END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_journals_no_update BEFORE UPDATE ON ug_ledger_journals BEGIN SELECT RAISE(ABORT,'journal entries cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS ug_ledger_journals_no_delete BEFORE DELETE ON ug_ledger_journals BEGIN SELECT RAISE(ABORT,'journal entries cannot be deleted'); END;
`;
export function ensureUgLedgerSchema(database:Database.Database):void {database.exec(UG_LEDGER_SCHEMA);}
const accountColumns='id,code,name,kind,created_at AS createdAt';
function accountById(database:Database.Database,accountId:string):LedgerAccount|undefined{return database.prepare(`SELECT ${accountColumns} FROM ug_ledger_accounts WHERE id=?`).get(accountId) as LedgerAccount|undefined;}
export function createLedgerAccount(database:Database.Database,input:unknown,now:string):{account:LedgerAccount;created:boolean}{
 const item=parseAccount(input),createdAt=timestamp(now);
 return database.transaction(()=>{
  const existing=accountById(database,item.id);
  if(existing){if(existing.code!==item.code||existing.name!==item.name||existing.kind!==item.kind)throw new LedgerConflict('Diese Konto-ID wurde bereits anders verwendet.');return {account:existing,created:false};}
  if(database.prepare('SELECT 1 FROM ug_ledger_accounts WHERE code=? COLLATE NOCASE').get(item.code))throw new LedgerConflict('Diese Kontonummer existiert bereits.');
  database.prepare('INSERT INTO ug_ledger_accounts(id,code,name,kind,created_at) VALUES(?,?,?,?,?)').run(item.id,item.code,item.name,item.kind,createdAt);
  return {account:accountById(database,item.id)!,created:true};
 })();
}
type JournalRow={sequence:number;id:string;occurredOn:string;description:string;createdAt:string;kind:'entry'|'reversal';reversalOf:string|null;reversalReason:string|null;linesJson:string;reversed:number};
const journalColumns=`j.rowid AS sequence,j.id,j.occurred_on AS occurredOn,j.description,j.created_at AS createdAt,j.kind,j.reversal_of AS reversalOf,j.reversal_reason AS reversalReason,j.lines_json AS linesJson,EXISTS(SELECT 1 FROM ug_ledger_journals r WHERE r.reversal_of=j.id) AS reversed`;
function journalById(database:Database.Database,entryId:string):JournalRow|undefined{return database.prepare(`SELECT ${journalColumns} FROM ug_ledger_journals j WHERE j.id=?`).get(entryId) as JournalRow|undefined;}
function present(row:JournalRow):LedgerJournal {const {linesJson,reversed,...rest}=row;return {...rest,lines:parseLines(JSON.parse(linesJson)),reversed:!!reversed};}
function checkAccounts(database:Database.Database,lines:LedgerLine[]):void {
 const statement=database.prepare('SELECT 1 FROM ug_ledger_accounts WHERE id=?');
 if(lines.some(line=>!statement.get(line.accountId)))throw new LedgerNotFound('Konto nicht gefunden.');
}
export function postLedgerJournal(database:Database.Database,input:unknown,now:string):{journal:LedgerJournal;created:boolean}{
 const item=parseLedgerEntry(input),createdAt=timestamp(now),linesJson=JSON.stringify(item.lines);
 return database.transaction(()=>{
  const existing=journalById(database,item.id);
  if(existing){if(existing.kind!=='entry'||existing.occurredOn!==item.occurredOn||existing.description!==item.description||existing.linesJson!==linesJson)throw new LedgerConflict('Diese Buchungs-ID wurde bereits anders verwendet.');return {journal:present(existing),created:false};}
  checkAccounts(database,item.lines);
  database.prepare('INSERT INTO ug_ledger_journals(id,occurred_on,description,created_at,kind,lines_json) VALUES(?,?,?,?,?,?)').run(item.id,item.occurredOn,item.description,createdAt,'entry',linesJson);
  return {journal:present(journalById(database,item.id)!),created:true};
 })();
}
export function reverseLedgerJournal(database:Database.Database,input:unknown,now:string):{journal:LedgerJournal;created:boolean}{
 const item=parseReversal(input),createdAt=timestamp(now);
 return database.transaction(()=>{
  const existing=journalById(database,item.id);
  if(existing){if(existing.kind!=='reversal'||existing.reversalOf!==item.entryId||existing.occurredOn!==item.occurredOn||existing.reversalReason!==item.reason)throw new LedgerConflict('Diese Storno-ID wurde bereits anders verwendet.');return {journal:present(existing),created:false};}
  const source=journalById(database,item.entryId);
  if(!source||source.kind!=='entry')throw new LedgerNotFound('Ursprüngliche Buchung nicht gefunden.');
  if(source.reversed)throw new LedgerConflict('Diese Buchung wurde bereits storniert.');
  const lines=present(source).lines.map(line=>({...line,side:(line.side==='debit'?'credit':'debit') as LedgerSide}));
  database.prepare('INSERT INTO ug_ledger_journals(id,occurred_on,description,created_at,kind,reversal_of,reversal_reason,lines_json) VALUES(?,?,?,?,?,?,?,?)').run(item.id,item.occurredOn,source.description,createdAt,'reversal',source.id,item.reason,JSON.stringify(lines));
  return {journal:present(journalById(database,item.id)!),created:true};
 })();
}
export function listLedgerJournals(database:Database.Database,before:number|null=null,limit=50):{journals:LedgerJournal[];nextBefore:number|null}{
 if(before!==null&&(!Number.isSafeInteger(before)||before<=0))throw new LedgerValidationError('Ungültige Seitenposition.');
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new LedgerValidationError('Ungültige Seitengröße.');
 const rows=database.prepare(`SELECT ${journalColumns} FROM ug_ledger_journals j WHERE (? IS NULL OR j.rowid<?) ORDER BY j.rowid DESC LIMIT ?`).all(before,before,limit+1) as JournalRow[];
 const page=rows.slice(0,limit);return {journals:page.map(present),nextBefore:rows.length>limit?page[page.length-1].sequence:null};
}
/** Totals are decimal cent strings, avoiding JS floating point and JSON bigint limits. */
export function ledgerBalances(database:Database.Database):AccountBalance[]{
 const accounts=database.prepare(`SELECT ${accountColumns} FROM ug_ledger_accounts ORDER BY code,id`).all() as LedgerAccount[];
 const totals=new Map(accounts.map(account=>[account.id,{debit:0n,credit:0n}]));
 for(const row of database.prepare('SELECT lines_json AS linesJson FROM ug_ledger_journals ORDER BY rowid').iterate() as Iterable<{linesJson:string}>) {
  for(const line of parseLines(JSON.parse(row.linesJson))){const t=totals.get(line.accountId);if(!t)throw new LedgerNotFound('Konto einer Buchung fehlt.');if(line.side==='debit')t.debit+=BigInt(line.amountCents);else t.credit+=BigInt(line.amountCents);}
 }
 return accounts.map(account=>{const t=totals.get(account.id)!;return {account,debitCents:t.debit.toString(),creditCents:t.credit.toString(),netDebitCents:(t.debit-t.credit).toString()};});
}
