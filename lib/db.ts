import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
let instance: Database.Database | undefined;
export default function db() {
 if (!instance) {
  const dir=process.env.DATA_DIR || './data'; mkdirSync(dir,{recursive:true});
  instance=new Database(path.join(dir,'videomaker.sqlite'), { timeout: 10000 });
  instance.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, sources TEXT NOT NULL, content TEXT NOT NULL)`);
 }
 return instance;
}
