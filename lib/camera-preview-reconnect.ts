/** Only a confirmed lens change on the same selected device may request one retry. */
export function cameraLensChanged(previous:{deviceId:string;front:boolean|null}|null,current:{deviceId:string;front:boolean|null}){
 return !!previous&&previous.deviceId===current.deviceId&&typeof previous.front==='boolean'&&typeof current.front==='boolean'&&previous.front!==current.front;
}
