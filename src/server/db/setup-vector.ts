import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * Idempotently provisions the pgvector extension + mail_embeddings table.
 * Run after migrations on every deploy: `pnpm db:migrate && pnpm db:vector`.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const ddl = readFileSync(
  fileURLToPath(new URL("./pgvector.sql", import.meta.url)),
  "utf8",
);

// postgres.js runs one statement per call, so split the DDL on statement
// boundaries (the file has no `;` inside any statement body).
const statements = ddl
  .split(/;\s*$/m)
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0 && !statement.startsWith("--"));

const sql = postgres(url, { max: 1 });
try {
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
  console.log("[pgvector] extension + mail_embeddings ready");
} finally {
  await sql.end();
}
