import { eq } from "drizzle-orm";
import { auth, authContextReady } from "./auth.ts";
import { authDatabase, withBoundedSessionLookup } from "./auth-transaction.ts";
import { schema } from "./db/index.ts";

/** null means no Haben session; an empty value means a session exists without a binding. */
export async function currentVideomakerReference(request: Request): Promise<string | null> {
  // Provider discovery happens before reserving a PostgreSQL connection.
  if (!(await authContextReady())) throw new Error("Authentifizierung nicht verfügbar");
  return withBoundedSessionLookup(async () => {
    const current = await auth().api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!current) return null;
    const [binding] = await authDatabase().select({ reference: schema.videomakerSessionBindings.reference })
      .from(schema.videomakerSessionBindings).where(eq(schema.videomakerSessionBindings.sessionId, current.session.id));
    return binding?.reference ?? "";
  });
}
