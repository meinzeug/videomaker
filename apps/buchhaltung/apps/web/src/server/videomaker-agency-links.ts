import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, type Tx } from "./db/index.ts";
import { withActor } from "./db/actor.ts";
import { UserError } from "./errors.ts";
import { validAgencyCatalogItem, type AgencyCatalogItem } from "./videomaker-catalog-tickets.ts";

export type AgencySubject = { kind: "document" | "invoice" | "journal"; id: string };
const subjectSchema = {
  document: { table: "documents", column: "document_id" },
  invoice: { table: "invoices", column: "invoice_id" },
  journal: { table: "journal_entries", column: "journal_entry_id" },
} as const;
type LinkRow = { id: string; target_kind: AgencyCatalogItem["kind"]; target_id: string; target_name: string; target_platform: string | null };
const itemKey = (item: AgencyCatalogItem) => `${item.kind}\0${item.id}`;
/** Stable version prevents a stale tab from silently overwriting a newer assignment. */
export function agencyLinksVersion(items: AgencyCatalogItem[]): string {
  const values=items.map(item=>[item.kind,item.id,item.name,item.platform] as const).sort((a,b)=>{
    const left=JSON.stringify(a),right=JSON.stringify(b);return left<right?-1:left>right?1:0;
  });
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
function subjectParts(subject: AgencySubject) {
  const part = subjectSchema[subject.kind];
  if (!part || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(subject.id)) throw new UserError("Ungültige Buchhaltungszuordnung.");
  return part;
}

/** Returns only metadata; it never reads or alters accounting amounts or documents. */
export async function listAgencyLinks(subject: AgencySubject): Promise<AgencyCatalogItem[]> {
  const part=subjectParts(subject);
  const rows = await db.execute(sql`select target_kind, target_id, target_name, target_platform from videomaker_agency_links where ${sql.identifier(part.column)} = ${subject.id}::uuid order by target_kind, target_name, target_id`);
  return (rows as unknown as LinkRow[]).map(row => ({ kind: row.target_kind, id: row.target_id, name: row.target_name, platform: row.target_platform }));
}

/** Caller validates session-bound catalog tickets; the transaction records each change in Haben's audit log. */
export async function replaceAgencyLinks(actor: string, subject: AgencySubject, items: AgencyCatalogItem[], expectedVersion: string, recheck: () => Promise<boolean>): Promise<string> {
  const part=subjectParts(subject);
  if (!actor || !/^[a-f0-9]{64}$/.test(expectedVersion) || items.length > 100 || items.some(item => !validAgencyCatalogItem(item)) || new Set(items.map(itemKey)).size !== items.length)
    throw new UserError("Ungültige Agenturzuordnung.");
  return withActor(actor, async (tx: Tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`videomaker.agency:${subject.kind}:${subject.id}`}, 0))`);
    const subjectRows=await tx.execute(sql`select id from ${sql.identifier(part.table)} where id=${subject.id}::uuid for key share`);
    if (!subjectRows.length) throw new UserError("Der Buchhaltungseintrag wurde nicht gefunden.");
    const existing=await tx.execute(sql`select id,target_kind,target_id,target_name,target_platform from videomaker_agency_links where ${sql.identifier(part.column)}=${subject.id}::uuid`);
    const old=new Map((existing as unknown as LinkRow[]).map(row => [`${row.target_kind}\0${row.target_id}`,row]));
    const before=(existing as unknown as LinkRow[]).map(row=>({kind:row.target_kind,id:row.target_id,name:row.target_name,platform:row.target_platform}));
    if(agencyLinksVersion(before)!==expectedVersion)throw new UserError("Die Zuordnung wurde zwischenzeitlich geändert. Bitte neu laden.");
    const selected=new Set(items.map(itemKey));
    for (const [key,row] of old) if (!selected.has(key)) await tx.execute(sql`delete from videomaker_agency_links where id=${row.id}::uuid`);
    for (const item of items) {
      const row=old.get(itemKey(item));
      if (!row) await tx.execute(sql`insert into videomaker_agency_links (${sql.identifier(part.column)},target_kind,target_id,target_name,target_platform) values (${subject.id}::uuid,${item.kind},${item.id},${item.name},${item.platform})`);
      else if (row.target_name !== item.name || row.target_platform !== item.platform)
        await tx.execute(sql`update videomaker_agency_links set target_name=${item.name},target_platform=${item.platform} where id=${row.id}::uuid`);
    }
    // A cancelled/expired login or stale ticket aborts all writes and audit rows.
    if (!await recheck()) throw new UserError("Sitzung oder Katalogauswahl abgelaufen. Bitte erneut laden.");
    return agencyLinksVersion(items);
  });
}
