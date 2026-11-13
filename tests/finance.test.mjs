import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {MAX_AMOUNT_CENTS,parseEuroCents,parseFinanceDraft,parseFinanceReversal} from '../lib/finance.ts';
import {ensureFinanceSchema,createFinanceEntry,reverseFinanceEntry,listFinance,FinanceConflict,FinanceNotFound} from '../lib/finance-store.ts';
const entryId='12c3267c-c343-41d1-8245-2a88107e7213';
const reversalId='32c3267c-c343-41d1-8245-2a88107e7213';
const channelId='22c3267c-c343-41d1-8245-2a88107e7213';
const draft={id:entryId,direction:'income',amountCents:1234,occurredOn:'2024-02-29',description:'  Videoumsatz  ',counterparty:'  Firma ',reference:' R-42 ',channelId};
function database(){const d=new Database(':memory:');d.exec('CREATE TABLE channels(id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL)');d.prepare('INSERT INTO channels VALUES(?,?,?)').run(channelId,'Testkanal','youtube');ensureFinanceSchema(d);return d;}
test('EUR input uses integer cents and rejects ambiguous or invalid values',()=>{
 assert.equal(parseEuroCents('12,3'),1230);assert.equal(parseEuroCents('0.01'),1);assert.equal(parseEuroCents('99999999,99'),MAX_AMOUNT_CENTS);
 for(const bad of ['','-1','0','0,00','1,234','1.000,00','1e4','NaN','100000000','01,00'])assert.equal(parseEuroCents(bad),null);
});
test('draft and reversal validation reject invalid dates, IDs, fields and amounts',()=>{
 const parsed=parseFinanceDraft(draft);assert.equal(parsed.description,'Videoumsatz');assert.equal(parsed.counterparty,'Firma');
 for(const patch of [{occurredOn:'2023-02-29'},{occurredOn:'2024-13-01'},{amountCents:0},{amountCents:1.5},{amountCents:MAX_AMOUNT_CENTS+1},{description:' '},{direction:'other'},{channelId:'x'},{counterparty:'x\n'}])assert.throws(()=>parseFinanceDraft({...draft,...patch}));
 assert.throws(()=>parseFinanceReversal({id:reversalId,entryId,reason:' '}));
 assert.throws(()=>parseFinanceReversal({id:entryId,entryId,reason:'Fehler'}));
});
test('draft records are idempotent, immutable and retain channel snapshots',()=>{
 const d=database(),item=parseFinanceDraft(draft);const first=createFinanceEntry(d,item,'2026-11-13T20:00:00Z');assert.equal(first.created,true);assert.equal(first.entry.channelName,'Testkanal');assert.equal(first.entry.channelPlatform,'youtube');
 d.prepare('UPDATE channels SET name=? WHERE id=?').run('Neu',channelId);
 assert.equal(createFinanceEntry(d,item,'2026-11-13T20:01:00Z').created,false);
 assert.throws(()=>createFinanceEntry(d,{...item,amountCents:2},'2026-11-13T20:01:00Z'),FinanceConflict);
 assert.throws(()=>createFinanceEntry(d,{...item,id:reversalId,channelId:'42c3267c-c343-41d1-8245-2a88107e7213'},'2026-11-13T20:01:00Z'),FinanceNotFound);
 assert.throws(()=>d.prepare('UPDATE finance_entries SET amount_cents=1 WHERE id=?').run(entryId),/cannot be updated/);
 assert.throws(()=>d.prepare('DELETE FROM finance_entries WHERE id=?').run(entryId),/cannot be deleted/);
 assert.equal(listFinance(d,null).entries[0].channelName,'Testkanal');d.close();
});
test('reversal appends a single traceable event and replay remains safe',()=>{
 const d=database();createFinanceEntry(d,parseFinanceDraft(draft),'2026-11-13T20:00:00Z');const input=parseFinanceReversal({id:reversalId,entryId,reason:'Falscher Betrag'});
 assert.equal(reverseFinanceEntry(d,input,'2026-11-13T20:01:00Z').created,true);
 assert.equal(reverseFinanceEntry(d,input,'2026-11-13T20:02:00Z').created,false);
 assert.throws(()=>reverseFinanceEntry(d,{...input,id:'52c3267c-c343-41d1-8245-2a88107e7213'},'2026-11-13T20:03:00Z'),FinanceConflict);
 const rows=listFinance(d,null).entries;assert.equal(rows.length,2);assert.equal(rows[0].reversedEntryId,entryId);assert.equal(rows[0].reversalReason,'Falscher Betrag');assert.equal(rows[1].reversed,true);d.close();
});
test('pagination visits each event once without deleting records',()=>{
 const d=database();for(let n=0;n<4;n++){const id=`${String(n).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`;createFinanceEntry(d,{...parseFinanceDraft(draft),id},'2026-11-13T20:00:00Z');}
 const first=listFinance(d,null,2);assert.equal(first.entries.length,2);assert.ok(first.nextBefore);const second=listFinance(d,first.nextBefore,2);assert.equal(second.entries.length,2);assert.equal(second.nextBefore,null);assert.equal(new Set([...first.entries,...second.entries].map(e=>e.id)).size,4);d.close();
});
test('upgraded finance schema rejects REPLACE by id, rowid or existing reversal target',()=>{
 const d=database();d.pragma('recursive_triggers = OFF');
 const item=parseFinanceDraft(draft);createFinanceEntry(d,item,'2026-11-13T20:00:00Z');
 const reversal=parseFinanceReversal({id:reversalId,entryId,reason:'Falscher Betrag'});reverseFinanceEntry(d,reversal,'2026-11-13T20:01:00Z');
 d.exec('DROP TRIGGER IF EXISTS finance_entries_insert_guard');ensureFinanceSchema(d);
 const before=d.prepare('SELECT rowid,* FROM finance_entries ORDER BY rowid').all();
 const replacement=d.prepare(`INSERT OR REPLACE INTO finance_entries(rowid,id,kind,direction,amount_cents,occurred_on,description,counterparty,reference,channel_id,channel_name,channel_platform,created_at,reversed_entry_id,reversal_reason)
  SELECT ?,?,kind,direction,amount_cents,occurred_on,description,counterparty,reference,channel_id,channel_name,channel_platform,created_at,reversed_entry_id,reversal_reason FROM finance_entries WHERE id=?`);
 const newId='52c3267c-c343-41d1-8245-2a88107e7213';
 assert.throws(()=>replacement.run(null,entryId,entryId),/already exists/);
 assert.throws(()=>replacement.run(before[0].rowid,newId,entryId),/already exists/);
 assert.throws(()=>replacement.run(null,newId,reversalId),/already exists/);
 assert.deepEqual(d.prepare('SELECT rowid,* FROM finance_entries ORDER BY rowid').all(),before);
 assert.equal(createFinanceEntry(d,item,'2026-11-13T21:00:00Z').created,false);
 assert.equal(reverseFinanceEntry(d,reversal,'2026-11-13T21:00:00Z').created,false);d.close();
});
