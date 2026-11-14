import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,rmSync,statSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';

const script=join(process.cwd(),'scripts/remove-legacy-finance.py');
const tables=['ug_ledger_finance_unlink_requests','ug_ledger_finance_link_requests','ug_ledger_finance_unlinks','ug_ledger_finance_links','ug_ledger_document_unlinks','ug_ledger_document_links','ug_ledger_journals','ug_ledger_accounts','finance_documents','finance_settings_events','finance_entries'];
function run(file,...args){return spawnSync('python3',[script,file,...args],{encoding:'utf8',timeout:15000});}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'videomaker-legacy-cleanup-'));
 const file=join(dir,'studio.sqlite'),backup=join(dir,'before.sqlite'),db=new Database(file);
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES (\'preserved\');');
 for(const table of tables)db.exec(`CREATE TABLE ${table}(id TEXT); CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
 db.close();return {dir,file,backup};
}
function remove(dir){rmSync(dir,{recursive:true,force:true});}

test('dry-run preserves all tables; apply verifies a backup and retains unrelated data',()=>{
 const {dir,file,backup}=fixture();
 try{
  const dry=run(file);assert.equal(dry.status,0,dry.stderr);
  let db=new Database(file,{readonly:true});assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND (name LIKE 'finance_%' OR name LIKE 'ug_ledger_%')").get().n,11);db.close();
  const result=run(file,'--apply','--backup',backup);assert.equal(result.status,0,result.stderr);
  assert.equal(statSync(backup).mode & 0o777,0o600);
  db=new Database(file,{readonly:true});assert.deepEqual(db.prepare('SELECT id FROM projects').all(),[{id:'preserved'}]);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'finance_%' OR name LIKE 'ug_ledger_%'").get().n,0);db.close();
  const saved=new Database(backup,{readonly:true});assert.equal(saved.pragma('integrity_check',{simple:true}),'ok');assert.equal(saved.prepare('SELECT count(*) AS n FROM finance_entries').get().n,0);assert.deepEqual(saved.prepare('SELECT id FROM projects').all(),[{id:'preserved'}]);saved.close();
 }finally{remove(dir);}
});

test('non-empty legacy table prevents cleanup and backup creation',()=>{
 const {dir,file,backup}=fixture();
 try{
  const db=new Database(file);db.prepare('INSERT INTO finance_entries VALUES(?)').run('do-not-delete');db.close();
  const result=run(file,'--apply','--backup',backup);assert.notEqual(result.status,0);assert.match(result.stderr,/enthalten Daten/);assert.equal(existsSync(backup),false);
  const check=new Database(file,{readonly:true});assert.equal(check.prepare('SELECT id FROM finance_entries').get().id,'do-not-delete');assert.equal(check.prepare('SELECT id FROM projects').get().id,'preserved');check.close();
 }finally{remove(dir);}
});

test('unexpected legacy tables and external schema references refuse cleanup',()=>{
 for(const extra of ['CREATE TABLE finance_unexpected(id TEXT)','CREATE TABLE other(id TEXT REFERENCES finance_entries(id))',"CREATE TRIGGER finance_custom AFTER INSERT ON projects BEGIN SELECT id FROM finance_entries; END"]){
  const {dir,file,backup}=fixture();
  try{const db=new Database(file);db.exec(extra);db.close();const result=run(file,'--apply','--backup',backup);assert.notEqual(result.status,0);assert.equal(existsSync(backup),false);const check=new Database(file,{readonly:true});assert.equal(check.prepare('SELECT id FROM projects').get().id,'preserved');check.close();}finally{remove(dir);}
 }
});

test('SQLite sidecar names are refused before any backup or table removal',()=>{
 for(const suffix of ['-journal','-wal','-shm','-mj1234abcd']){
  const {dir,file}=fixture(),backup=file+suffix;
  try{const result=run(file,'--apply','--backup',backup);assert.notEqual(result.status,0);assert.equal(existsSync(backup),false);const db=new Database(file,{readonly:true});assert.equal(db.prepare('SELECT id FROM projects').get().id,'preserved');assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='finance_entries'").get().n,1);db.close();}finally{remove(dir);}
 }
});

test('untrusted backup directories and symlink database paths are refused',()=>{
 const {dir,file}=fixture();
 try{
  const publicDir=join(dir,'public');mkdirSync(publicDir);chmodSync(publicDir,0o755);
  const result=run(file,'--apply','--backup',join(publicDir,'backup.sqlite'));assert.notEqual(result.status,0);assert.equal(existsSync(join(publicDir,'backup.sqlite')),false);
  const alias=join(dir,'alias.sqlite');symlinkSync(file,alias);assert.notEqual(run(alias).status,0);
  const db=new Database(file,{readonly:true});assert.equal(db.prepare('SELECT id FROM projects').get().id,'preserved');db.close();
 }finally{remove(dir);}
});

test('a writable non-sticky ancestor cannot replace a private backup directory',()=>{
 const {dir,file}=fixture();
 try{
  const shared=join(dir,'shared'),privateDir=join(shared,'private');mkdirSync(shared);chmodSync(shared,0o777);mkdirSync(privateDir,{mode:0o700});
  const backup=join(privateDir,'backup.sqlite'),result=run(file,'--apply','--backup',backup);
  assert.notEqual(result.status,0);assert.equal(existsSync(backup),false);
  const db=new Database(file,{readonly:true});assert.equal(db.prepare('SELECT id FROM projects').get().id,'preserved');db.close();
 }finally{remove(dir);}
});

test('legacy table names with different casing are never silently dropped',()=>{
 const {dir,file,backup}=fixture();
 try{
  const db=new Database(file);db.exec('ALTER TABLE finance_entries RENAME TO temporary_entries; ALTER TABLE temporary_entries RENAME TO FINANCE_ENTRIES');db.prepare('INSERT INTO FINANCE_ENTRIES VALUES(?)').run('keep');db.close();
  const result=run(file,'--apply','--backup',backup);assert.notEqual(result.status,0);assert.equal(existsSync(backup),false);
  const check=new Database(file,{readonly:true});assert.equal(check.prepare('SELECT id FROM FINANCE_ENTRIES').get().id,'keep');check.close();
 }finally{remove(dir);}
});

test('an actual SQLite commit lock failure rolls all table drops back and retains the backup',()=>{
 const {dir,file,backup}=fixture();
 const reader=new Database(file);
 try{
  reader.pragma('journal_mode=DELETE');reader.exec('BEGIN');reader.prepare('SELECT * FROM projects').all();
  // A read lock permits BEGIN IMMEDIATE and writes but denies the EXCLUSIVE lock
  // required at COMMIT; the runner must roll back every prior DROP.
  const result=run(file,'--apply','--backup',backup);
  assert.notEqual(result.status,0);assert.match(result.stderr,/locked/i);assert.equal(existsSync(backup),true);
  reader.exec('ROLLBACK');
  const db=new Database(file,{readonly:true});
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND (name LIKE 'finance_%' OR name LIKE 'ug_ledger_%')").get().n,11);
  assert.deepEqual(db.prepare('SELECT id FROM projects').all(),[{id:'preserved'}]);db.close();
  const saved=new Database(backup,{readonly:true});assert.equal(saved.pragma('integrity_check',{simple:true}),'ok');saved.close();
 }finally{if(reader.inTransaction)reader.exec('ROLLBACK');reader.close();remove(dir);}
});
