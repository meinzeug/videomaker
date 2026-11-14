// Only run against the explicitly marked, disposable local test environment.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CAMERA_PROJECT_CLAIMS_SCHEMA} from '../lib/camera-project-claims.ts';

const base=process.env.CAMERA_CLAIMS_TEST_SERVER;
const dir=process.env.CAMERA_CLAIMS_TEST_DATA_DIR;
const enabled=base==='http://127.0.0.1:3333'&&process.env.CAMERA_CLAIMS_TEST_ALLOW_WRITES==='1'&&typeof dir==='string';

test('readonly claims endpoint does not create schema and sees WAL logout revocations',{skip:!enabled,timeout:90000},async()=>{
 const resolved=realpathSync(dir);
 assert.equal(path.dirname(resolved),'/tmp');
 assert.match(path.basename(resolved),/^camera-claims-readonly-[A-Za-z0-9]+$/);
 assert.equal(readFileSync(path.join(resolved,'disposable-fixture'),'utf8'),'camera-claims-fixture\n');
 const databasePath=path.join(resolved,'videomaker.sqlite');
 const project=randomUUID(),take=randomUUID(),device=randomUUID();
 const claimPath=`/api/camera-devices/claims?projectId=${project}`;
 const request=(route,cookie)=>fetch(base+route,{headers:cookie?{cookie}:{}});
 const database=new Database(databasePath,{fileMustExist:true});
 const schema=()=>database.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
 try{
  assert.equal(database.pragma('journal_mode = WAL',{simple:true}),'wal');
  let before=schema();
  assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('auth_session_revocations','camera_project_claims')").get().n,0);
  assert.equal((await request(claimPath,'kontrakurs_session=invalid')).status,401);
  assert.deepEqual(schema(),before);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'camera-claims-test'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(claimPath,cookie)).status,503);
  assert.deepEqual(schema(),before,'missing revocation schema must not be created');
  database.exec('CREATE TABLE auth_session_revocations(session_hash TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL)');
  before=schema();assert.equal((await request(claimPath,cookie)).status,503);
  assert.deepEqual(schema(),before,'missing camera schema must not be created');
  database.exec(CAMERA_PROJECT_CLAIMS_SCHEMA);
  database.exec('CREATE TABLE camera_remote_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL)');
  database.prepare('INSERT INTO camera_project_claims(recording_id,device_id,project_id,opened_at) VALUES(?,?,?,?)').run(take,device,project,1);
  before=schema();const response=await request(claimPath,cookie);assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal((await response.json()).claims[0].recordingId,take);
  assert.deepEqual(schema(),before,'successful read must not change schema');
  const logout=await fetch(base+'/api/logout',{method:'POST',headers:{origin:base,cookie}});assert.equal(logout.status,200);
  before=schema();assert.equal((await request(claimPath,cookie)).status,401);
  assert.deepEqual(schema(),before,'revoked read must not change schema');
 }finally{database.close();}
});
