export const platforms = ['youtube', 'tiktok', 'instagram', 'facebook', 'other'] as const;
export type Channel = { id:string; name:string; platform:string; handle:string; created_at:string };
export function parseChannel(input:unknown) {
 if(!input || typeof input!=='object') throw new Error('Ungültiger Kanal.');
 const item=input as Record<string,unknown>;
 if(typeof item.name!=='string' || !item.name.trim() || item.name.trim().length>100) throw new Error('Name muss zwischen 1 und 100 Zeichen lang sein.');
 if(typeof item.platform!=='string' || !item.platform.trim() || item.platform.trim().length>80 || /[\u0000-\u001f\u007f]/.test(item.platform)) throw new Error('Plattform ist ungültig.');
 if(typeof item.handle!=='string' || item.handle.trim().length>100) throw new Error('Kanalkennung ist ungültig.');
 return {name:item.name.trim(),platform:item.platform.trim(),handle:item.handle.trim()};
}
export function parseChannelIds(input:unknown):string[] {
 if(!Array.isArray(input) || input.length>100 || input.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error('Kanalauswahl ist ungültig.');
 return [...new Set(input)];
}
