/** Recover durable recording-deletion jobs when the Node server starts. */
declare global {var __videomakerDeletionRecovery:{stop:()=>void}|undefined;}
export async function register(){
 if(process.env.NEXT_RUNTIME!=='nodejs'||globalThis.__videomakerDeletionRecovery)return;
 const [{default:db},{recordingPath},{startProjectDeletionRecovery}]=await Promise.all([
  import('./lib/db'),import('./lib/recordings'),import('./lib/project-deletion-recovery')
 ]);
 globalThis.__videomakerDeletionRecovery=startProjectDeletionRecovery(db,recordingPath);
}
