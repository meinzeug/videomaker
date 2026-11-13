import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
let instance: Database.Database | undefined;
export default function db() {
 if (!instance) {
  const dir=process.env.DATA_DIR || './data'; mkdirSync(dir,{recursive:true});
  instance=new Database(path.join(dir,'videomaker.sqlite'), { timeout: 10000 });
  instance.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, sources TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_jobs (project_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_images (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, orientation TEXT NOT NULL DEFAULT 'landscape', position INTEGER NOT NULL, label TEXT NOT NULL, placement TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, mime TEXT, data BLOB, error TEXT);
    CREATE INDEX IF NOT EXISTS project_images_project_idx ON project_images(project_id, position);
  `);
  const columns=instance.prepare('PRAGMA table_info(project_images)').all() as Array<{name:string}>;
  if(!columns.some(column=>column.name==='orientation')) instance.exec("ALTER TABLE project_images ADD COLUMN orientation TEXT NOT NULL DEFAULT 'landscape'");
 }
 return instance;
}
