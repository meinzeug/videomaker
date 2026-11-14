import test from 'node:test';
import assert from 'node:assert/strict';
import {issueAgencyTicket,verifyAgencyTicket,validAgencyCatalogItem} from '../apps/buchhaltung/apps/web/src/server/videomaker-catalog-tickets.ts';

const secret='synthetic-agency-catalog-secret-123456789',session='signed-test-session',now=1000;
const item={kind:'channel',id:'12345678-1234-4123-8123-123456789abc',name:'Kontrakurs',platform:'youtube'};
test('catalog tickets preserve only public metadata and bind to session, secret and short lifetime',()=>{
 const ticket=issueAgencyTicket(secret,session,item,now);
 assert.deepEqual(verifyAgencyTicket(secret,session,ticket,now+1),item);
 assert.equal(Buffer.from(ticket.split('.')[0],'base64url').toString().includes(session),false);
 assert.equal(verifyAgencyTicket(secret,'another-session',ticket,now+1),null);
 assert.equal(verifyAgencyTicket('other-agency-catalog-secret-123456789',session,ticket,now+1),null);
 assert.equal(verifyAgencyTicket(secret,session,ticket,now+120000),null);
 assert.equal(verifyAgencyTicket(secret,session,ticket,now-1),null);
  const noisy=issueAgencyTicket(secret,session,{...item,script:'private-script-fixture'},now);
  assert.equal(Buffer.from(noisy.split('.')[0],'base64url').toString().includes('private-script-fixture'),false);
});
test('forged, malformed or unsupported catalog items never verify',()=>{
 const ticket=issueAgencyTicket(secret,session,item,now),[payload,signature]=ticket.split('.');
 const forged=JSON.parse(Buffer.from(payload,'base64url'));forged.item.name='Forged';
 assert.equal(verifyAgencyTicket(secret,session,`${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`,now),null);
 for(const bad of ['',ticket+'x',`*.${signature}`,'a'.repeat(2049),'a.b.c'])assert.equal(verifyAgencyTicket(secret,session,bad,now),null);
 for(const invalid of [{...item,id:'invalid'},{...item,name:'\nspam'},{...item,platform:null},{...item,kind:'account'},{...item,id:item.id.toUpperCase()}])assert.equal(validAgencyCatalogItem(invalid),false);
 assert.equal(validAgencyCatalogItem({kind:'project',id:item.id,name:'Projekt',platform:null}),true);
 assert.equal(validAgencyCatalogItem({kind:'platform',id:'twitch',name:'Twitch',platform:'twitch'}),true);
 assert.throws(()=>issueAgencyTicket('too-short',session,item,now));
});
