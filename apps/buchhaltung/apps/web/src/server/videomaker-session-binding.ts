import { eq } from "drizzle-orm";
import { auth } from "./auth.ts";
import { db, schema } from "./db/index.ts";

/** null means no Haben session; an empty value means a session exists without a binding. */
export async function currentVideomakerReference(request: Request): Promise<string | null> {
  const current = await auth().api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
  if (!current) return null;
  const [binding] = await db.select({ reference: schema.videomakerSessionBindings.reference })
    .from(schema.videomakerSessionBindings).where(eq(schema.videomakerSessionBindings.sessionId, current.session.id));
  return binding?.reference ?? "";
}
