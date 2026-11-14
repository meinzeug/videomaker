import { createHmac, timingSafeEqual } from "node:crypto";

/** Public display metadata only; the signed ticket is not a login credential. */
export type AgencyCatalogItem = { kind: "channel" | "project" | "platform"; id: string; name: string; platform: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unsafe = /[\u0000-\u001f\u007f]/;
const ttl = 120_000;
const digest = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value && !unsafe.test(value);

export function validAgencyCatalogItem(item: unknown): item is AgencyCatalogItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const x = item as Record<string, unknown>;
  if (!text(x.name, 160) || !text(x.id, 80) || !["channel", "project", "platform"].includes(x.kind as string)) return false;
  if ((x.kind === "channel" || x.kind === "project") && !uuid.test(x.id)) return false;
  if (x.kind === "project") return x.platform === null;
  if (!text(x.platform, 80)) return false;
  return x.kind !== "platform" || x.id === x.platform;
}

/** The caller must have verified this exact Videomaker session before issuing. */
export function issueAgencyTicket(secret: string, session: string, item: AgencyCatalogItem, now: number): string {
  if (secret.length < 32 || !text(session, 512) || !validAgencyCatalogItem(item) || !Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - ttl)
    throw new Error("Katalognachweis nicht verfügbar.");
  const binding = digest(secret, `videomaker-agency-session/v1\0${session}`);
  const safeItem={kind:item.kind,id:item.id,name:item.name,platform:item.platform};
  const payload = Buffer.from(JSON.stringify({ v: 1, item:safeItem, binding, expires: now + ttl })).toString("base64url");
  return `${payload}.${digest(secret, `videomaker-agency-ticket/v1\0${payload}`)}`;
}

/** A valid ticket never replaces a fresh authentication/session-guard check. */
export function verifyAgencyTicket(secret: string, session: string, ticket: string, now: number): AgencyCatalogItem | null {
  if (secret.length < 32 || !text(session, 512) || typeof ticket !== "string" || ticket.length > 2048 || !Number.isSafeInteger(now) || now < 0) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  if (!safeEqual(parts[1]!, digest(secret, `videomaker-agency-ticket/v1\0${parts[0]}`))) return null;
  try {
    const bytes = Buffer.from(parts[0]!, "base64url");
    if (bytes.toString("base64url") !== parts[0]) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (payload.v !== 1 || !validAgencyCatalogItem(payload.item) || typeof payload.binding !== "string" ||
        !safeEqual(payload.binding, digest(secret, `videomaker-agency-session/v1\0${session}`)) ||
        typeof payload.expires !== "number" || !Number.isSafeInteger(payload.expires) || payload.expires <= now || payload.expires - now > ttl) return null;
    return payload.item;
  } catch { return null; }
}
