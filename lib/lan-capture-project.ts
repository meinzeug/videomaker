import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {isRecordingId} from './recordings.ts';

/** This application currently has one administrator and one workspace. */
const SINGLE_WORKSPACE='single-admin-v1';
export class LanCaptureProjectError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}

/** Explicit migration; no camera data, scripts or credentials are stored in this mapping. */
export function initializeLanCaptureProjects(database:Database.Database):void {
 database.exec(`CREATE TABLE IF NOT EXISTS lan_capture_projects (
  workspace_id TEXT NOT NULL, recording_id TEXT NOT NULL, project_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,recording_id)
 )`);
}

/** Project and binding commit together; a retry must never silently bind a different project. */
export function ensureLanCaptureProject(database:Database.Database,recordingId:string,authorize:()=>void,makeId:()=>string=randomUUID,now:()=>Date=()=>new Date()) {
 if(typeof recordingId!=='string'||!isRecordingId(recordingId))throw new LanCaptureProjectError('invalid_recording');
 const recording=recordingId.toLowerCase();
 return database.transaction(()=>{
  authorize();
  initializeLanCaptureProjects(database);
  const existing=database.prepare('SELECT project_id FROM lan_capture_projects WHERE workspace_id=? AND recording_id=?').get(SINGLE_WORKSPACE,recording) as {project_id:string}|undefined;
  const owner=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_upload_path_owners'").get()
   ? database.prepare('SELECT project_id,upload_id,path FROM live_upload_path_owners WHERE recording_id=? COLLATE NOCASE').get(recording) as {project_id:string;upload_id:string;path:string}|undefined
   : undefined;
  if(existing){
   if(owner&&owner.project_id!==existing.project_id){
    // A full-file owner can have an explicitly selected destination in
    // addition to this already-existing neutral project. Require the complete
    // new schema and original target/manifest, never infer an old owner.
    const schema=database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('live_upload_path_targets','live_upload_full_manifests')").get() as {n:number};
    if(owner.path!=='full'||schema.n!==2||
       !database.prepare('SELECT 1 FROM live_upload_path_targets WHERE recording_id=? AND project_id=? AND upload_id=?').get(recording,owner.project_id,owner.upload_id)||
       !database.prepare('SELECT 1 FROM live_upload_full_manifests WHERE recording_id=?').get(recording))
     throw new LanCaptureProjectError('camera_claim_exists');
   }
   if(!database.prepare('SELECT 1 FROM projects WHERE id=?').get(existing.project_id))throw new LanCaptureProjectError('project_deleted');
   return {projectId:existing.project_id,recordingId:recording,created:false};
  }
  // Existing web-camera claims use a different, device-bound workflow.
  if(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='camera_project_claims'").get()&&database.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? COLLATE NOCASE').get(recording))throw new LanCaptureProjectError('camera_claim_exists');
  if(owner)throw new LanCaptureProjectError('camera_claim_exists');
  const projectId=makeId();if(!isRecordingId(projectId))throw new LanCaptureProjectError('invalid_project_id');
  const createdAt=now().toISOString(),content={titles:[],thumbnail:'',broll:[],script:'',image_mode:'descriptions',capture_without_script:true};
  database.prepare('INSERT INTO projects(id,created_at,title,sources,content) VALUES(?,?,?,?,?)').run(projectId,createdAt,'Aufnahme ohne Skript','[]',JSON.stringify(content));
  database.prepare('INSERT INTO lan_capture_projects(workspace_id,recording_id,project_id,created_at) VALUES(?,?,?,?)').run(SINGLE_WORKSPACE,recording,projectId,createdAt);
  return {projectId,recordingId:recording,created:true};
 }).immediate();
}
