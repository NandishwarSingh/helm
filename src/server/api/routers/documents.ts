import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";

import { conn, db } from "@/server/db";
import { documents } from "@/server/db/schema";
import { mapLimit } from "@/server/lib/concurrency";
import { extractDocText } from "@/server/lib/doc-text";
import { scanAllDocuments } from "@/server/lib/documents";
import { fetchAttachmentBytes } from "@/server/lib/gmail-attachments";
import { embedQuery, toVectorLiteral } from "@/server/lib/embeddings";
import { notifyTenant } from "@/server/lib/realtime";
import { getAccountClients } from "@/server/lib/tenant";
import { opAccount, readClients } from "@/server/api/routers/gmail";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

const accountInput = z.string().max(64).optional();
const categorySchema = z.enum([
  "all",
  "pdf",
  "image",
  "doc",
  "sheet",
  "slide",
  "archive",
  "audio",
  "video",
  "other",
]);

export const documentsRouter = createTRPCRouter({
  // Pinned-first, then newest. account "all"/omitted = every owned account.
  list: authedProcedure
    .input(
      z.object({
        category: categorySchema.default("all"),
        account: accountInput,
        limit: z.number().min(1).max(300).default(60),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const clients = await readClients(input.account);
      if (clients.length === 0) return { items: [], hasMore: false };
      const accountIds = clients.map((c) => c.accountId);
      const emailByAccount = new Map(clients.map((c) => [c.accountId, c.email]));
      const rows = await db
        .select()
        .from(documents)
        .where(
          and(
            inArray(documents.accountId, accountIds),
            input.category === "all"
              ? undefined
              : eq(documents.category, input.category),
          ),
        )
        .orderBy(
          desc(documents.pinned),
          desc(documents.pinnedAt),
          desc(documents.receivedAt),
        )
        .limit(input.limit + 1)
        .offset(input.offset);
      const items = rows.slice(0, input.limit).map((r) => ({
        ...r,
        accountEmail: emailByAccount.get(r.accountId) ?? "",
      }));
      return { items, hasMore: rows.length > input.limit };
    }),

  // Category counts for the filter chips, scoped like list.
  facets: authedProcedure
    .input(z.object({ account: accountInput }))
    .query(async ({ input }) => {
      const counts: Record<string, number> = {};
      const clients = await readClients(input.account);
      if (clients.length === 0) return { counts, total: 0 };
      const rows = await db
        .select({ category: documents.category, count: sql<number>`count(*)::int` })
        .from(documents)
        .where(inArray(documents.accountId, clients.map((c) => c.accountId)))
        .groupBy(documents.category);
      let total = 0;
      for (const r of rows) {
        counts[r.category] = r.count;
        total += r.count;
      }
      return { counts, total };
    }),

  // Per-tenant cosine KNN over doc_embeddings, merged across accounts, hydrated.
  vectorSearch: authedProcedure
    .input(
      z.object({
        query: z.string().max(256),
        account: accountInput,
        category: categorySchema.default("all"),
        limit: z.number().min(1).max(100).default(40),
      }),
    )
    .query(async ({ input }) => {
      const clients = await readClients(input.account);
      if (clients.length === 0 || !input.query.trim()) return { items: [] };
      const literal = toVectorLiteral(await embedQuery(input.query));
      const cat = input.category;
      const per = await mapLimit(clients, 4, async (c) => {
        try {
          // Join the doc metadata so the category filter rides INSIDE the KNN —
          // filtering after a global top-K would under-return (often near-empty)
          // when a type chip is active. attachment_key = message_id:attachment_id.
          const rows = await conn<{ attachment_key: string; score: number }[]>`
            select e.attachment_key, 1 - (e.embedding <=> ${literal}::vector) as score
            from doc_embeddings e
            join documents d
              on d.tenant_id = e.tenant_id
             and (d.message_id || ':' || d.attachment_id) = e.attachment_key
            where e.tenant_id = ${c.tenantId}
              ${cat === "all" ? conn`` : conn`and d.category = ${cat}`}
            order by e.embedding <=> ${literal}::vector
            limit ${input.limit}
          `;
          return rows.map((r) => ({
            accountId: c.accountId,
            attachmentKey: r.attachment_key,
            score: Number(r.score),
          }));
        } catch {
          // One account's vector failure must not 500 the whole search.
          return [];
        }
      });
      const hits = per
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit);
      if (hits.length === 0) return { items: [] };
      const accountIds = clients.map((c) => c.accountId);
      const msgIds = [
        ...new Set(hits.map((h) => h.attachmentKey.split(":")[0]!)),
      ];
      const rows = await db
        .select()
        .from(documents)
        .where(
          and(
            inArray(documents.accountId, accountIds),
            inArray(documents.messageId, msgIds),
          ),
        );
      const byKey = new Map(
        rows.map((r) => [
          `${r.accountId}:${r.messageId}:${r.attachmentId}`,
          r,
        ]),
      );
      const emailByAccount = new Map(clients.map((c) => [c.accountId, c.email]));
      // Category is already enforced in the KNN join, so no JS post-filter here.
      const items = hits
        .map((h) => byKey.get(`${h.accountId}:${h.attachmentKey}`))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ ...r, accountEmail: emailByAccount.get(r.accountId) ?? "" }));
      return { items };
    }),

  // Pin / unpin one doc. requireAccount refuses an ambiguous multi-account op.
  setPin: authedProcedure
    .input(
      z.object({
        messageId: z.string().min(1),
        attachmentId: z.string().min(1),
        account: accountInput,
        pinned: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const { tenantId } = await opAccount(input.account, { requireAccount: true });
      await db
        .update(documents)
        .set({ pinned: input.pinned, pinnedAt: input.pinned ? new Date() : null })
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.messageId, input.messageId),
            eq(documents.attachmentId, input.attachmentId),
          ),
        );
      return { ok: true };
    }),

  // Extract the text of one mail attachment for the agent to reason over (attach
  // a doc to a chat). Ownership-scoped via opAccount + a documents-row check;
  // bytes are fetched live and never stored.
  extractText: authedProcedure
    .input(
      z.object({
        account: accountInput,
        messageId: z.string().min(1),
        attachmentId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { tenantId } = await opAccount(input.account, { requireAccount: true });
      const [row] = await db
        .select({ filename: documents.filename, mimeType: documents.mimeType })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.messageId, input.messageId),
            eq(documents.attachmentId, input.attachmentId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Attachment not found." });
      }
      const bytes = await fetchAttachmentBytes(
        tenantId,
        input.messageId,
        input.attachmentId,
      );
      if (!bytes) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not fetch that attachment.",
        });
      }
      const text = await extractDocText(row.mimeType, row.filename, bytes);
      if (!text.trim()) {
        throw new TRPCError({
          code: "UNPROCESSABLE_CONTENT",
          message: "No readable text in that attachment.",
        });
      }
      return { name: row.filename, mimeType: row.mimeType, text: text.slice(0, 8000) };
    }),

  // Manual "scan now" (realtime also auto-scans on new mail). Fire-and-forget so
  // a multi-account scan (per-account Gmail full-gets + extraction + embeds) can't
  // block the request past a proxy timeout; the SSE "documents" event refreshes
  // the view when each tenant's scan settles. Scans are coalesced per tenant, so
  // a concurrent realtime scan and this one share a single run.
  // deep=true pages Gmail's full has:attachment history (manual "Scan now" + the
  // first open of a mailbox); deep=false is the cheap recent-cache pass used by
  // routine re-opens. Both coalesce per tenant and skip already-cataloged mail,
  // so a repeat scan only does work for genuinely-new attachments.
  scan: authedProcedure
    .input(z.object({ deep: z.boolean().default(true) }).optional())
    .mutation(async ({ input }) => {
      const deep = input?.deep ?? true;
      const clients = await getAccountClients();
      after(() =>
        scanAllDocuments(clients, { deep }).finally(() => {
          for (const c of clients) notifyTenant(c.tenantId, "documents");
        }),
      );
      return { ok: true };
    }),
});
