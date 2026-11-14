import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute } from "node:path";
import { appPath } from "../lib/app-path.ts";

type GuardConfig = { mode: string | undefined; endpoint: string | undefined; secret: string | undefined; caFile: string | undefined; bindingSecret?: string };
type GuardFetch = (endpoint: string, options: { cookie: string; secret: string; caFile: string; reference?: string }) => Promise<number>;
type BindingLookup = (request: Request) => Promise<string | null>;
const LIMIT = 16;
const STATE = Symbol.for("videomaker.haben.sessionGuard");
const shared = globalThis as typeof globalThis & { [STATE]?: { active: number; caReads: number; lookups?: number } };
shared[STATE] ??= { active: 0, caReads: 0, lookups: 0 };
const limits = shared[STATE];

/** A timeout frees the request; a stuck lookup still consumes one of two slots until it actually ends. */
async function boundedLookup(request: Request, lookup: BindingLookup): Promise<string | null> {
  if ((limits.lookups ?? 0) >= 2) throw new Error("Zu viele ausstehende Sitzungsprüfungen");
  limits.lookups = (limits.lookups ?? 0) + 1;
  const pending = Promise.resolve().then(() => lookup(request));
  void pending.then(() => { limits.lookups!--; }, () => { limits.lookups!--; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Zeitüberschreitung")), 2000); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Nur ausdrücklich aktivieren: die lokale Haben-Anmeldung bleibt ansonsten wie bei Upstream. */
const configuration = (): GuardConfig => ({
  mode: process.env.HABEN_VIDEOMAKER_SESSION_GUARD,
  endpoint: process.env.HABEN_VIDEOMAKER_SESSION_URL,
  secret: process.env.HABEN_VIDEOMAKER_INTERNAL_SECRET,
  caFile: process.env.HABEN_VIDEOMAKER_SESSION_CA_FILE,
  bindingSecret: process.env.HABEN_VIDEOMAKER_BINDING_SECRET,
});

/** Diese Endpunkte authentifizieren selbst per Bearer-Token bzw. validieren den OIDC-Callback. */
function independentlyAuthenticated(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === appPath("/api/mcp") || path.startsWith(appPath("/api/v1/")) || (request.method === "GET" && path === appPath("/api/auth/callback/oidc"));
}

/** Niemals fremde Cookies oder mehrere widersprüchliche Sitzungscookies weiterreichen. */
function sessionCookie(request: Request): string | null {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("kontrakurs_session="));
  if (values.length !== 1 || !/^kontrakurs_session=[A-Za-z0-9_.-]{1,512}$/.test(values[0]!)) return null;
  return values[0]!;
}

/** Der Identitätsdienst ist ausschließlich lokal erreichbar und hat einen festgelegten Endpunkt. */
function endpointUrl(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/api/internal/buchhaltung/session" ||
      url.search ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Begrenzter Speicherbedarf auch bei Gerätedateien, FIFOs oder während des Lesens wachsender Datei. */
async function readTrustedCa(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const limit = 64 * 1024;
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || (stat.mode & 0o022) !== 0 || (stat.uid !== 0 && stat.uid !== process.geteuid?.()))
      throw new Error("Ungültige CA-Datei");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (!offset || offset > limit) throw new Error("Ungültige CA-Datei");
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** Nur die konfigurierte CA und der feste DNS-Name authentifizieren die lokale Gegenstelle. */
async function verifiedRequest(endpoint: string, options: { cookie: string; secret: string; caFile: string; reference?: string }): Promise<number> {
  const signal = AbortSignal.timeout(2000);
  if (limits.caReads >= LIMIT) throw new Error("Zu viele CA-Lesevorgänge");
  limits.caReads++;
  const pendingCa = readTrustedCa(options.caFile);
  void pendingCa.then(
    () => {
      limits.caReads--;
    },
    () => {
      limits.caReads--;
    },
  );
  const ca = await Promise.race([
    pendingCa,
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Zeitüberschreitung")), { once: true })),
  ]);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      endpoint,
      {
        method: options.reference ? "POST" : "GET",
        headers: { cookie: options.cookie, "X-Videomaker-Internal-Secret": options.secret,
          ...(options.reference ? { "X-Oidc-Binding-Operation": "match", "X-Oidc-Session-Reference": options.reference, "Content-Length": "0" } : {}) },
        ca,
        servername: "videomaker-session.internal",
        rejectUnauthorized: true,
        agent: false,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status);
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

/**
 * Bei aktivierter Video-Maker-Sitzungsprüfung keinen gecachten Erfolg verwenden. Die Prüfung
 * ergänzt die Haben-Anmeldung; sie erzeugt selbst keine Haben-Sitzung oder OIDC-Identität.
 */
export async function guardVideomakerSession(request: Request, config = configuration(), send: GuardFetch = verifiedRequest, lookup: BindingLookup = async request => (await import("./videomaker-session-binding.ts")).currentVideomakerReference(request)): Promise<Response | null> {
  if (!config.mode || config.mode === "off") return null;
  const endpoint = endpointUrl(config.endpoint);
  if (config.mode !== "required" || !endpoint || !config.secret || config.secret.length < 32 || !config.caFile || !isAbsolute(config.caFile)) {
    return new Response("Die Video-Maker-Sitzungsprüfung ist nicht verfügbar.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (independentlyAuthenticated(request)) return null;
  const cookie = sessionCookie(request);
  if (!cookie) return new Response("Bitte bei Video-Maker anmelden.", { status: 401, headers: { "Cache-Control": "no-store" } });
  if (limits.active >= LIMIT)
    return new Response("Die Video-Maker-Sitzungsprüfung ist ausgelastet.", { status: 503, headers: { "Cache-Control": "no-store" } });
  limits.active++;
  try {
    const reference = await boundedLookup(request, lookup);
    if (reference !== null && !/^[A-Za-z0-9_-]{43}$/.test(reference))
      return new Response("Bitte erneut bei Video-Maker anmelden.", { status: 401, headers: { "Cache-Control": "no-store" } });
    if (reference !== null && (!config.bindingSecret || config.bindingSecret.length < 32 || config.bindingSecret.length > 256))
      return new Response("Die gebundene Video-Maker-Sitzungsprüfung ist nicht verfügbar.", { status: 503, headers: { "Cache-Control": "no-store" } });
    const bindingUrl = new URL(endpoint);
    bindingUrl.pathname = "/api/internal/oidc/session-binding";
    const status = reference === null
      ? await send(endpoint, { cookie, secret: config.secret, caFile: config.caFile })
      : await send(bindingUrl.href, { cookie, secret: config.bindingSecret!, caFile: config.caFile, reference });
    if (status === 204) return null;
    if (status === 401 || status === 403) {
      return new Response("Bitte bei Video-Maker anmelden.", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    // Keine Zugangsdaten, URLs oder Fehlerobjekte mit Anfragedaten protokollieren.
  } finally {
    limits.active--;
  }
  return new Response("Die Video-Maker-Sitzungsprüfung ist nicht verfügbar.", { status: 503, headers: { "Cache-Control": "no-store" } });
}
