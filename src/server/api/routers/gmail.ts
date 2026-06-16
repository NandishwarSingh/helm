import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { mailSync } from "@/server/db/schema";
import { purgeCachedEntity } from "@/server/lib/cache";
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
import { withRetry } from "@/server/lib/retry";
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
    labelIds?: string[];
  };
}) {
  const labels = message.data.labelIds ?? [];
  return {
    id: message.entity_id,
    threadId: message.data.threadId ?? "",
    snippet: message.data.snippet ?? "",
    subject: message.data.subject ?? "",
    from: message.data.from ?? "",
    to: message.data.to ?? "",
    date: message.data.internalDate ?? null,
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    spam: labels.includes("SPAM"),
    trashed: labels.includes("TRASH"),
    archived:
      labels.length > 0 &&
      !labels.includes("INBOX") &&
      !labels.includes("SPAM") &&
      !labels.includes("TRASH"),
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

const folderSchema = z
  .enum(["inbox", "starred", "archived", "spam", "trash"])
  .default("inbox");

type Folder = z.infer<typeof folderSchema>;
type MappedMessage = ReturnType<typeof mapMessage>;

const FOLDER_FILTERS: Record<Folder, (m: MappedMessage) => boolean> = {
  inbox: (m) => !m.archived && !m.trashed && !m.spam,
  starred: (m) => m.starred && !m.trashed && !m.spam,
  archived: (m) => m.archived,
  spam: (m) => m.spam,
  trash: (m) => m.trashed,
};

export const gmailRouter = createTRPCRouter({
  searchEmails: publicProcedure
    .input(
      z.object({
        query: z.string(),
        folder: folderSchema,
        cursor: z.number().min(0).default(0),
        limit: z.number().min(1).max(50).default(25),
      }),
    )
    .query(async ({ input }) => {
      const query = input.query.trim();
      const messages = await listOrEmpty(async () => {
        const tenant = await getTenant();
        if (!query) {
          return tenant.gmail.db.messages.list({
            limit: input.limit,
            offset: input.cursor,
          });
        }
        // The cache filters AND together, so match each field in parallel
        // and merge — a query hits snippet, subject, or sender.
        const fields = [
          { snippet: { contains: query } },
          { subject: { contains: query } },
          { from: { contains: query } },
        ];
        const results = await Promise.all(
          fields.map((data) =>
            tenant.gmail.db.messages.search({
              data,
              limit: input.limit,
              offset: input.cursor,
            }),
          ),
        );
        return results.flat();
      });

      // Folder membership is derived from cached Gmail labels (Corsair keeps
      // them current from modify responses), then filtered per folder.
      const items = sortMessagesNewestFirst(
        dedupeByEntityId(messages).map(mapMessage),
      )
        .filter(FOLDER_FILTERS[input.folder])
        .slice(0, input.limit);
      // A full page from any source implies more cached rows to page through.
      const nextCursor =
        messages.length >= input.limit ? input.cursor + input.limit : null;
      return { items, nextCursor };
    }),

  getMessage: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const tenant = await getTenant();
        // Always fetch the full message so the open view consistently has both
        // the rich HTML and a plain-text fallback (the list cache holds neither).
        const message = await withRetry(() =>
          tenant.gmail.api.messages.get({ id: input.id, format: "full" }),
        );

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

  // Label actions, mapped to Gmail label changes server-side.
  modifyMessage: publicProcedure
    .input(
      z.object({
        id: z.string().min(1),
        action: z.enum([
          "archive",
          "unarchive",
          "trash",
          "untrash",
          "star",
          "unstar",
          "read",
          "unread",
          "notSpam",
          "deleteForever",
        ]),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      if (input.action === "trash") {
        await withRetry(() => tenant.gmail.api.messages.trash({ id: input.id }));
        return { ok: true };
      }
      if (input.action === "untrash") {
        await withRetry(() =>
          tenant.gmail.api.messages.untrash({ id: input.id }),
        );
        return { ok: true };
      }
      if (input.action === "deleteForever") {
        await withRetry(() => tenant.gmail.api.messages.delete({ id: input.id }));
        const tenantId = await getTenantId();
        if (tenantId) await purgeCachedEntity(tenantId, input.id);
        return { ok: true };
      }
      const change: Record<
        typeof input.action,
        { add?: string[]; remove?: string[] }
      > = {
        archive: { remove: ["INBOX"] },
        unarchive: { add: ["INBOX"] },
        star: { add: ["STARRED"] },
        unstar: { remove: ["STARRED"] },
        read: { remove: ["UNREAD"] },
        unread: { add: ["UNREAD"] },
        notSpam: { add: ["INBOX"], remove: ["SPAM"] },
      };
      const { add, remove } = change[input.action];
      await withRetry(() =>
        tenant.gmail.api.messages.modify({
          id: input.id,
          addLabelIds: add,
          removeLabelIds: remove,
        }),
      );
      return { ok: true };
    }),

  // Bulk label actions over a multiselect, in one Gmail call.
  bulkModify: publicProcedure
    .input(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(50),
        action: z.enum([
          "archive",
          "unarchive",
          "trash",
          "star",
          "unstar",
          "read",
          "unread",
          "notSpam",
          "untrash",
        ]),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const change: Record<
        typeof input.action,
        { add?: string[]; remove?: string[] }
      > = {
        archive: { remove: ["INBOX"] },
        unarchive: { add: ["INBOX"] },
        trash: { add: ["TRASH"], remove: ["INBOX", "SPAM"] },
        star: { add: ["STARRED"] },
        unstar: { remove: ["STARRED"] },
        read: { remove: ["UNREAD"] },
        unread: { add: ["UNREAD"] },
        notSpam: { add: ["INBOX"], remove: ["SPAM"] },
        untrash: { add: ["INBOX"], remove: ["TRASH"] },
      };
      const { add, remove } = change[input.action];
      await withRetry(() =>
        tenant.gmail.api.messages.batchModify({
          ids: input.ids,
          addLabelIds: add,
          removeLabelIds: remove,
        }),
      );
      // batchModify returns void, so re-hydrate the affected messages to
      // keep cached labels truthful.
      await hydrateMessages(tenant, input.ids);
      return { ok: true, count: input.ids.length };
    }),

  // Permanently delete a multiselect (no batch endpoint upstream).
  bulkDelete: publicProcedure
    .input(z.object({ ids: z.array(z.string().min(1)).min(1).max(25) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const tenantId = await getTenantId();
      for (const id of input.ids) {
        await withRetry(() => tenant.gmail.api.messages.delete({ id }));
        if (tenantId) await purgeCachedEntity(tenantId, id);
      }
      return { ok: true, count: input.ids.length };
    }),

  // Spam and trash are excluded from the normal sync; pull them on demand
  // when those folders are opened.
  syncFolder: publicProcedure
    .input(z.object({ folder: z.enum(["spam", "trash"]) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const label = input.folder === "spam" ? "SPAM" : "TRASH";
      const result = await tenant.gmail.api.messages.list({
        maxResults: 30,
        labelIds: [label],
        includeSpamTrash: true,
      });
      const ids = messageIds(result);
      await hydrateMessages(tenant, ids);
      return { synced: ids.length };
    }),

  getDraft: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const tenant = await getTenant();
      const draft = await withRetry(() =>
        tenant.gmail.api.drafts.get({ id: input.id, format: "full" }),
      );
      const headers = draft.message?.payload?.headers;
      return {
        id: draft.id ?? input.id,
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        body: extractBodyFromPayload(draft.message?.payload),
      };
    }),

  updateDraft: publicProcedure
    .input(
      z.object({
        draftId: z.string().min(1),
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const raw = encodeRawEmail(input);
      const draft = await tenant.gmail.api.drafts.update({
        id: input.draftId,
        draft: { message: { raw } },
      });
      return { id: draft.id ?? input.draftId };
    }),

  deleteDraft: publicProcedure
    .input(z.object({ draftId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      await tenant.gmail.api.drafts.delete({ id: input.draftId });
      const tenantId = await getTenantId();
      if (tenantId) await purgeCachedEntity(tenantId, input.draftId);
      return { ok: true };
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
      // Gmail deletes the draft on send; mirror that in the cache.
      const tenantId = await getTenantId();
      if (tenantId) await purgeCachedEntity(tenantId, input.draftId);
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
