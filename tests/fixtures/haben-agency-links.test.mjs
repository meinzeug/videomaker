// TEST ONLY: dedicated disposable PostgreSQL cluster with synthetic documents and bookings.
import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {sessionRevoked,revokeSession} from '../../lib/session-revocations.ts';
import {setupTestDb} from '../../apps/buchhaltung/apps/web/src/server/test-db.ts';

test('agency references are audited metadata for documents, invoices and immutable bookings',async()=>{
 let sql;
 try{
  sql=await setupTestDb();
  const {agencyLinksVersion,listAgencyLinks,replaceAgencyLinks}=await import('../../apps/buchhaltung/apps/web/src/server/videomaker-agency-links.ts');
  const document=randomUUID(),invoice=randomUUID(),journal=randomUUID();
  await sql.begin(async tx=>{
   await tx`select set_config('haben.actor','fixture-user',true)`;
   await tx`insert into documents(id,sha256,filename,mime_type,size) values (${document},'synthetic-agency-test','test.pdf','application/pdf',1)`;
   await tx`insert into invoices(id,issue_date,due_date) values (${invoice},'2026-01-01','2026-01-15')`;
   await tx`insert into journal_entries(id,date,description,source_type,source_id,kontenrahmen) values (${journal},'2026-01-01','Test','document',${document},'SKR03')`;
   await tx`insert into journal_lines(entry_id,account,debit,credit) values (${journal},'1400',100,0),(${journal},'8400',0,100)`;
   await tx`update journal_entries set locked_at=now() where id=${journal}`;
  });
  const items=[{kind:'channel',id:randomUUID(),name:'Kontrakurs',platform:'youtube'},{kind:'project',id:randomUUID(),name:'Testprojekt',platform:null},{kind:'platform',id:'twitch',name:'Twitch',platform:'twitch'}];
  for(const [kind,id] of [['document',document],['invoice',invoice],['journal',journal]]){
   await replaceAgencyLinks('fixture-user',{kind,id},items,agencyLinksVersion([]),async()=>true);
   expect(await listAgencyLinks({kind,id})).toEqual([...items].sort((a,b)=>a.kind.localeCompare(b.kind)));
  }
  const before=await sql`select count(*)::int as n from audit_log where table_name='videomaker_agency_links'`;
  expect(before[0].n).toBe(9);
  await replaceAgencyLinks('fixture-user',{kind:'document',id:document},items,agencyLinksVersion(items),async()=>true);
  expect((await sql`select count(*)::int as n from audit_log where table_name='videomaker_agency_links'`)[0].n).toBe(9);
  await expect(replaceAgencyLinks('fixture-user',{kind:'document',id:document},[items[0]],agencyLinksVersion(items),async()=>false)).rejects.toThrow();
  expect(await listAgencyLinks({kind:'document',id:document})).toHaveLength(3);
  expect((await sql`select count(*)::int as n from audit_log where table_name='videomaker_agency_links'`)[0].n).toBe(9);
  await expect(replaceAgencyLinks('fixture-user',{kind:'document',id:document},[items[0],items[0]],agencyLinksVersion(items),async()=>true)).rejects.toThrow();
  await expect(replaceAgencyLinks('fixture-user',{kind:'document',id:randomUUID()},items,agencyLinksVersion([]),async()=>true)).rejects.toThrow();
  await replaceAgencyLinks('fixture-user',{kind:'journal',id:journal},[items[0]],agencyLinksVersion(items),async()=>true);
  expect((await sql`select description from journal_entries where id=${journal}`)[0].description).toBe('Test');
  expect((await sql`select count(*)::int as n from journal_lines where entry_id=${journal}`)[0].n).toBe(2);
  expect((await sql`select count(*)::int as n from audit_log where table_name='videomaker_agency_links'`)[0].n).toBe(11);
  const concurrent=await Promise.allSettled([
   replaceAgencyLinks('fixture-user',{kind:'document',id:document},[items[0]],agencyLinksVersion(items),async()=>true),
   replaceAgencyLinks('fixture-user',{kind:'document',id:document},[items[1]],agencyLinksVersion(items),async()=>true),
  ]);
  expect(concurrent.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(concurrent.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect(concurrent.find(result=>result.status==='rejected').reason.message).toContain('neu laden');
  expect(await listAgencyLinks({kind:'document',id:document})).toHaveLength(1);
  const draftDocument=randomUUID(),draftInvoice=randomUUID();
  await sql.begin(async tx=>{
   await tx`select set_config('haben.actor','fixture-user',true)`;
   await tx`insert into documents(id,sha256,filename,mime_type,size) values (${draftDocument},'draft-agency-test','draft.pdf','application/pdf',1)`;
   await tx`insert into invoices(id,issue_date,due_date) values (${draftInvoice},'2026-01-01','2026-01-15')`;
  });
  await replaceAgencyLinks('fixture-user',{kind:'document',id:draftDocument},[items[0]],agencyLinksVersion([]),async()=>true);
  await replaceAgencyLinks('fixture-user',{kind:'invoice',id:draftInvoice},[items[0]],agencyLinksVersion([]),async()=>true);
  await sql.begin(async tx=>{
   await tx`select set_config('haben.actor','fixture-user',true)`;
   await tx`delete from documents where id=${draftDocument}`;
   await tx`delete from invoices where id=${draftInvoice}`;
  });
  expect((await sql`select count(*)::int as n from videomaker_agency_links where document_id=${draftDocument} or invoice_id=${draftInvoice}`)[0].n).toBe(0);
  expect((await sql`select count(*)::int as n from audit_log where table_name='videomaker_agency_links' and action='DELETE' and old_value->>'target_id'=${items[0].id}`)[0].n).toBeGreaterThanOrEqual(2);
  // Known cross-database limit: an already-checked request can commit after a later logout.
  const vmDb=new Database(':memory:'),vmSecret='synthetic-secret-with-at-least-32-characters',vmCookie='fixture-cookie';
  try{
   sessionRevoked(vmDb,vmSecret,vmCookie);
   let checked,release;const guardReached=new Promise(resolve=>{checked=resolve;}),continueCommit=new Promise(resolve=>{release=resolve;});
   const prior=await listAgencyLinks({kind:'document',id:document});
   const pending=replaceAgencyLinks('fixture-user',{kind:'document',id:document},[items[2]],agencyLinksVersion(prior),async()=>{
    const wasValid=!sessionRevoked(vmDb,vmSecret,vmCookie);checked();await continueCommit;return wasValid;
   });
   await guardReached;revokeSession(vmDb,vmSecret,vmCookie,1000);release();await pending;
   expect(sessionRevoked(vmDb,vmSecret,vmCookie)).toBe(true);
   expect(await listAgencyLinks({kind:'document',id:document})).toEqual([items[2]]);
  }finally{vmDb.close();}
 }finally{
  await sql?.end();try{await (await import('../../apps/buchhaltung/apps/web/src/server/db/index.ts')).closeDatabase();}catch{}
 }
},120000);
