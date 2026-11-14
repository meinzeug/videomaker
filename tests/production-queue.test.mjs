import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {listProductionQueue,PRODUCTION_QUEUE_LIMIT} from '../lib/production-queue.ts';

const channel='01000000-0000-4000-8000-000000000000';
const other='02000000-0000-4000-8000-000000000000';
function fixture(){
 const db=new Database(':memory:');
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,created_at TEXT); CREATE TABLE project_recordings(id TEXT PRIMARY KEY,project_id TEXT); CREATE TABLE project_channels(project_id TEXT,channel_id TEXT,PRIMARY KEY(project_id,channel_id));');
 return db;
}
test('lists newest projects without server recording, bounded with correct total and channels',()=>{
 const db=fixture();
 for(let i=0;i<12;i++)db.prepare('INSERT INTO projects VALUES(?,?,?)').run(`p${i}`,`Skript ${i}`,`2026-01-${String(i+1).padStart(2,'0')}`);
 db.prepare('INSERT INTO project_recordings VALUES(?,?)').run('recording','p11');
 db.prepare('INSERT INTO project_channels VALUES(?,?),(?,?)').run('p10',channel,'p10',other);
 const result=listProductionQueue(db,'');
 assert.equal(result.total,11);assert.equal(result.items.length,PRODUCTION_QUEUE_LIMIT);
 assert.equal(result.items[0].id,'p10');assert.deepEqual(result.items[0].channelIds,[channel,other]);
 assert.ok(!result.items.some(item=>item.id==='p11'));
 assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n,12);
 db.close();
});
test('channel and no-channel filters apply before the limit and ignore recorded projects',()=>{
 const db=fixture();
 for(let i=0;i<10;i++)db.prepare('INSERT INTO projects VALUES(?,?,?)').run(`p${i}`,`Skript ${i}`,`2026-01-${String(i+1).padStart(2,'0')}`);
 db.prepare('INSERT INTO project_channels VALUES(?,?),(?,?),(?,?)').run('p0',channel,'p1',channel,'p2',other);
 db.prepare('INSERT INTO project_recordings VALUES(?,?)').run('recording','p1');
 assert.deepEqual(listProductionQueue(db,channel).items.map(item=>item.id),['p0']);
 assert.equal(listProductionQueue(db,'unassigned').total,7);
 assert.equal(listProductionQueue(db,other).items[0].id,'p2');
 assert.equal(listProductionQueue(db,'03000000-0000-4000-8000-000000000000').total,0);
 assert.throws(()=>listProductionQueue(db,'../../other'));
 db.close();
});
