import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { conn, db } from "@/server/db";
import { documents } from "@/server/db/schema";
import { mapLimit } from "@/server/lib/concurrency";
import { scanAllDocuments } from "@/server/lib/documents";
import { embedQuery, toVectorLiteral } from "@/server/lib/embeddings";
import { fetchAttachmentBytes } from "@/server/lib/gmail-attachments";
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
        limit: z.number().min(1).max(200).default(60),
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
      const per = await mapLimit(clients, 4, async (c) => {
        try {
          const rows = await conn<{ attachment_key: string; score: number }[]>`
            select attachment_key, 1 - (embedding <=> ${literal}::vector) as score
            from doc_embeddings where tenant_id = ${c.tenantId}
            order by embedding <=> ${literal}::vector limit ${input.limit}
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
      const items = hits
        .map((h) => byKey.get(`${h.accountId}:${h.attachmentKey}`))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .filter((r) => input.category === "all" || r.category === input.category)
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

  // Bytes for the explicit Download button (base64). Preview streams via a route.
  download: authedProcedure
    .input(
      z.object({
        messageId: z.string().min(1),
        attachmentId: z.string().min(1),
        account: accountInput,
      }),
    )
    .mutation(async ({ input }) => {
      const { tenantId } = await opAccount(input.account, { requireAccount: true });
      const bytes = await fetchAttachmentBytes(
        tenantId,
        input.messageId,
        input.attachmentId,
      );
      if (!bytes) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "attachment bytes unavailable",
        });
      }
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
      return {
        filename: row?.filename ?? "attachment",
        mimeType: row?.mimeType ?? "application/octet-stream",
        base64: bytes.toString("base64"),
      };
    }),

  // Manual "scan now" (realtime also auto-scans on new mail).
  scan: authedProcedure.mutation(async () =>
    scanAllDocuments(await getAccountClients()),
  ),
});
