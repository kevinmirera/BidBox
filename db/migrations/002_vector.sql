-- OPTIONAL: pgvector support. Applied best-effort; the app does not depend on it.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS document_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        integer,
  section     text,
  content     text NOT NULL,
  embedding   vector(1024)
);
