import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { csrfOptions } from "./server/csrf.ts";
import { withFrameAncestors } from "./server/security-headers.ts";
import { guardVideomakerSession } from "./server/videomaker-session.ts";

const videomakerSession = createMiddleware().server(async ({ request, next }) => {
  const denial = await guardVideomakerSession(request);
  if (denial) return denial;
  const result = await next();
  if (process.env.HABEN_VIDEOMAKER_SESSION_GUARD !== "required") return result;
  const headers = new Headers(result.response.headers);
  headers.set("Cache-Control", "private, no-store");
  return { ...result, response: new Response(result.response.body, { status: result.response.status, statusText: result.response.statusText, headers }) };
});

/** Läuft für jede Anfrage, Seiten wie API */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next();
  return { ...result, response: withFrameAncestors(result.response) };
});

export const startInstance = createStart(() => ({ requestMiddleware: [videomakerSession, createCsrfMiddleware(csrfOptions), securityHeaders] }));
