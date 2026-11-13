/** Recovery protocol shared by the journal UI and small unit tests. */
export type JournalAction='account'|'entry'|'reversal'|'document-link'|'document-unlink';
export type PendingJournal={version:1;action:JournalAction;body:Record<string,unknown>;uncertain:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const financeUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function parsePendingJournal(raw:string):PendingJournal{
 if(raw.length>65536)throw new Error('Gespeicherter Vorgang ist ungültig.');
 let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('Gespeicherter Vorgang ist ungültig.');}
 if(!record(value)||value.version!==1||!['account','entry','reversal','document-link','document-unlink'].includes(String(value.action))||typeof value.uncertain!=='boolean'||!record(value.body)||typeof value.body.id!=='string'||!uuid.test(value.body.id))throw new Error('Gespeicherter Vorgang ist ungültig.');
 if(value.action==='account'&&(typeof value.body.code!=='string'||typeof value.body.name!=='string'||typeof value.body.kind!=='string'))throw new Error('Gespeicherter Vorgang ist ungültig.');
 if(value.action==='entry'&&(typeof value.body.occurredOn!=='string'||typeof value.body.description!=='string'||!Array.isArray(value.body.lines)||value.body.lines.length<2||value.body.lines.length>128))throw new Error('Gespeicherter Vorgang ist ungültig.');
 if(value.action==='reversal'&&(typeof value.body.entryId!=='string'||!uuid.test(value.body.entryId)||typeof value.body.occurredOn!=='string'||typeof value.body.reason!=='string'))throw new Error('Gespeicherter Vorgang ist ungültig.');
 if((value.action==='document-link'||value.action==='document-unlink')&&(typeof value.body.journalId!=='string'||!uuid.test(value.body.journalId)))throw new Error('Gespeicherter Vorgang ist ungültig.');
 if(value.action==='document-link'&&(typeof value.body.documentId!=='string'||!financeUuid.test(value.body.documentId)||typeof value.body.financeEntryId!=='string'||!financeUuid.test(value.body.financeEntryId)||typeof value.body.sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.body.sha256)))throw new Error('Gespeicherter Vorgang ist ungültig.');
 if(value.action==='document-unlink'&&(typeof value.body.linkId!=='string'||!uuid.test(value.body.linkId)||typeof value.body.reason!=='string'||!value.body.reason.trim()||value.body.reason.length>250))throw new Error('Gespeicherter Vorgang ist ungültig.');
 return value as PendingJournal;
}
function confirms(pending:PendingJournal,data:unknown):boolean{
 if(!record(data)||typeof data.created!=='boolean')return false;
 if(pending.action==='document-link'||pending.action==='document-unlink'){
  const link=data.link;if(!record(link)||link.journalId!==pending.body.journalId)return false;
  if(pending.action==='document-link')return link.id===pending.body.id&&link.documentId===pending.body.documentId&&link.financeEntryId===pending.body.financeEntryId&&link.sha256===pending.body.sha256;
  return link.id===pending.body.linkId&&link.unlinkId===pending.body.id&&link.unlinkReason===pending.body.reason;
 }
 const item=pending.action==='account'?data.account:data.journal;
 if(!record(item)||item.id!==pending.body.id)return false;
 if(pending.action==='account')return item.code===pending.body.code&&item.name===pending.body.name&&item.kind===pending.body.kind;
 if(pending.action==='entry')return item.kind==='entry'&&item.occurredOn===pending.body.occurredOn&&item.description===pending.body.description&&Array.isArray(item.lines)&&JSON.stringify(item.lines)===JSON.stringify(pending.body.lines);
 return item.kind==='reversal'&&item.reversalOf===pending.body.entryId&&item.occurredOn===pending.body.occurredOn&&item.reversalReason===pending.body.reason;
}
/** Never discard an uncertain earlier request on a later 4xx, including 401/403. */
export function journalResponseDecision(pending:PendingJournal,status:number,data:unknown):'confirmed'|'reauth'|'rejected'|'retain'{
 if(status>=200&&status<300)return confirms(pending,data)?'confirmed':'retain';
 if(status===401||status===403)return 'reauth';
 if(!pending.uncertain&&(status===400||status===404||status===409)&&record(data)&&typeof data.error==='string')return 'rejected';
 return 'retain';
}
