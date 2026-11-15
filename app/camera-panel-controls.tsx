'use client';
import {cameraControlAvailability,type CameraControlState} from './camera-panel-policy';

type Props={camera:CameraControlState|undefined;projectId:string;busy:boolean;offline:boolean;onControl:(type:'record_pause'|'record_resume'|'camera_switch')=>void};
/** Status checks are advisory; the device and server revalidate every command. */
export default function CameraPanelControls({camera,projectId,busy,offline,onControl}:Props){
 const controls=cameraControlAvailability(camera,projectId,busy,offline);
 return <>
  <button className="secondary-action" disabled={!controls.pause} onClick={()=>onControl('record_pause')}>Aufnahme pausieren</button>
  <button className="secondary-action" disabled={!controls.resume} onClick={()=>onControl('record_resume')}>Aufnahme fortsetzen</button>
  <button className="secondary-action" disabled={!controls.switchCamera} onClick={()=>onControl('camera_switch')}>Kamera wechseln</button>
 </>;
}
