import { appPath } from "../lib/app-path.ts";

type GuardConfig = { mode: string | undefined; endpoint: string | undefined; secret: string | undefined };
type GuardFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Nur ausdrücklich aktivieren: die lokale Haben-Anmeldung bleibt ansonsten wie bei Upstream. */
const configuration = (): GuardConfig => ({
  mode: process.env.HABEN_VIDEOMAKER_SESSION_GUARD,
  endpoint: process.env.HABEN_VIDEOMAKER_SESSION_URL,
  secret: process.env.HABEN_VIDEOMAKER_INTERNAL_SECRET,
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
      url.protocol !== "http:" ||
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

/**
 * Bei aktivierter Video-Maker-Sitzungsprüfung keinen gecachten Erfolg verwenden. Die Prüfung
 * ergänzt die Haben-Anmeldung; sie erzeugt selbst keine Haben-Sitzung oder OIDC-Identität.
 */
export async function guardVideomakerSession(request: Request, config = configuration(), send: GuardFetch = fetch): Promise<Response | null> {
  if (!config.mode || config.mode === "off") return null;
  const endpoint = endpointUrl(config.endpoint);
  if (config.mode !== "required" || !endpoint || !config.secret || config.secret.length < 32) {
    return new Response("Die Video-Maker-Sitzungsprüfung ist nicht verfügbar.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (independentlyAuthenticated(request)) return null;
  const cookie = sessionCookie(request);
  if (!cookie) return new Response("Bitte bei Video-Maker anmelden.", { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const response = await send(endpoint, {
      method: "GET",
      headers: { cookie, "X-Videomaker-Internal-Secret": config.secret },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 204) return null;
    if (response.status === 401 || response.status === 403) {
      return new Response("Bitte bei Video-Maker anmelden.", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    // Keine Zugangsdaten, URLs oder Fehlerobjekte mit Anfragedaten protokollieren.
  }
  return new Response("Die Video-Maker-Sitzungsprüfung ist nicht verfügbar.", { status: 503, headers: { "Cache-Control": "no-store" } });
}
