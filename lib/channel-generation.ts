import type Database from 'better-sqlite3';

export type GenerationChannel={id:string;name:string;platform:string;handle:string};
export class InvalidGenerationChannel extends Error {}
export class GenerationChannelNotFound extends Error {}
export class ResearchChannelMismatch extends Error {}

/** The channel is a server-side record, never a client-supplied instruction. */
export function selectedGenerationChannel(database:Database.Database,value:unknown):GenerationChannel|null {
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new InvalidGenerationChannel('Kanalauswahl ist ungültig.');
 const channel=database.prepare('SELECT id,name,platform,handle FROM channels WHERE id=?').get(value.toLowerCase()) as GenerationChannel|undefined;
 if(!channel)throw new GenerationChannelNotFound('Der gewählte Kanal ist nicht mehr vorhanden. Bitte erneut auswählen.');
 return channel;
}

/** Bind both AI phases to the channel snapshot captured before research began.
 * Reports created by earlier releases have no binding and retain their old behavior. */
export function channelForResearch(database:Database.Database,report:unknown,value:unknown):GenerationChannel|null {
 if(!report||typeof report!=='object'||!Object.prototype.hasOwnProperty.call(report,'generation_channel'))return selectedGenerationChannel(database,value);
 const target=(report as Record<string,unknown>).generation_channel;
 if(target===null){if(value!==undefined&&value!==null&&value!=='')throw new ResearchChannelMismatch('Diese Recherche wurde ohne Kanal gestartet. Bitte für einen anderen Kanal erneut recherchieren.');return null;}
 if(!target||typeof target!=='object'||Array.isArray(target))throw new ResearchChannelMismatch('Der gespeicherte Recherchekanal ist ungültig.');
 const c=target as Record<string,unknown>;
 if(typeof c.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.id)||typeof c.name!=='string'||typeof c.platform!=='string'||typeof c.handle!=='string')throw new ResearchChannelMismatch('Der gespeicherte Recherchekanal ist ungültig.');
 if(typeof value!=='string'||value.toLowerCase()!==c.id)throw new ResearchChannelMismatch('Der gewählte Kanal passt nicht zur Recherche. Bitte erneut recherchieren.');
 return {id:c.id,name:c.name,platform:c.platform,handle:c.handle};
}

type Project={id:string;created_at:string;title:string;sources:unknown;content:Record<string,unknown>};
/** Save the script even if its chosen channel disappeared while the AI was running. */
export function saveGeneratedProject(database:Database.Database,project:Project,researchId:string,channel:GenerationChannel|null) {
 return database.transaction(()=>{
  const same=channel&&database.prepare('SELECT id,name,platform,handle FROM channels WHERE id=?').get(channel.id) as GenerationChannel|undefined|null;
  const assigned=!!(channel&&same&&same.name===channel.name&&same.platform===channel.platform&&same.handle===channel.handle);
  if(channel&&!assigned){
   const previous=Array.isArray(project.content.generation_warnings)?project.content.generation_warnings.filter((x):x is string=>typeof x==='string'):[];
   project.content={...project.content,generation_warnings:[...previous,'Der Kanal wurde während der Erstellung geändert oder entfernt. Das Skript wurde ohne Zuordnung gespeichert.']};
  }
  database.prepare('INSERT INTO projects(id,created_at,title,sources,content) VALUES(?,?,?,?,?)').run(project.id,project.created_at,project.title,JSON.stringify(project.sources),JSON.stringify(project.content));
  if(assigned)database.prepare('INSERT INTO project_channels(project_id,channel_id) VALUES(?,?)').run(project.id,channel!.id);
  database.prepare('DELETE FROM research_reports WHERE id=?').run(researchId);
  return {assigned,missing:!!channel&&!assigned};
 })();
}
