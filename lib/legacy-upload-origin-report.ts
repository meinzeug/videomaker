import type Database from 'better-sqlite3';

/** Aggregate metadata only. Never creates schema, changes records or reads media bytes. */
export function legacyUploadOriginReport(db:Database.Database) {
 if(!db.readonly)throw new Error('READONLY_DATABASE_REQUIRED');
 return db.transaction(()=>{
 const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(!has('project_recordings'))throw new Error('RECORDINGS_SCHEMA_MISSING');
 const owner=has('live_upload_path_owners')
  ? 'EXISTS(SELECT 1 FROM live_upload_path_owners o WHERE o.upload_id=r.id COLLATE NOCASE)' : '0';
 const web=has('camera_project_upload_ids')
  ? 'EXISTS(SELECT 1 FROM camera_project_upload_ids w WHERE w.upload_id=r.id COLLATE NOCASE)' : '0';
 const count=(where:string)=>{
  const row=db.prepare(`SELECT COUNT(*) AS n FROM project_recordings r WHERE ${where}`).get() as {n:number};
  if(!Number.isSafeInteger(row.n)||row.n<0)throw new Error('COUNT_INVALID');
  return row.n;
 };
 return {total:count('1'),withOwnerMetadata:count(owner),withWebMetadata:count(web),
  withBothMetadata:count(`(${owner}) AND (${web})`),withoutOriginMetadata:count(`NOT (${owner}) AND NOT (${web})`)};
 })();
}
