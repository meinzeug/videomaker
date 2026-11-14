CREATE TABLE "videomaker_session_bindings" (
  "session_id" text PRIMARY KEY NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "reference" text NOT NULL,
  CONSTRAINT "videomaker_session_reference_format" CHECK ("reference" ~ '^[A-Za-z0-9_-]{43}$')
);
