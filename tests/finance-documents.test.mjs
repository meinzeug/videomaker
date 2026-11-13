import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import Database from 'better-sqlite3';
import {MAX_FINANCE_DOCUMENT_BYTES,MAX_FINANCE_DOCUMENTS_PER_ENTRY,validFinanceDocumentName} from '../lib/finance.ts';
import {ensureFinanceSchema,createFinanceEntry,FinanceConflict,FinanceNotFound} from '../lib/finance-store.ts';
// Node's TS stripping does not resolve the extensionless local imports used by Next.js.
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/lib/finance-documents.ts')&&(specifier==='./finance'||specifier==='./finance-store'))return next(`${specifier}.ts`,context);
 return next(specifier,context);
}});
const {ensureFinanceDocumentsSchema,storeFinanceDocument,listFinanceDocuments,readFinanceDocument,FinanceDocumentCorrupt,FinanceDocumentLimit}=await import('../lib/finance-documents.ts');
const entryId='12c3267c-c343-41d1-8245-2a88107e7213';
const documentId='22c3267c-c343-41d1-8245-2a88107e7213';
const otherId='32c3267c-c343-41d1-8245-2a88107e7213';
function database(){const d=new Database(':memory:');d.exec('CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,platform TEXT)');ensureFinanceSchema(d);ensureFinanceDocumentsSchema(d);createFinanceEntry(d,{id:entryId,direction:'expense',amountCents:123,occurredOn:'2026-11-13',description:'Test',counterparty:'',reference:'',channelId:null},'2026-11-13T20:00:00Z');return d;}
test('document filenames reject paths, controls and deceptive direction marks',()=>{
 assert.equal(validFinanceDocumentName('Rechnung ä.xml'),true);
 for(const name of ['', '.', '..','../beleg.xml','a\\b','a\n.pdf','a\u202e.pdf','bad\ud800.xml','x'.repeat(181)])assert.equal(validFinanceDocumentName(name),false);
});
test('XML originals are preserved byte-for-byte and verified using SHA-256',()=>{
 const d=database();const xml=Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>ä &x;</Invoice>\r\n','utf8');
 const result=storeFinanceDocument(d,{id:documentId,entryId,originalName:'Rechnung ä.xml',data:xml},'2026-11-13T20:01:00Z');
 assert.equal(result.created,true);assert.equal(result.document.sha256,createHash('sha256').update(xml).digest('hex'));
 const downloaded=readFinanceDocument(d,entryId,documentId);assert.deepEqual(downloaded.data,xml);assert.equal(downloaded.document.originalName,'Rechnung ä.xml');assert.equal(listFinanceDocuments(d,entryId).length,1);d.close();
});
test('idempotent retries do not overwrite and duplicate content is rejected',()=>{
 const d=database(),input={id:documentId,entryId,originalName:'a.pdf',data:Buffer.from('original')};
 assert.equal(storeFinanceDocument(d,input,'2026-11-13T20:00:00Z').created,true);
 assert.equal(storeFinanceDocument(d,input,'2026-11-13T20:02:00Z').created,false);
 assert.throws(()=>storeFinanceDocument(d,{...input,data:Buffer.from('different')},'2026-11-13T20:03:00Z'),FinanceConflict);
 assert.throws(()=>storeFinanceDocument(d,{...input,originalName:'b.pdf'},'2026-11-13T20:03:00Z'),FinanceConflict);
 assert.throws(()=>storeFinanceDocument(d,{...input,id:otherId},'2026-11-13T20:04:00Z'),FinanceConflict);
 assert.throws(()=>readFinanceDocument(d,otherId,documentId),FinanceNotFound);
 assert.deepEqual(readFinanceDocument(d,entryId,documentId).data,input.data);d.close();
});
test('application schema forbids modification or deletion and detects corruption',()=>{
 const d=database();storeFinanceDocument(d,{id:documentId,entryId,originalName:'a.xml',data:Buffer.from('original')},'2026-11-13T20:00:00Z');
 assert.throws(()=>d.prepare('UPDATE finance_documents SET data=? WHERE id=?').run(Buffer.from('modified'),documentId),/cannot be updated/);
 assert.throws(()=>d.prepare('DELETE FROM finance_documents WHERE id=?').run(documentId),/cannot be deleted/);
 d.exec('DROP TRIGGER finance_documents_no_update');d.prepare('UPDATE finance_documents SET data=? WHERE id=?').run(Buffer.from('modified'),documentId);
 assert.throws(()=>readFinanceDocument(d,entryId,documentId),FinanceDocumentCorrupt);
 assert.throws(()=>storeFinanceDocument(d,{id:documentId,entryId,originalName:'a.xml',data:Buffer.from('original')},'2026-11-13T20:01:00Z'),FinanceDocumentCorrupt);
 assert.deepEqual(d.prepare('SELECT data FROM finance_documents WHERE id=?').get(documentId).data,Buffer.from('modified'));d.close();
});
test('bounded size and entry count protect resources',()=>{
 const d=database();assert.throws(()=>storeFinanceDocument(d,{id:documentId,entryId,originalName:'a',data:Buffer.alloc(0)},''));
 assert.throws(()=>storeFinanceDocument(d,{id:documentId,entryId,originalName:'a',data:Buffer.alloc(MAX_FINANCE_DOCUMENT_BYTES+1)},''));
 for(let n=0;n<MAX_FINANCE_DOCUMENTS_PER_ENTRY;n++){const id=`${String(n).padStart(8,'0')}-c343-41d1-8245-2a88107e7213`;storeFinanceDocument(d,{id,entryId,originalName:`${n}.xml`,data:Buffer.from(`test ${n}`)},'2026-11-13T20:00:00Z');}
 assert.throws(()=>storeFinanceDocument(d,{id:documentId,entryId,originalName:'extra.xml',data:Buffer.from('extra')},''),FinanceDocumentLimit);
 assert.throws(()=>listFinanceDocuments(d,otherId),FinanceNotFound);d.close();
});
