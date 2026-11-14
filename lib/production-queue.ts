import type Database from 'better-sqlite3';

export const PRODUCTION_QUEUE_LIMIT = 8;
export type ProductionQueueItem = {id:string;title:string;createdAt:string;channelIds:string[]};

/** These are projects without an indexed server recording, not editorial approvals. */
export function listProductionQueue(database:Database.Database,channel:string) {
 if(channel && channel!=='unassigned' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channel))throw new Error('Ungültiger Kanal.');
 return database.transaction(()=>{
  const filter=`NOT EXISTS (SELECT 1 FROM project_recordings r WHERE r.project_id=p.id)
    AND (?='' OR (?='unassigned' AND NOT EXISTS (SELECT 1 FROM project_channels pc WHERE pc.project_id=p.id))
      OR EXISTS (SELECT 1 FROM project_channels pc WHERE pc.project_id=p.id AND pc.channel_id=?))`;
  const count=database.prepare(`SELECT count(*) AS count FROM projects p WHERE ${filter}`).get(channel,channel,channel) as {count:number};
  const projects=database.prepare(`SELECT p.id,p.title,p.created_at AS createdAt FROM projects p WHERE ${filter} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`).all(channel,channel,channel,PRODUCTION_QUEUE_LIMIT) as Omit<ProductionQueueItem,'channelIds'>[];
  const channels=database.prepare('SELECT channel_id FROM project_channels WHERE project_id=? ORDER BY channel_id');
  return {total:count.count,items:projects.map(project=>({...project,channelIds:(channels.all(project.id) as {channel_id:string}[]).map(row=>row.channel_id)}))};
 })();
}
