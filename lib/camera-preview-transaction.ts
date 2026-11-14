import {CameraPreviewError,resetCameraPreviewStore} from './camera-preview-store.ts';

/** Preview state cannot be rolled back with SQLite. Unexpected failure after
 * entering the mutation, or a failed commit, discards the local generation.
 * Expected CameraPreviewErrors may only leave the store's expiry sweep behind. */
export function protectPreviewTransaction<T>(run:(operation:(owner:string)=>T)=>T,operation:(owner:string)=>T):T {
 let entered=false,completed=false;
 try{return run(owner=>{entered=true;const result=operation(owner);completed=true;return result;});}
 catch(error){if(entered&&(completed||!(error instanceof CameraPreviewError)))resetCameraPreviewStore();throw error;}
}
