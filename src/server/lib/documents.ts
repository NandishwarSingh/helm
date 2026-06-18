import "server-only";
import { createHash } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { corsair } from "@/server/corsair";
import { conn, db } from "@/server/db";
import { documents, userAccounts } from "@/server/db/schema";
import { mapLimit } from "@/server/lib/concurrency";
import { categorize, extractDocText, isExtractable } from "@/server/lib/doc-text";
import {
  extractAttachments,
  getHeader,
  type RawAttachment,
} from "@/server/lib/email";
import { embedTexts, toVectorLiteral } from "@/server/lib/embeddings";
import { fetchAttachmentBytes } from "@/server/lib/gmail-attachments";
import { messageTimestamp } from "@/server/lib/mail-view";
import { withRetry } from "@/server/lib/retry";
import { type AccountClient } from "@/server/lib/tenant";

// Recent cached messages scanned per account; only NEW messages cost a
// format:"full" get + a bytes fetch (already-cataloged messages are skipped),
// capped so a backlog drains over scans — steady state is ~0 Gmail calls.
const SCAN_WINDOW = 400;
const SCAN_FULL_CAP = 40;
const READ_CONCURRENCY = 6;
// Don't buffer + parse attachments past this — catalog them, skip text extraction.
const MAX_EXTRACT_BYTES = 10 * 1024 * 1024;

function docHash(a: RawAttachment): string {
  return createHash("sha256")
    .update(`${a.filename}|${a.sizeBytes}|${a.attachmentId}`)
    .digest("hex")
    .slice(0, 32);
}

function docEmbedText(p: {
  filename: string;
  sender: string;
  subject: string;
  text: string;
}): string {
  return `${p.filename}\n${p.sender}\n${p.subject}\n${p.text}`.trim();
}

type DocRow = {
  tenantId: string;
  accountId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  sender: string;
  subject: string;
  receivedAt: Date | null;
  contentHash: string;
  textExtracted: boolean;
  embedText: string;
};

type CachedRow = {
  entity_id?: string | null;
  data?: { internalDate?: string | null } | null;
};
type FullMessage = {
  internalDate?: string | null;
  payload?: { headers?: { name?: string; value?: string }[] } | null;
};

// One in-flight scan per tenant. Realtime (scanTenantDocuments), the manual
// "Scan now" (scanAllDocuments), and a second tab all funnel through here, so
// concurrent triggers share one run instead of double-fetching Gmail + embeds.
const scanInFlight = new Map<string, Promise<{ found: number; embedded: number }>>();

/** Scan ONE account: catalog its attachments, extract + embed new ones. Coalesced per tenant. */
export function scanAccountDocuments(
  c: AccountClient,
): Promise<{ found: number; embedded: number }> {
  const existing = scanInFlight.get(c.tenantId);
  if (existing) return existing;
  const work = runAccountScan(c).finally(() => scanInFlight.delete(c.tenantId));
  scanInFlight.set(c.tenantId, work);
  return work;
}

async function runAccountScan(
  c: AccountClient,
): Promise<{ found: number; embedded: number }> {
  const known = await db
    .select({
      messageId: documents.messageId,
      attachmentId: documents.attachmentId,
      contentHash: documents.contentHash,
    })
    .from(documents)
    .where(eq(documents.tenantId, c.tenantId));
  const have = new Map(
    known.map((r) => [`${r.messageId}:${r.attachmentId}`, r.contentHash]),
  );
  // Messages that already have ≥1 cataloged attachment — skip them wholesale so
  // the SCAN_FULL_CAP budget is spent only on genuinely-new mail (and unchanged
  // rows are never re-written, preserving textExtracted/pins).
  const scannedMsgs = new Set(known.map((r) => r.messageId));

  const cached = (await Promise.resolve(
    c.client.gmail.db.messages.list({ limit: SCAN_WINDOW, offset: 0 }),
  ).catch(() => [])) as CachedRow[];
  // Corsair's db.messages.list has no ORDER BY, so sort newest-first here; the
  // cap then targets the most recent unseen messages and older ones drain on
  // subsequent scans.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of [...cached].sort(
    (a, b) =>
      messageTimestamp(b.data?.internalDate) -
      messageTimestamp(a.data?.internalDate),
  )) {
    const id = r.entity_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  let fulls = 0;
  const rows = await mapLimit(ids, READ_CONCURRENCY, async (id): Promise<DocRow[]> => {
    if (scannedMsgs.has(id)) return []; // already cataloged → no Gmail call, no re-write
    if (fulls >= SCAN_FULL_CAP) return [];
    fulls++;
    const full = (await withRetry(() =>
      c.client.gmail.api.messages.get({ id, format: "full" }),
    ).catch(() => null)) as FullMessage | null;
    if (!full?.payload) return [];
    const sender = getHeader(full.payload.headers, "From");
    const subject = getHeader(full.payload.headers, "Subject");
    const receivedAt = full.internalDate
      ? new Date(Number(full.internalDate))
      : null;
    const atts = extractAttachments(
      full.payload as Parameters<typeof extractAttachments>[0],
    ).filter((a) => !a.inline);
    return Promise.all(
      atts.map(async (a): Promise<DocRow> => {
        const key = `${id}:${a.attachmentId}`;
        const hash = docHash(a);
        let text = "";
        if (
          have.get(key) !== hash &&
          a.sizeBytes <= MAX_EXTRACT_BYTES &&
          isExtractable(a.mimeType, a.filename)
        ) {
          const bytes = await fetchAttachmentBytes(c.tenantId, id, a.attachmentId);
          if (bytes) text = await extractDocText(a.mimeType, a.filename, bytes);
        }
        return {
          tenantId: c.tenantId,
          accountId: c.accountId,
          messageId: id,
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          category: categorize(a.mimeType, a.filename),
          sizeBytes: a.sizeBytes,
          sender,
          subject,
          receivedAt,
          contentHash: hash,
          textExtracted: text.length > 0,
          embedText: docEmbedText({ filename: a.filename, sender, subject, text }),
        };
      }),
    );
  });
  const flat = rows.flat();
  await upsertDocuments(flat);
  const embedded = await upsertDocEmbeddings(c.tenantId, c.accountId, flat);
  return { found: flat.length, embedded };
}

/** Upsert attachment metadata. NEVER writes pinned/pinnedAt so a scan can't clear a pin. */
async function upsertDocuments(rows: DocRow[]): Promise<void> {
  for (const r of rows) {
    await db
      .insert(documents)
      .values({
        tenantId: r.tenantId,
        accountId: r.accountId,
        messageId: r.messageId,
        attachmentId: r.attachmentId,
        filename: r.filename,
        mimeType: r.mimeType,
        category: r.category,
        sizeBytes: r.sizeBytes,
        sender: r.sender,
        subject: r.subject,
        receivedAt: r.receivedAt,
        contentHash: r.contentHash,
        textExtracted: r.textExtracted,
      })
      .onConflictDoUpdate({
        target: [documents.tenantId, documents.messageId, documents.attachmentId],
        set: {
          filename: r.filename,
          mimeType: r.mimeType,
          category: r.category,
          sizeBytes: r.sizeBytes,
          sender: r.sender,
          subject: r.subject,
          receivedAt: r.receivedAt,
          contentHash: r.contentHash,
          textExtracted: r.textExtracted,
          indexedAt: new Date(),
        },
      });
  }
}

/** Embed + store changed docs (clone of upsertMessageEmbeddings, keyed by attachment_key). */
async function upsertDocEmbeddings(
  tenantId: string,
  accountId: string,
  rows: DocRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const withHash = rows.map((r) => ({
    key: `${r.messageId}:${r.attachmentId}`,
    text: r.embedText || r.filename,
    hash: r.contentHash,
  }));
  const keys = withHash.map((r) => r.key);
  const existing = await conn<{ attachment_key: string; content_hash: string }[]>`
    select attachment_key, content_hash from doc_embeddings
    where tenant_id = ${tenantId} and attachment_key in ${conn(keys)}
  `;
  const known = new Map(existing.map((r) => [r.attachment_key, r.content_hash]));
  const todo = withHash.filter((r) => known.get(r.key) !== r.hash);
  if (todo.length === 0) return 0;

  const vectors = await embedTexts(todo.map((r) => r.text));
  if (vectors.length !== todo.length) {
    throw new Error(
      `doc embeddings count mismatch: expected ${todo.length}, got ${vectors.length}`,
    );
  }
  await conn.begin(async (sql) => {
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i]!;
      const literal = toVectorLiteral(vectors[i]!);
      await sql`
        insert into doc_embeddings (tenant_id, account_id, attachment_key, content_hash, embedding, updated_at)
        values (${tenantId}, ${accountId}, ${r.key}, ${r.hash}, ${literal}::vector, now())
        on conflict (tenant_id, attachment_key) do update
          set content_hash = excluded.content_hash,
              account_id = excluded.account_id,
              embedding = excluded.embedding,
              updated_at = now()
      `;
    }
  });
  return todo.length;
}

/** Scan every owned account (manual "scan now" + first index). */
export async function scanAllDocuments(
  clients: AccountClient[],
): Promise<{ found: number; embedded: number }> {
  const results = await mapLimit(clients, READ_CONCURRENCY, (c) =>
    scanAccountDocuments(c).catch(() => ({ found: 0, embedded: 0 })),
  );
  return results.reduce(
    (acc, r) => ({ found: acc.found + r.found, embedded: acc.embedded + r.embedded }),
    { found: 0, embedded: 0 },
  );
}

/**
 * Realtime path: scan the account behind a webhook's tenant. Webhook pushes carry
 * NO session cookie, so the AccountClient is built directly from the tenant id —
 * NEVER via getAccountClients()/getUserAccounts() (those read the session and
 * return [] for an unauthenticated push, which silently skipped every scan).
 */
export async function scanTenantDocuments(tenantId: string): Promise<void> {
  const rows = await db
    .select({ accountId: userAccounts.id, email: userAccounts.email })
    .from(userAccounts)
    .where(eq(userAccounts.tenantId, tenantId));
  // user_accounts_tenant_uniq → 0 or 1 row. No row = a single-account (tenant)
  // session never promoted to a user, where account id == tenant id (matching
  // getUserAccounts' synthetic branch). documents.accountId is what list/facets/
  // vectorSearch filter on, so it MUST be the userAccounts.id when one exists.
  const clients: AccountClient[] =
    rows.length > 0
      ? rows.map((r) => ({
          accountId: r.accountId,
          tenantId,
          email: r.email,
          client: corsair.withTenant(tenantId),
        }))
      : [
          {
            accountId: tenantId,
            tenantId,
            email: "",
            client: corsair.withTenant(tenantId),
          },
        ];
  for (const c of clients) {
    await scanAccountDocuments(c).catch(() => undefined);
  }
}

/** Drop docs + their embeddings for permanently-deleted messages. */
export async function deleteMessageDocuments(
  tenantId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const rows = await db
    .select({
      messageId: documents.messageId,
      attachmentId: documents.attachmentId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        inArray(documents.messageId, messageIds),
      ),
    );
  await db
    .delete(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        inArray(documents.messageId, messageIds),
      ),
    );
  const keys = rows.map((r) => `${r.messageId}:${r.attachmentId}`);
  if (keys.length > 0) {
    await conn`delete from doc_embeddings where tenant_id = ${tenantId} and attachment_key in ${conn(keys)}`;
  }
}

/** Cascade Documents cleanup when an account is removed. */
export async function deleteTenantDocuments(tenantId: string): Promise<void> {
  await db.delete(documents).where(eq(documents.tenantId, tenantId));
  await conn`delete from doc_embeddings where tenant_id = ${tenantId}`;
}
