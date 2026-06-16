-- Semantic search store. Lives outside drizzle's tablesFilter allowlist, so
-- drizzle never tries to manage/drop it; applied idempotently via `db:vector`
-- (runs after `db:migrate` on deploy). Requires the pgvector extension package
-- to be present on the server (postgresql-17-pgvector on the VPS; `brew install
-- pgvector` locally).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "mail_embeddings" (
  "tenant_id" text NOT NULL,
  "message_id" text NOT NULL,
  "content_hash" text NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "message_id")
);

-- Cosine KNN index (HNSW). 1536 dims stays under pgvector's 2000-dim cap.
CREATE INDEX IF NOT EXISTS "mail_embeddings_hnsw_idx"
  ON "mail_embeddings" USING hnsw ("embedding" vector_cosine_ops);
