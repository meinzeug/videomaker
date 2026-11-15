/** Local request ordering only; the server must still validate take and device. */
export type CameraUiCommand = {id:string;type:'record_start'|'record_stop';recordingId:string;deviceId:string};
export type CameraUiAttempt = {command:CameraUiCommand};
export function beginCameraUiAttempt(current:CameraUiAttempt|null,command:CameraUiCommand):CameraUiAttempt|null {
 // A STOP for an observed take can supersede a stuck start request. Nothing
 // else can replace an in-flight request, including another STOP.
 if(current && !(current.command.type==='record_start' && command.type==='record_stop'))return null;
 return {command};
}
export function cameraUiAttemptIsCurrent(current:CameraUiAttempt|null,attempt:CameraUiAttempt):boolean { return current===attempt; }
export function cameraUiMayStop(observed:{id:string;phase:string;recordingId:string|null}|undefined,command:CameraUiCommand):boolean {
 return !!observed && command.type==='record_stop' && observed.id===command.deviceId && observed.recordingId===command.recordingId && ['preparing','recording'].includes(observed.phase);
}
