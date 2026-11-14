import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {revokeSession,sessionRevoked} from '../lib/session-revocations.ts';

const secret='local-test-secret-at-least-32-characters';
const owner=value=>createHmac('sha256',secret).update('camera-session/v1\0').update(value).digest('hex');
function fixture(){
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE camera_device_tickets(device_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL);
 CREATE TABLE camera_pairing_challenges(device_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL);`);
 return db;
}
test('revokes only the logged-out cookie and its own camera credentials',()=>{
 const db=fixture(),browser='browser-cookie',device='device-cookie';
 assert.equal(sessionRevoked(db,secret,browser),false);
 assert.equal(sessionRevoked(db,secret,device),false);
 for(const table of ['camera_device_tickets','camera_pairing_challenges']){
  db.prepare(`INSERT INTO ${table} VALUES(?,?),(?,?)`).run('browser',owner(browser),'device',owner(device));
 }
 revokeSession(db,secret,browser,1000);
 revokeSession(db,secret,browser,2000); // logout retry is idempotent
 assert.equal(sessionRevoked(db,secret,browser),true);
 assert.equal(sessionRevoked(db,secret,device),false);
 for(const table of ['camera_device_tickets','camera_pairing_challenges'])assert.deepEqual(db.prepare(`SELECT device_id FROM ${table}`).all(),[{device_id:'device'}]);
 const rows=db.prepare('SELECT * FROM auth_session_revocations').all();
 assert.equal(rows.length,1);assert.equal(rows[0].revoked_at,1000);
 assert.notEqual(rows[0].session_hash,browser);
 db.close();
});
test('logout works before camera tables exist',()=>{
 const db=new Database(':memory:');
 revokeSession(db,secret,'old-cookie',1000);
 assert.equal(sessionRevoked(db,secret,'old-cookie'),true);
 assert.equal(sessionRevoked(db,secret,'another-cookie'),false);
 db.close();
});
test('credential deletion failure rolls back revocation and all deletes',()=>{
 const db=fixture(),cookie='test-cookie';
 db.prepare('INSERT INTO camera_device_tickets VALUES(?,?)').run('camera',owner(cookie));
 db.prepare('INSERT INTO camera_pairing_challenges VALUES(?,?)').run('camera',owner(cookie));
 db.exec("CREATE TRIGGER fail_challenge_delete BEFORE DELETE ON camera_pairing_challenges BEGIN SELECT RAISE(ABORT,'injected failure'); END");
 assert.throws(()=>revokeSession(db,secret,cookie,1000));
 assert.equal(sessionRevoked(db,secret,cookie),false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_device_tickets').get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_pairing_challenges').get().n,1);
 db.close();
});
test('failed COMMIT rolls back both revocation and camera credential deletion',()=>{
 const db=fixture(),cookie='commit-failure-cookie';
 db.pragma('foreign_keys = ON');
 db.prepare('INSERT INTO camera_device_tickets VALUES(?,?)').run('camera',owner(cookie));
 // A deferred FK is checked at COMMIT, after the tombstone and ticket delete.
 db.exec(`CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY);
  CREATE TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
  CREATE TABLE auth_session_revocations(session_hash TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL);
  CREATE TRIGGER fixture_fail_commit AFTER INSERT ON auth_session_revocations BEGIN INSERT INTO fixture_child VALUES(1); END;`);
 assert.throws(()=>revokeSession(db,secret,cookie,1000));
 assert.equal(db.inTransaction,false);
 assert.equal(sessionRevoked(db,secret,cookie),false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM camera_device_tickets').get().n,1);
 db.close();
});
test('revocation survives restart and is not lost to clock rollback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'videomaker-revocation-'));
 try{
  const file=join(dir,'fixture.sqlite');let db=new Database(file);
  revokeSession(db,secret,'cookie',2000);db.close();db=new Database(file);
  // No wall-clock comparison or expiry pruning can resurrect a tombstone.
  assert.equal(sessionRevoked(db,secret,'cookie'),true);
  assert.equal(sessionRevoked(db,secret,'unrelated'),false);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
