import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { mailSync } from "@/server/db/schema";
import {
  isNotConnectedError,
  listOrEmpty,
} from "@/server/lib/corsair-errors";
import {
  encodeRawEmail,
  extractBodyFromPayload,
  extractHtmlFromPayload,
  getHeader,
} from "@/server/lib/email";
import { getTenantId } from "@/server/lib/session";
import { getTenant } from "@/server/lib/tenant";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

const paginationSchema = z.object({
  limit: z.number().min(1).max(100).default(50),
  offset: z.number().min(0).default(0),
});

function messageTimestamp(
  internalDate?: string | null,
  createdAt?: Date | null,
): number {
  if (internalDate) return Number(internalDate);
  if (createdAt) return createdAt.getTime();
  return 0;
}

function mapMessage(message: {
  entity_id: string;
  data: {
    threadId?: string;
    snippet?: string;
    subject?: string;
    from?: string;
    to?: string;
    body?: string;
    internalDate?: string;
    createdAt?: Date | null;
  };
}) {
  return {
    id: message.entity_id,
    threadId: message.data.threadId ?? "",
    snippet: message.data.snippet ?? "",
    subject: message.data.subject ?? "",
    from: message.data.from ?? "",
    to: message.data.to ?? "",
    date: message.data.internalDate ?? null,
    timestamp: messageTimestamp(
      message.data.internalDate,
      message.data.createdAt,
    ),
  };
}

function sortMessagesNewestFirst<
  T extends { timestamp: number },
>(messages: T[]): T[] {
  return [...messages].sort((a, b) => b.timestamp - a.timestamp);
}

function dedupeByEntityId<
  T extends { entity_id: string; updated_at: Date },
>(items: T[]): T[] {
  const byEntityId = new Map<string, T>();
  for (const item of items) {
    const existing = byEntityId.get(item.entity_id);
    if (!existing || item.updated_at > existing.updated_at) {
      byEntityId.set(item.entity_id, item);
    }
  }
  return Array.from(byEntityId.values());
}

type Tenant = Awaited<ReturnType<typeof getTenant>>;
const SYNC_CONCURRENCY = 10;
const SYNC_PAGE_SIZE = 40;

// Gmail's messages.list returns only id/threadId stubs, so each id is hydrated
// with metadata (from, subject, snippet, date) for the list view.
async function hydrateMessages(tenant: Tenant, ids: string[]) {
  for (let i = 0; i < ids.length; i += SYNC_CONCURRENCY) {
    await Promise.all(
      ids.slice(i, i + SYNC_CONCURRENCY).map((id) =>
        tenant.gmail.api.messages
          .get({ id, format: "metadata" })
          .catch(() => null),
      ),
    );
  }
}

function messageIds(result: { messages?: { id?: string | null }[] }): string[] {
  return (result.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));
}

// Persists the Gmail page cursor so syncMore can page deeper than the cache.
async function setSyncCursor(tenantId: string, token: string | null) {
  await db
    .insert(mailSync)
    .values({ tenantId, nextPageToken: token })
    .onConflictDoUpdate({
      target: mailSync.tenantId,
      set: { nextPageToken: token, updatedAt: new Date() },
    });
}

export const gmailRouter = createTRPCRouter({
  searchEmails: publicProcedure
    .input(
      z.object({
        query: z.string(),
        cursor: z.number().min(0).default(0),
        limit: z.number().min(1).max(50).default(25),
      }),
    )
    .query(async ({ input }) => {
      const messages = await listOrEmpty(async () => {
        const tenant = await getTenant();
        return input.query.trim()
          ? tenant.gmail.db.messages.search({
              data: {
                snippet: { contains: input.query },
              },
              limit: input.limit,
              offset: input.cursor,
            })
          : tenant.gmail.db.messages.list({
              limit: input.limit,
              offset: input.cursor,
            });
      });

      const items = sortMessagesNewestFirst(
        dedupeByEntityId(messages).map(mapMessage),
      );
      // A full page implies there may be more cached rows to page through.
      const nextCursor =
        messages.length === input.limit ? input.cursor + input.limit : null;
      return { items, nextCursor };
    }),

  getMessage: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const tenant = await getTenant();
        // Always fetch the full message so the open view consistently has both
        // the rich HTML and a plain-text fallback (the list cache holds neither).
        const message = await tenant.gmail.api.messages.get({
          id: input.id,
          format: "full",
        });

        const headers = message.payload?.headers;
        const body =
          extractBodyFromPayload(message.payload) || (message.snippet ?? "");
        const html = extractHtmlFromPayload(message.payload);

        return {
          id: message.id ?? input.id,
          threadId: message.threadId ?? "",
          subject: getHeader(headers, "Subject"),
          from: getHeader(headers, "From"),
          to: getHeader(headers, "To"),
          body,
          html,
          snippet: message.snippet ?? "",
          date:
            message.internalDate != null ? String(message.internalDate) : null,
        };
      } catch (error) {
        if (isNotConnectedError(error)) return null;
        throw error;
      }
    }),

  listDrafts: publicProcedure
    .input(paginationSchema)
    .query(async ({ input }) => {
      const drafts = await listOrEmpty(async () => {
        const tenant = await getTenant();
        return tenant.gmail.db.drafts.list({
          limit: input.limit,
          offset: input.offset,
        });
      });

      return dedupeByEntityId(drafts).map((draft) => ({
        id: draft.entity_id,
        messageId: draft.data.messageId ?? "",
        createdAt: draft.data.createdAt ?? null,
      }));
    }),

  // Fresh sync: walk Gmail pages up to a cap, hydrate, and reset the cursor.
  refreshInbox: publicProcedure.mutation(async () => {
    const tenant = await getTenant();
    const tenantId = await getTenantId();
    if (!tenantId) return { synced: 0 };

    const CAP = 120;
    let pageToken: string | undefined;
    let total = 0;
    do {
      const result = await tenant.gmail.api.messages.list({
        maxResults: SYNC_PAGE_SIZE,
        pageToken,
      });
      const ids = messageIds(result);
      await hydrateMessages(tenant, ids);
      total += ids.length;
      pageToken = result.nextPageToken ?? undefined;
    } while (pageToken && total < CAP);

    await setSyncCursor(tenantId, pageToken ?? null);
    return { synced: total };
  }),

  // Pages deeper into Gmail when the cached list is exhausted (infinite scroll).
  syncMore: publicProcedure.mutation(async () => {
    const tenant = await getTenant();
    const tenantId = await getTenantId();
    if (!tenantId) return { synced: 0, hasMore: false };

    const [state] = await db
      .select()
      .from(mailSync)
      .where(eq(mailSync.tenantId, tenantId));
    const token = state?.nextPageToken;
    if (!token) return { synced: 0, hasMore: false };

    const result = await tenant.gmail.api.messages.list({
      maxResults: SYNC_PAGE_SIZE,
      pageToken: token,
    });
    await hydrateMessages(tenant, messageIds(result));
    await setSyncCursor(tenantId, result.nextPageToken ?? null);

    return {
      synced: messageIds(result).length,
      hasMore: Boolean(result.nextPageToken),
    };
  }),

  createDraft: publicProcedure
    .input(
      z.object({
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const raw = encodeRawEmail(input);
      const draft = await tenant.gmail.api.drafts.create({
        draft: { message: { raw } },
      });
      return {
        id: draft.id ?? "",
        messageId: draft.message?.id ?? "",
      };
    }),

  sendDraft: publicProcedure
    .input(z.object({ draftId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const message = await tenant.gmail.api.drafts.send({ id: input.draftId });
      return {
        id: message.id ?? "",
        threadId: message.threadId ?? "",
      };
    }),

  sendEmail: publicProcedure
    .input(
      z.object({
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const raw = encodeRawEmail(input);
      const message = await tenant.gmail.api.messages.send({ raw });
      return {
        id: message.id ?? "",
        threadId: message.threadId ?? "",
      };
    }),
});
