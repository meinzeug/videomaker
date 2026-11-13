/** Test-only gate. The unfinished remote camera API cannot be enabled in production. */
export const cameraRemoteEnabled=(nodeEnv:string|undefined,testFlag:string|undefined):boolean=>
 (nodeEnv==='development'||nodeEnv==='test')&&testFlag==='1';
