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
  const existing=database.prepare('SELECT project_id FROM lan_capture_projects WHERE workspace_id=? AND recording_id=?').get(SINGLE_WORKSPACE,recording) as {project_id:string}|undefined;
  if(existing){
   if(!database.prepare('SELECT 1 FROM projects WHERE id=?').get(existing.project_id))throw new LanCaptureProjectError('project_deleted');
   return {projectId:existing.project_id,recordingId:recording,created:false};
  }
  // Existing web-camera claims use a different, device-bound workflow.
  if(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='camera_project_claims'").get()&&database.prepare('SELECT 1 FROM camera_project_claims WHERE recording_id=? COLLATE NOCASE').get(recording))throw new LanCaptureProjectError('camera_claim_exists');
  const projectId=makeId();if(!isRecordingId(projectId))throw new LanCaptureProjectError('invalid_project_id');
  const createdAt=now().toISOString(),content={titles:[],thumbnail:'',broll:[],script:'',image_mode:'descriptions',capture_without_script:true};
  database.prepare('INSERT INTO projects(id,created_at,title,sources,content) VALUES(?,?,?,?,?)').run(projectId,createdAt,'Aufnahme ohne Skript','[]',JSON.stringify(content));
  database.prepare('INSERT INTO lan_capture_projects(workspace_id,recording_id,project_id,created_at) VALUES(?,?,?,?)').run(SINGLE_WORKSPACE,recording,projectId,createdAt);
  return {projectId,recordingId:recording,created:true};
 }).immediate();
}
