import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import Database from 'better-sqlite3';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.includes('/lib/')&&['./finance','./finance-store','./finance-documents','./ug-ledger'].includes(specifier))return next(`${specifier}.ts`,context);
 return next(specifier,context);
}});
const {ensureFinanceSchema,createFinanceEntry}=await import('../lib/finance-store.ts');
const {ensureFinanceDocumentsSchema,storeFinanceDocument}=await import('../lib/finance-documents.ts');
const {ensureUgLedgerSchema,createLedgerAccount,postLedgerJournal,LedgerConflict,LedgerNotFound}=await import('../lib/ug-ledger.ts');
const {ensureLedgerDocumentsSchema,listLedgerDocumentOptions,listLedgerDocumentLinks,attachLedgerDocument,unlinkLedgerDocument,readLinkedLedgerDocument}=await import('../lib/ug-ledger-documents.ts');
const now='2026-11-13T20:00:00.000Z';
function setup(){
 const db=new Database(':memory:');db.pragma('recursive_triggers=OFF');db.exec('CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,platform TEXT)');ensureFinanceSchema(db);ensureFinanceDocumentsSchema(db);ensureUgLedgerSchema(db);ensureLedgerDocumentsSchema(db);
 const entry=randomUUID(),doc=randomUUID().toUpperCase(),journal=randomUUID(),a=randomUUID(),b=randomUUID();
 createFinanceEntry(db,{id:entry,direction:'expense',amountCents:500,occurredOn:'2026-11-13',description:'Belegvorgang',counterparty:'',reference:'',channelId:null},now);
 const data=Buffer.from('Original PDF bytes');const document=storeFinanceDocument(db,{id:doc,entryId:entry,originalName:'Original.pdf',data},now).document;
 for(const [id,code] of [[a,'1200'],[b,'4000']])createLedgerAccount(db,{id,code,name:code,kind:'asset'},now);
 postLedgerJournal(db,{id:journal,occurredOn:'2026-11-13',description:'Journal',lines:[{accountId:a,side:'debit',amountCents:500},{accountId:b,side:'credit',amountCents:500}]},now);
 return {db,entry,doc,journal,a,b,data,document,body:{id:randomUUID(),documentId:doc,financeEntryId:entry,sha256:document.sha256}};
}
test('binds only a verified original and repeats idempotently without new events',()=>{
 const x=setup();const {db,journal,body}=x;
 assert.equal(listLedgerDocumentOptions(db,null).documents[0].id,x.doc);
 assert.equal(attachLedgerDocument(db,journal,body,now).created,true);
 assert.equal(attachLedgerDocument(db,journal,body,now).created,false);
 assert.throws(()=>attachLedgerDocument(db,journal,{...body,sha256:'0'.repeat(64)},now),LedgerConflict);
 assert.throws(()=>attachLedgerDocument(db,journal,{...body,id:randomUUID()},now),LedgerConflict);
 assert.throws(()=>attachLedgerDocument(db,randomUUID(),{...body,id:randomUUID()},now),LedgerNotFound);
 assert.equal(listLedgerDocumentLinks(db,journal).length,1);
 assert.deepEqual(readLinkedLedgerDocument(db,body.id).data,x.data);db.close();
});
test('selection hash is checked in the transaction and missing inputs do not create events',()=>{
 const x=setup(),{db,journal,body}=x;
 assert.throws(()=>attachLedgerDocument(db,journal,{...body,sha256:'f'.repeat(64)},now),LedgerConflict);
 assert.throws(()=>attachLedgerDocument(db,journal,{...body,documentId:randomUUID()},now),LedgerNotFound);
 assert.equal(listLedgerDocumentLinks(db,journal).length,0);db.close();
});
test('corrections are append-only, replay-safe and permit a later new link',()=>{
 const x=setup(),{db,journal,body}=x;attachLedgerDocument(db,journal,body,now);
 const correction={id:randomUUID(),reason:'Falscher Beleg'};
 const c=unlinkLedgerDocument(db,journal,body.id,correction,now);assert.equal(c.created,true);assert.equal(c.link.unlinkReason,correction.reason);
 assert.equal(unlinkLedgerDocument(db,journal,body.id,correction,now).created,false);
 assert.throws(()=>unlinkLedgerDocument(db,journal,body.id,{...correction,reason:'Andere'},now),LedgerConflict);
 assert.throws(()=>unlinkLedgerDocument(db,journal,body.id,{...correction,id:randomUUID()},now),LedgerConflict);
 assert.equal(attachLedgerDocument(db,journal,{...body,id:randomUUID()},now).created,true);
 assert.equal(listLedgerDocumentLinks(db,journal).length,2);assert.deepEqual(readLinkedLedgerDocument(db,body.id).data,x.data);db.close();
});
test('SQL cannot forge, delete or replace links and corrections, including by rowid',()=>{
 const x=setup(),{db,journal,body}=x;attachLedgerDocument(db,journal,body,now);
 assert.throws(()=>db.prepare('UPDATE ug_ledger_document_links SET original_name=? WHERE id=?').run('fake',body.id),/cannot be updated/);
 assert.throws(()=>db.prepare('DELETE FROM ug_ledger_document_links WHERE id=?').run(body.id),/cannot be deleted/);
 const row=db.prepare('SELECT rowid,* FROM ug_ledger_document_links WHERE id=?').get(body.id);
 const insert=db.prepare('INSERT OR REPLACE INTO ug_ledger_document_links(rowid,id,journal_id,document_id,finance_entry_id,sha256,original_name,size,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
 assert.throws(()=>insert.run(row.rowid,randomUUID(),journal,x.doc,x.entry,x.document.sha256,'Original.pdf',x.data.length,now),/rowid already exists/);
 assert.throws(()=>insert.run(999,randomUUID(),journal,x.doc,x.entry,'0'.repeat(64),'Original.pdf',x.data.length,now),/snapshot mismatch/);
 const correction={id:randomUUID(),reason:'Korrektur'};unlinkLedgerDocument(db,journal,body.id,correction,now);
 const u=db.prepare('SELECT rowid FROM ug_ledger_document_unlinks WHERE id=?').get(correction.id);
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO ug_ledger_document_unlinks(rowid,id,link_id,reason,created_at) VALUES(?,?,?,?,?)').run(u.rowid,randomUUID(),body.id,'Andere',now),/already exists/);
 assert.throws(()=>db.prepare('DELETE FROM ug_ledger_document_unlinks WHERE id=?').run(correction.id),/cannot be deleted/);db.close();
});
test('replaced originals are refused even when attacker also changes the stored checksum',()=>{
 const x=setup(),{db,journal,body}=x;attachLedgerDocument(db,journal,body,now);
 // Simulate a privileged actor able to bypass the original document table's triggers.
 for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='finance_documents'").all())db.exec(`DROP TRIGGER "${row.name}"`);
 const data=Buffer.from('Substituted PDF!');const hash=createHash('sha256').update(data).digest('hex');
 db.prepare('UPDATE finance_documents SET data=?,size=?,sha256=? WHERE id=?').run(data,data.length,hash,x.doc);
 assert.throws(()=>readLinkedLedgerDocument(db,body.id),LedgerConflict);
 assert.throws(()=>attachLedgerDocument(db,journal,body,now),LedgerConflict);
 assert.equal(listLedgerDocumentLinks(db,journal)[0].sha256,x.document.sha256);db.close();
});
test('existing account and journal tables reject rowid replacement with recursive triggers off',()=>{
 const x=setup(),{db}=x;ensureUgLedgerSchema(db);
 const a=db.prepare('SELECT rowid FROM ug_ledger_accounts WHERE id=?').get(x.a).rowid;
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO ug_ledger_accounts(rowid,id,code,name,kind,created_at) VALUES(?,?,?,?,?,?)').run(a,randomUUID(),'9999','Andere','asset',now),/rowid already exists/);
 const j=db.prepare('SELECT rowid,lines_json FROM ug_ledger_journals WHERE id=?').get(x.journal);
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO ug_ledger_journals(rowid,id,occurred_on,description,created_at,kind,lines_json) VALUES(?,?,?,?,?,?,?)').run(j.rowid,randomUUID(),'2026-11-13','Andere',now,'entry',j.lines_json),/rowid already exists/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ug_ledger_journals').get().n,1);db.close();
});
