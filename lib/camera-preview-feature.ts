/** Two explicit local opt-ins; production and unknown/edge runtimes fail closed. */
export const cameraPreviewEnabled=(nodeEnv:string|undefined,remoteFlag:string|undefined,previewFlag:string|undefined,runtime:string|undefined):boolean=>
 (nodeEnv==='development'||nodeEnv==='test')&&remoteFlag==='1'&&previewFlag==='1'&&runtime==='nodejs';
