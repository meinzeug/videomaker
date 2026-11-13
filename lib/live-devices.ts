export const isUuid=(id:unknown):id is string=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export type DeviceCommand = {id:string; type:'load'|'play'|'pause'|'reset'; projectId:string|null};
export function parseHeartbeat(input:unknown) {
 if(!input||typeof input!=='object')throw new Error('Ungültiges Gerät.');
 const item=input as Record<string,unknown>;
 if(!isUuid(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name.length>80||!['camera','prompter'].includes(String(item.role))||typeof item.status!=='string'||item.status.length>120||!Array.isArray(item.ack)||item.ack.length>32||item.ack.some(id=>!isUuid(id)))throw new Error('Ungültige Gerätemeldung.');
 return {id:item.id,name:item.name.trim(),role:String(item.role),status:item.status,ack:[...new Set(item.ack as string[])]};
}
export function parseCommand(input:unknown) {
 if(!input||typeof input!=='object')throw new Error('Ungültiger Befehl.');
 const item=input as Record<string,unknown>;
 if(!['load','play','pause','reset'].includes(String(item.type)))throw new Error('Befehl wird nicht unterstützt.');
 if(item.type==='load'&&!isUuid(item.projectId))throw new Error('Skript ist ungültig.');
 return {type:String(item.type),projectId:item.type==='load'?item.projectId as string:null};
}
