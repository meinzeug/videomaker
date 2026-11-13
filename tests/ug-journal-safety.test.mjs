import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePendingJournal,journalResponseDecision} from '../app/api/ledger/_safety.ts';
const id='44c3267c-c343-41d1-8245-2a88107e7213';
const original={version:1,action:'account',body:{id,code:'1200',name:'Bank',kind:'asset'},uncertain:false};
const ok={created:true,account:{id,code:'1200',name:'Bank',kind:'asset'}};
test('pending state can be recovered with the same request ID',()=>{
 assert.deepEqual(parsePendingJournal(JSON.stringify(original)),original);
 for(const bad of ['bad',JSON.stringify({...original,version:2}),JSON.stringify({...original,body:{id:'wrong'}}),JSON.stringify({...original,uncertain:'false'}),JSON.stringify({...original,action:'delete'})])assert.throws(()=>parsePendingJournal(bad));
});
test('only a matching 2xx with explicit created boolean confirms a write',()=>{
 assert.equal(journalResponseDecision(original,201,ok),'confirmed');
 assert.equal(journalResponseDecision(original,200,{...ok,created:false}),'confirmed');
 assert.equal(journalResponseDecision(original,200,{account:ok.account}),'retain');
 assert.equal(journalResponseDecision(original,200,{...ok,account:{...ok.account,id:'55c3267c-c343-41d1-8245-2a88107e7213'}}),'retain');
 assert.equal(journalResponseDecision(original,200,{...ok,account:{...ok.account,name:'Anders'}}),'retain');
});
test('an uncertain write never loses its ID after later authorization, rate or validation errors',()=>{
 const uncertain={...original,uncertain:true};
 for(const status of [400,404,408,409,429,500])assert.equal(journalResponseDecision(uncertain,status,{error:'Fehler'}),'retain');
 for(const status of [401,403])assert.equal(journalResponseDecision(uncertain,status,{error:'Nicht angemeldet'}),'reauth');
 assert.equal(journalResponseDecision(original,408,{error:'Timeout'}),'retain');
 assert.equal(journalResponseDecision(original,429,{error:'Limit'}),'retain');
 assert.equal(journalResponseDecision(original,400,{error:'Ungültig'}),'rejected');
 assert.equal(journalResponseDecision(original,409,{error:'Kontonummer belegt'}),'rejected');
 assert.equal(journalResponseDecision(original,400,null),'retain');
});
test('journal and reversal receipts match the original details, not just an ID',()=>{
 const lines=[{accountId:id,side:'debit',amountCents:100},{accountId:'55c3267c-c343-41d1-8245-2a88107e7213',side:'credit',amountCents:100}];
 const item={version:1,action:'entry',body:{id,occurredOn:'2026-11-13',description:'Test',lines},uncertain:true};
 const receipt={created:true,journal:{id,kind:'entry',occurredOn:'2026-11-13',description:'Test',lines}};
 assert.equal(journalResponseDecision(item,201,receipt),'confirmed');
 assert.equal(journalResponseDecision(item,201,{...receipt,journal:{...receipt.journal,lines:lines.slice(0,1)}}),'retain');
 const rev={version:1,action:'reversal',body:{id,entryId:'55c3267c-c343-41d1-8245-2a88107e7213',occurredOn:'2026-11-14',reason:'Korrektur'},uncertain:true};
 assert.equal(journalResponseDecision(rev,201,{created:true,journal:{id,kind:'reversal',reversalOf:rev.body.entryId,occurredOn:rev.body.occurredOn,reversalReason:rev.body.reason}}),'confirmed');
});

test('document link and correction receipts must identify the exact durable operation',()=>{
 const journalId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',documentId='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',financeEntryId='33333333-3333-4333-8333-333333333333',sha256='a'.repeat(64);
 const item={version:1,action:'document-link',uncertain:true,body:{id,journalId,documentId,financeEntryId,sha256}};
 assert.deepEqual(parsePendingJournal(JSON.stringify(item)),item);
 const receipt={created:true,link:{id,journalId,documentId,financeEntryId,sha256}};
 assert.equal(journalResponseDecision(item,201,receipt),'confirmed');
 assert.equal(journalResponseDecision(item,200,{...receipt,link:{...receipt.link,sha256:'b'.repeat(64)}}),'retain');
 assert.equal(journalResponseDecision(item,200,{...receipt,created:undefined}),'retain');
 assert.equal(journalResponseDecision(item,409,{error:'no'}),'retain');
 const revoke={version:1,action:'document-unlink',uncertain:true,body:{id:'44444444-4444-4444-8444-444444444444',journalId,linkId:id,reason:'Falscher Beleg'}};
 const canceled={created:false,link:{id,journalId,unlinkId:revoke.body.id,unlinkReason:revoke.body.reason}};
 assert.deepEqual(parsePendingJournal(JSON.stringify(revoke)),revoke);
 assert.equal(journalResponseDecision(revoke,200,canceled),'confirmed');
 assert.equal(journalResponseDecision(revoke,200,{...canceled,link:{...canceled.link,unlinkId:id}}),'retain');
 assert.equal(journalResponseDecision(revoke,403,{error:'no'}),'reauth');
});
