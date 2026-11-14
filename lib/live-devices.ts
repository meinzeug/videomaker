export const isUuid=(id:unknown):id is string=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export type DeviceCommand = {id:string; type:'load'|'play'|'pause'|'reset'|'set_speed'|'set_font_size'; projectId:string|null;value:number|null};
const inRange=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export function parseHeartbeat(input:unknown) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Ungültiges Gerät.');
 const item=input as Record<string,unknown>;
 if(!isUuid(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name.length>80||!['camera','prompter'].includes(String(item.role))||typeof item.status!=='string'||item.status.length>120||!Array.isArray(item.ack)||item.ack.length>32||item.ack.some(id=>!isUuid(id)))throw new Error('Ungültige Gerätemeldung.');
 const controls=item.controls;
 if(controls!==undefined&&(!controls||typeof controls!=='object'||Array.isArray(controls)))throw new Error('Ungültiger Gerätestatus.');
 const state=controls as Record<string,unknown>|undefined;
 if(state&&(!inRange(state.speed,5,160)||!inRange(state.fontSize,20,100)||item.role!=='prompter'))throw new Error('Ungültiger Gerätestatus.');
 return {id:item.id,name:item.name.trim(),role:String(item.role),status:item.status,ack:[...new Set(item.ack as string[])],speed:state?state.speed as number:null,fontSize:state?state.fontSize as number:null};
}
export function parseCommand(input:unknown) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Ungültiger Befehl.');
 const item=input as Record<string,unknown>;
 if(!['load','play','pause','reset','set_speed','set_font_size'].includes(String(item.type)))throw new Error('Befehl wird nicht unterstützt.');
 if(item.type==='load'&&!isUuid(item.projectId))throw new Error('Skript ist ungültig.');
 if(item.type==='set_speed'&&!inRange(item.value,5,160))throw new Error('Tempo muss zwischen 5 und 160 liegen.');
 if(item.type==='set_font_size'&&!inRange(item.value,20,100))throw new Error('Schriftgröße muss zwischen 20 und 100 liegen.');
 if(item.type!=='set_speed'&&item.type!=='set_font_size'&&item.value!==undefined)throw new Error('Unerwarteter Befehlswert.');
 return {type:String(item.type),projectId:item.type==='load'?item.projectId as string:null,value:item.type==='set_speed'||item.type==='set_font_size'?item.value as number:null};
}
