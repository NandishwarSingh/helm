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
import {
  dedupeByEntityId,
  FOLDER_FILTERS,
  folderSchema,
  mapMessage,
  sortMessagesNewestFirst,
} from "@/server/lib/mail-view";
import { withRetry } from "@/server/lib/retry";
import {
  embedText,
  semanticSearchIds,
  upsertMessageEmbeddings,
} from "@/server/lib/semantic-search";
import { getTenantId } from "@/server/lib/session";
import { getTenant } from "@/server/lib/tenant";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

const paginationSchema = z.object({
  limit: z.number().min(1).max(100).default(50),
  offset: z.number().min(0).default(0),
});

// Cc/Bcc are comma-separated lists; each address must be a real email.
const emailList = z
  .string()
  .max(640)
  .optional()
  .refine(
    (value) =>
      !value ||
      value
        .split(",")
        .every((email) => z.string().email().safeParse(email.trim()).success),
    "Each Cc/Bcc address must be a valid email.",
  );

// Optional threading headers so a reply nests into its conversation.
const composeSchema = z.object({
  to: z.string().email().max(320),
  cc: emailList,
  bcc: emailList,
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
  threadId: z.string().max(64).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.string().max(4096).optional(),
});

type Tenant = Awaited<ReturnType<typeof getTenant>>;
const SYNC_CONCURRENCY = 10;
const SYNC_PAGE_SIZE = 40;
// The recency window the list view reads before sorting by date. Matches the
// other cache reads (triage's CACHE_WINDOW, syncNew) so every view sees the
// same messages. Mirrored as MAIL_WINDOW in gmail-panel.tsx (the client can't
// import this server-only module); the two must stay equal.
const MAIL_WINDOW = 300;
// Wider read used only to hydrate semantic-search hits (which can reach beyond
// the list window) back into full rows. Submit-driven, so the cost is rare.
const SEARCH_WINDOW = 2000;

// Gmail's messages.list returns only id/threadId stubs, so each id is hydrated
// with metadata (from, subject, snippet, date) for the list view. Each get
// retries before giving up — an unhydrated stub poisons the cache until the
// next full refresh. Returns how many ids hydrated successfully.
async function hydrateMessages(tenant: Tenant, ids: string[]): Promise<number> {
  let hydrated = 0;
  for (let i = 0; i < ids.length; i += SYNC_CONCURRENCY) {
    const results = await Promise.all(
      ids.slice(i, i + SYNC_CONCURRENCY).map((id) =>
        withRetry(() =>
          tenant.gmail.api.messages.get({ id, format: "metadata" }),
        ).catch(() => null),
      ),
    );
    hydrated += results.filter((result) => result !== null).length;
  }
  return hydrated;
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
  // The cache pages by update recency, so opening, starring or syncing a
  // message reshuffles any offset window — which made rows pop in and out.
  // Instead we read a fixed recency window, then derive a STABLE list ordered
  // by message date and serve a growing prefix of it. The same top-N comes
  // back on every refetch, so the list never flickers.
  searchEmails: authedProcedure
    .input(
      z.object({
        query: z.string().max(256),
        folder: folderSchema,
        limit: z.number().min(1).max(MAIL_WINDOW).default(40),
      }),
    )
    .query(async ({ input }) => {
      const query = input.query.trim();

      const window = await listOrEmpty(async () => {
        const tenant = await getTenant();
        if (!query) {
          return tenant.gmail.db.messages.list({ limit: MAIL_WINDOW, offset: 0 });
        }
        // The cache ANDs filters, so match each field separately and merge —
        // a query hits snippet, subject, or sender.
        const fields = [
          { snippet: { contains: query } },
          { subject: { contains: query } },
          { from: { contains: query } },
        ];
        const results = await Promise.all(
          fields.map((data) =>
            tenant.gmail.db.messages.search({ data, limit: MAIL_WINDOW, offset: 0 }),
          ),
        );
        return results.flat();
      });

      const all = sortMessagesNewestFirst(
        dedupeByEntityId(window).map(mapMessage),
      )
        .filter((message) => message.hydrated)
        .filter(FOLDER_FILTERS[input.folder]);

      return {
        items: all.slice(0, input.limit),
        // More already sitting in the window we can reveal by raising limit.
        hasMore: all.length > input.limit,
        // The recency window itself is full, so a deep sync may surface more.
        windowFull: window.length >= MAIL_WINDOW,
      };
    }),

  // Warm the semantic index: embed any cached messages that are new or changed
  // since last call. Hash-deduped, so steady state embeds nothing — cheap to
  // call after every sync. The client runs this in the background.
  reindexSearch: authedProcedure.mutation(async () => {
    const tenantId = await getTenantId();
    if (!tenantId) return { indexed: 0 };
    const window = await listOrEmpty(async () => {
      const tenant = await getTenant();
      return tenant.gmail.db.messages.list({ limit: SEARCH_WINDOW, offset: 0 });
    });
    const items = dedupeByEntityId(window)
      .map(mapMessage)
      .filter((message) => message.hydrated)
      .map((message) => ({
        messageId: message.id,
        text: embedText({
          subject: message.subject,
          from: message.from,
          snippet: message.snippet,
        }),
      }));
    const indexed = await upsertMessageEmbeddings(tenantId, items);
    return { indexed };
  }),

  // Semantic search: embed the query, cosine-KNN over this tenant's embedded
  // mail, then hydrate the hits from the cache in similarity order.
  semanticSearch: authedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(256),
        limit: z.number().min(1).max(100).default(40),
      }),
    )
    .query(async ({ input }) => {
      const tenantId = await getTenantId();
      if (!tenantId) return { items: [] };
      const hits = await semanticSearchIds(
        tenantId,
        input.query.trim(),
        input.limit,
      );
      if (hits.length === 0) return { items: [] };
      const window = await listOrEmpty(async () => {
        const tenant = await getTenant();
        return tenant.gmail.db.messages.list({ limit: SEARCH_WINDOW, offset: 0 });
      });
      const byId = new Map(
        dedupeByEntityId(window)
          .map(mapMessage)
          .filter((message) => message.hydrated)
          .map((message) => [message.id, message] as const),
      );
      const items = hits
        .map((hit) => byId.get(hit.messageId))
        .filter((message): message is NonNullable<typeof message> =>
          Boolean(message),
        );
      return { items };
    }),

  getMessage: authedProcedure
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

  listDrafts: authedProcedure
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
  refreshInbox: authedProcedure.mutation(async () => {
    const tenant = await getTenant();
    const tenantId = await getTenantId();
    if (!tenantId) return { synced: 0 };

    const CAP = 120;
    let pageToken: string | undefined;
    let seen = 0;
    let synced = 0;
    do {
      const result = await tenant.gmail.api.messages.list({
        maxResults: SYNC_PAGE_SIZE,
        pageToken,
      });
      const ids = messageIds(result);
      synced += await hydrateMessages(tenant, ids);
      seen += ids.length;
      pageToken = result.nextPageToken ?? undefined;
    } while (pageToken && seen < CAP);

    await setSyncCursor(tenantId, pageToken ?? null);
    // `synced` counts rows that actually hydrated, not ids merely fetched.
    return { synced };
  }),

  // Cheap top-up poll: one list call for the newest page, then hydrate only
  // ids the cache has never seen properly (also self-heals any stub rows a
  // failed sync left in the newest window).
  syncNew: authedProcedure.mutation(async () => {
    const tenant = await getTenant();
    // List the newest page FIRST. messages.list upserts bare id stubs; reading
    // the cache afterwards means any row the list call reset to a stub shows as
    // unhydrated and gets re-hydrated below — so a message is never left as a
    // stub the next list skips (which would silently drop it from the view).
    const result = await tenant.gmail.api.messages.list({
      maxResults: SYNC_PAGE_SIZE,
    });
    const cached = await listOrEmpty(async () =>
      tenant.gmail.db.messages.list({ limit: MAIL_WINDOW, offset: 0 }),
    );
    const hydratedIds = new Set(
      dedupeByEntityId(cached)
        .map(mapMessage)
        .filter((message) => message.hydrated)
        .map((message) => message.id),
    );
    const fresh = messageIds(result).filter((id) => !hydratedIds.has(id));
    await hydrateMessages(tenant, fresh);
    return { found: fresh.length };
  }),

  // Pages deeper into Gmail when the cached list is exhausted (infinite scroll).
  syncMore: authedProcedure.mutation(async () => {
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
  modifyMessage: authedProcedure
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
  bulkModify: authedProcedure
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
  bulkDelete: authedProcedure
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

  // Spam, trash and sent aren't the focus of the normal inbox sync; pull them
  // on demand when those folders are opened.
  syncFolder: authedProcedure
    .input(z.object({ folder: z.enum(["spam", "trash", "sent"]) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const label =
        input.folder === "spam"
          ? "SPAM"
          : input.folder === "trash"
            ? "TRASH"
            : "SENT";
      const result = await tenant.gmail.api.messages.list({
        maxResults: 30,
        labelIds: [label],
        includeSpamTrash: input.folder !== "sent",
      });
      const ids = messageIds(result);
      await hydrateMessages(tenant, ids);
      return { synced: ids.length };
    }),

  getDraft: authedProcedure
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
        cc: getHeader(headers, "Cc"),
        bcc: getHeader(headers, "Bcc"),
        subject: getHeader(headers, "Subject"),
        body: extractBodyFromPayload(draft.message?.payload),
      };
    }),

  updateDraft: authedProcedure
    .input(composeSchema.extend({ draftId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const raw = encodeRawEmail(input);
      const draft = await tenant.gmail.api.drafts.update({
        id: input.draftId,
        draft: { message: { raw } },
      });
      return { id: draft.id ?? input.draftId };
    }),

  deleteDraft: authedProcedure
    .input(z.object({ draftId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      await tenant.gmail.api.drafts.delete({ id: input.draftId });
      const tenantId = await getTenantId();
      if (tenantId) await purgeCachedEntity(tenantId, input.draftId);
      return { ok: true };
    }),

  createDraft: authedProcedure
    .input(composeSchema)
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const raw = encodeRawEmail(input);
      const draft = await tenant.gmail.api.drafts.create({
        draft: {
          message: input.threadId ? { raw, threadId: input.threadId } : { raw },
        },
      });
      return {
        id: draft.id ?? "",
        messageId: draft.message?.id ?? "",
      };
    }),

  sendDraft: authedProcedure
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

  sendEmail: authedProcedure
    .input(composeSchema)
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const raw = encodeRawEmail(input);
      const message = await tenant.gmail.api.messages.send(
        input.threadId ? { raw, threadId: input.threadId } : { raw },
      );
      return {
        id: message.id ?? "",
        threadId: message.threadId ?? "",
      };
    }),

  // The signed-in user's own address (used to drop self from reply-all).
  // The API doesn't expose the profile, so read the From of a Sent message.
  profile: authedProcedure.query(async () => {
    try {
      const tenant = await getTenant();
      const list = await tenant.gmail.api.messages.list({
        labelIds: ["SENT"],
        maxResults: 1,
      });
      const id = messageIds(list)[0];
      if (!id) return { email: "" };
      const message = await tenant.gmail.api.messages.get({
        id,
        format: "metadata",
      });
      const from = getHeader(message.payload?.headers, "From");
      const email = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
      // Only return a real address, so reply-all never excludes a junk value.
      return { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "" };
    } catch (error) {
      if (isNotConnectedError(error)) return { email: "" };
      return { email: "" };
    }
  }),

  // A whole conversation, oldest first, for the threaded reading pane.
  getThread: authedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const tenant = await getTenant();
        const thread = await withRetry(() =>
          tenant.gmail.api.threads.get({ id: input.id, format: "full" }),
        );
        const messages = (thread.messages ?? []).map((message) => {
          const headers = message.payload?.headers;
          const labels = message.labelIds ?? [];
          return {
            id: message.id ?? "",
            from: getHeader(headers, "From"),
            to: getHeader(headers, "To"),
            cc: getHeader(headers, "Cc"),
            subject: getHeader(headers, "Subject"),
            messageIdHeader: getHeader(headers, "Message-ID"),
            references: getHeader(headers, "References"),
            date: message.internalDate != null ? String(message.internalDate) : null,
            snippet: message.snippet ?? "",
            body:
              extractBodyFromPayload(message.payload) || (message.snippet ?? ""),
            html: extractHtmlFromPayload(message.payload),
            unread: labels.includes("UNREAD"),
          };
        });
        return { id: thread.id ?? input.id, messages };
      } catch (error) {
        if (isNotConnectedError(error)) return null;
        throw error;
      }
    }),
});
