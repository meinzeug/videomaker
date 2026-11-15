/** UI checks complement, never replace, server-side authorization and state checks. */
export type CameraControlType = 'record_start'|'record_stop'|'record_pause'|'record_resume'|'camera_switch';
export type CameraUiCommand = {id:string;type:CameraControlType;recordingId:string;deviceId:string;projectId?:string;expectedProjectId?:string;cameraFrom?:boolean};
export type CameraUiAttempt = {command:CameraUiCommand};
export type CameraControlState = {
 id:string;phase:string;recordingId:string|null;projectId:string|null;pendingStart:boolean;uncertain?:boolean;
 capability?:string|null;paused?:boolean|null;cameraFront?:boolean|null;cameraCanSwitch?:boolean;
 lastControl?:{id:string;type:string;recordingId:string;result:string}|null;
};
export function beginCameraUiAttempt(current:CameraUiAttempt|null,command:CameraUiCommand):CameraUiAttempt|null {
 // STOP for an observed take can supersede an in-flight non-STOP request.
 if(current && !(current.command.type!=='record_stop' && command.type==='record_stop'))return null;
 return {command};
}
export function cameraUiAttemptIsCurrent(current:CameraUiAttempt|null,attempt:CameraUiAttempt):boolean {return current===attempt;}
export function cameraUiMayStop(camera:CameraControlState|undefined,command:CameraUiCommand):boolean {
 return !!camera && command.type==='record_stop' && camera.id===command.deviceId && camera.recordingId===command.recordingId && ['preparing','recording'].includes(camera.phase);
}
export function cameraControlAvailability(camera:CameraControlState|undefined,projectId:string,busy:boolean,offline:boolean) {
 const supported=camera?.capability==='remote-record-v4';
 const safe=!!camera && supported && !busy && !offline && !camera.pendingStart && camera.uncertain===false;
 const sameTake=!!camera?.recordingId && camera.projectId===projectId;
 return {
  supported,
  pause:!!(safe && sameTake && camera?.phase==='recording' && camera.paused===false),
  resume:!!(safe && sameTake && camera?.phase==='recording' && camera.paused===true),
  switchCamera:!!(safe && camera?.phase==='idle' && camera.cameraCanSwitch===true && typeof camera.cameraFront==='boolean'),
 };
}
export function cameraControlCompletion(camera:CameraControlState,command:CameraUiCommand):'pending'|'confirmed'|'rejected' {
 const receipt=camera.lastControl;
 if(camera.id!==command.deviceId || !receipt || receipt.id!==command.id || receipt.type!==command.type || receipt.recordingId!==command.recordingId)return 'pending';
 if(['rejected','expired'].includes(receipt.result))return 'rejected';
 if(!['accepted','duplicate'].includes(receipt.result))return 'pending';
 if(command.type==='record_pause' && camera.projectId===command.expectedProjectId && camera.recordingId===command.recordingId && camera.phase==='recording' && camera.paused===true)return 'confirmed';
 if(command.type==='record_resume' && camera.projectId===command.expectedProjectId && camera.recordingId===command.recordingId && camera.phase==='recording' && camera.paused===false)return 'confirmed';
 if(command.type==='camera_switch' && camera.phase==='idle' && typeof command.cameraFrom==='boolean' && camera.cameraFront===!command.cameraFrom)return 'confirmed';
 return 'pending';
}
