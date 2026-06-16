import "server-only";
import { createHash } from "node:crypto";

import { conn } from "@/server/db";
import { embedQuery, embedTexts, toVectorLiteral } from "@/server/lib/embeddings";

/**
 * Semantic search over the locally-cached mailbox. Emails Corsair already
 * caches are embedded once (hash-deduped) into pgvector; queries embed the
 * search text and do a cosine KNN — sub-second, entirely local, no Gmail
 * round-trip. The embedding API runs off-box so the VPS carries no model.
 */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** What we embed per message: enough signal to match on meaning. */
export function embedText(parts: {
  subject: string;
  from: string;
  snippet: string;
}): string {
  return `${parts.subject}\n${parts.from}\n${parts.snippet}`.trim();
}

/**
 * Embed + store any messages whose content changed since last time (new rows,
 * or a hash mismatch). Returns how many were (re)embedded — 0 when everything
 * is already current, so it's cheap to call on every sync.
 */
export async function upsertMessageEmbeddings(
  tenantId: string,
  items: { messageId: string; text: string }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const withHash = items.map((item) => ({ ...item, hash: contentHash(item.text) }));
  const ids = withHash.map((item) => item.messageId);

  const existing = await conn<{ message_id: string; content_hash: string }[]>`
    select message_id, content_hash from mail_embeddings
    where tenant_id = ${tenantId} and message_id in ${conn(ids)}
  `;
  const known = new Map(existing.map((row) => [row.message_id, row.content_hash]));
  const todo = withHash.filter((item) => known.get(item.messageId) !== item.hash);
  if (todo.length === 0) return 0;

  const vectors = await embedTexts(todo.map((item) => item.text));
  for (let i = 0; i < todo.length; i++) {
    const item = todo[i]!;
    const literal = toVectorLiteral(vectors[i]!);
    await conn`
      insert into mail_embeddings (tenant_id, message_id, content_hash, embedding, updated_at)
      values (${tenantId}, ${item.messageId}, ${item.hash}, ${literal}::vector, now())
      on conflict (tenant_id, message_id) do update
        set content_hash = excluded.content_hash,
            embedding = excluded.embedding,
            updated_at = now()
    `;
  }
  return todo.length;
}

/** Cosine-KNN the query against this tenant's embedded mail. */
export async function semanticSearchIds(
  tenantId: string,
  query: string,
  limit: number,
): Promise<{ messageId: string; score: number }[]> {
  const literal = toVectorLiteral(await embedQuery(query));
  const rows = await conn<{ message_id: string; score: number }[]>`
    select message_id, 1 - (embedding <=> ${literal}::vector) as score
    from mail_embeddings
    where tenant_id = ${tenantId}
    order by embedding <=> ${literal}::vector
    limit ${limit}
  `;
  return rows.map((row) => ({ messageId: row.message_id, score: Number(row.score) }));
}
