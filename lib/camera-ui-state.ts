/** Only a durable device decision or proven non-delivery resolves a start. */
export function cameraStartWasRefused(command:{id:string;result:string;neverDelivered?:boolean|number}|null|undefined,pendingId:string){
 return !!command&&command.id===pendingId&&(command.result==='rejected'||command.result==='expired'||(command.result==='server_expired'&&!!command.neverDelivered));
}
