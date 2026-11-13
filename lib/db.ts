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
    CREATE TABLE IF NOT EXISTS research_reports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, sources TEXT NOT NULL, report TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_jobs (project_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_images (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, orientation TEXT NOT NULL DEFAULT 'landscape', position INTEGER NOT NULL, label TEXT NOT NULL, placement TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, mime TEXT, data BLOB, error TEXT);
    CREATE INDEX IF NOT EXISTS project_images_project_idx ON project_images(project_id, position);
    CREATE TABLE IF NOT EXISTS project_recordings (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS project_recordings_project_idx ON project_recordings(project_id, created_at);
    CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_channels (project_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY(project_id,channel_id));
    CREATE INDEX IF NOT EXISTS project_channels_channel_idx ON project_channels(channel_id);
    CREATE TABLE IF NOT EXISTS news_packages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, angle TEXT NOT NULL, sources TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS news_packages_created_idx ON news_packages(created_at DESC);
  `);
  const columns=instance.prepare('PRAGMA table_info(project_images)').all() as Array<{name:string}>;
  if(!columns.some(column=>column.name==='orientation')) instance.exec("ALTER TABLE project_images ADD COLUMN orientation TEXT NOT NULL DEFAULT 'landscape'");
  if(!columns.some(column=>column.name==='description')) instance.exec("ALTER TABLE project_images ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  const jobColumns=instance.prepare('PRAGMA table_info(image_jobs)').all() as Array<{name:string}>;
  if(!jobColumns.some(column=>column.name==='mode')) instance.exec("ALTER TABLE image_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'render'");
 }
 return instance;
}
