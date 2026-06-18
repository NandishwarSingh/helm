import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  buildFilters,
  matchesFlags,
  matchesOperators,
  type MessageFilter,
  parseQuery,
  tieredBoost,
} from "@/lib/search-operators";
import { corsair } from "@/server/corsair";
import { db } from "@/server/db";
import { mailSync } from "@/server/db/schema";
import { purgeCachedEntity } from "@/server/lib/cache";
import {
  forEachAccount,
  mapLimit,
  requireExplicitAccount,
} from "@/server/lib/concurrency";
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
  type MappedMessage,
  mapMessage,
  sortMessagesNewestFirst,
} from "@/server/lib/mail-view";
import { notifyTenant } from "@/server/lib/realtime";
import { withRetry } from "@/server/lib/retry";
import {
  deleteMessageEmbeddings,
  embedText,
  semanticSearchIds,
  upsertMessageEmbeddings,
} from "@/server/lib/semantic-search";
import { getTenantId } from "@/server/lib/session";
import { type AccountClient, getAccountClients } from "@/server/lib/tenant";
import { getUserAccounts, resolveAccountTenant } from "@/server/lib/users";
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

// Which account a per-message op targets; omitted => the session's active one.
const accountInput = z.string().max(64).optional();

type Tenant = ReturnType<typeof corsair.withTenant>;
type AccountMessage = MappedMessage & {
  accountId: string;
  accountEmail: string;
};
const SYNC_CONCURRENCY = 10;
const SYNC_PAGE_SIZE = 40;
// The recency window the list view reads (per account) before sorting by date.
// Matches the other cache reads (triage's CACHE_WINDOW, syncNew) so every view
// sees the same messages. Mirrored as MAIL_WINDOW in gmail-panel.tsx.
const MAIL_WINDOW = 300;
// Wider read used only to hydrate semantic-search hits (which can reach beyond
// the list window) back into full rows. Submit-driven, so the cost is rare.
const SEARCH_WINDOW = 2000;
// Semantic candidate pool that smartSearch re-ranks with the keyword boost.
const SMART_POOL = 150;
// Max accounts read concurrently in a unified fan-out (bounds DB-pool pressure).
const READ_CONCURRENCY = 4;

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

// Persists the Gmail page cursor (per account-tenant) so syncMore can page
// deeper than the cache.
async function setSyncCursor(tenantId: string, token: string | null) {
  await db
    .insert(mailSync)
    .values({ tenantId, nextPageToken: token })
    .onConflictDoUpdate({
      target: mailSync.tenantId,
      set: { nextPageToken: token, updatedAt: new Date() },
    });
}

/**
 * The accounts a READ should span: a specific owned account, or all of the
 * session's accounts when "all"/omitted (the unified inbox). A non-owned id
 * resolves to no clients → an empty result, never another user's mail.
 */
async function readClients(account?: string): Promise<AccountClient[]> {
  const all = await getAccountClients();
  if (!account || account === "all") return all;
  return all.filter((c) => c.accountId === account);
}

/**
 * Resolve a per-message op to a single tenant + client. With an explicit
 * account it's ownership-checked via resolveAccountTenant; without one it
 * targets the session's active account (back-compat for the single-account UI).
 */
async function opAccount(
  account?: string,
  opts: { requireAccount?: boolean } = {},
): Promise<{ tenant: Tenant; tenantId: string }> {
  // A destructive op on an EXISTING message must name its account once the user
  // has more than one mailbox — refuse rather than silently falling back to the
  // active mailbox (the client always names it for these; a missing one is a
  // bug, not intent). Single-account sessions keep the active fallback as-is.
  if (!account && opts.requireAccount) {
    const accountCount = (await getUserAccounts()).length;
    if (requireExplicitAccount(account, opts.requireAccount, accountCount)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "account must be specified for this operation",
      });
    }
  }
  const tenantId = account
    ? await resolveAccountTenant(account)
    : await getTenantId();
  if (!tenantId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "unknown account" });
  }
  return { tenant: corsair.withTenant(tenantId), tenantId };
}

/** Read + tag one account's hydrated messages (plain recency, free text, or operator filters). */
async function readAccountMessages(
  c: AccountClient,
  opts: { query?: string; filters?: MessageFilter[]; window?: number },
): Promise<{ items: AccountMessage[]; full: boolean }> {
  const limit = opts.window ?? MAIL_WINDOW;
  const rows = await listOrEmpty(async () => {
    if (opts.filters && opts.filters.length > 0) {
      const results = await Promise.all(
        opts.filters.map((data) =>
          c.client.gmail.db.messages.search({ data, limit, offset: 0 }),
        ),
      );
      return results.flat();
    }
    if (opts.query) {
      // The cache ANDs filters, so match each text field separately and merge.
      const fields = [
        { snippet: { contains: opts.query } },
        { subject: { contains: opts.query } },
        { from: { contains: opts.query } },
      ];
      const results = await Promise.all(
        fields.map((data) =>
          c.client.gmail.db.messages.search({ data, limit, offset: 0 }),
        ),
      );
      return results.flat();
    }
    return c.client.gmail.db.messages.list({ limit, offset: 0 });
  });
  const items = dedupeByEntityId(rows)
    .map(mapMessage)
    .filter((message) => message.hydrated)
    .map((message) => ({
      ...message,
      accountId: c.accountId,
      accountEmail: c.email,
    }));
  return { items, full: rows.length >= limit };
}

export const gmailRouter = createTRPCRouter({
  // The cache pages by update recency, so opening, starring or syncing a
  // message reshuffles any offset window — which made rows pop in and out.
  // Instead we read a fixed recency window per account, derive a STABLE list
  // ordered by message date, and serve a growing prefix. With multiple accounts
  // each window is read, tagged, and merged before sorting.
  searchEmails: authedProcedure
    .input(
      z.object({
        query: z.string().max(256),
        folder: folderSchema,
        limit: z.number().min(1).max(MAIL_WINDOW).default(40),
        account: accountInput,
      }),
    )
    .query(async ({ input }) => {
      const query = input.query.trim();
      const clients = await readClients(input.account);
      const per = await mapLimit(clients, READ_CONCURRENCY, (c) =>
        readAccountMessages(c, query ? { query } : {}),
      );
      const all = sortMessagesNewestFirst(
        per.flatMap((p) => p.items).filter(FOLDER_FILTERS[input.folder]),
      );
      return {
        items: all.slice(0, input.limit),
        hasMore: all.length > input.limit,
        // Any account's recency window being full means a deep sync may surface more.
        windowFull: per.some((p) => p.full),
      };
    }),

  // Warm the semantic index for every account: embed cached messages that are
  // new or changed since last call. Hash-deduped, so steady state embeds
  // nothing — cheap to call after every sync. The client runs this in the bg.
  reindexSearch: authedProcedure.mutation(async () => {
    const clients = await getAccountClients();
    let indexed = 0;
    for (const c of clients) {
      const window = await listOrEmpty(async () =>
        c.client.gmail.db.messages.list({ limit: SEARCH_WINDOW, offset: 0 }),
      );
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
      indexed += await upsertMessageEmbeddings(c.tenantId, items);
    }
    return { indexed };
  }),

  // Unified search. Gmail-style operators (from:/to:/subject:/is:…) FILTER; the
  // free text is RANKED by semantic similarity plus an adaptive keyword boost
  // (tieredBoost). Runs per account and merges: operator-only queries by date,
  // free-text by the blended relevance score across all of the user's mailboxes.
  smartSearch: authedProcedure
    .input(
      z.object({
        query: z.string().max(256),
        folder: folderSchema,
        limit: z.number().min(1).max(MAIL_WINDOW).default(40),
        account: accountInput,
      }),
    )
    .query(async ({ input }) => {
      const clients = await readClients(input.account);
      if (clients.length === 0) return { items: [], hasMore: false };
      const parsed = parseQuery(input.query.trim());
      const text = parsed.text ?? "";

      // No free text → pure Corsair `.db` filter (operators + flags), recency order.
      if (!text) {
        const filters = buildFilters(parsed);
        const per = await mapLimit(clients, READ_CONCURRENCY, (c) =>
          readAccountMessages(c, filters.length ? { filters } : {}),
        );
        const all = sortMessagesNewestFirst(
          per
            .flatMap((p) => p.items)
            .filter((m) => matchesFlags(m, parsed) && matchesOperators(m, parsed))
            .filter(FOLDER_FILTERS[input.folder]),
        );
        return {
          items: all.slice(0, input.limit),
          hasMore: all.length > input.limit,
        };
      }

      // Free text → per-account semantic candidate pool, re-ranked by the tiered
      // keyword boost, then merged across accounts by the blended score.
      const perAccount = await mapLimit(clients, READ_CONCURRENCY, async (c) => {
        try {
          const hits = await semanticSearchIds(c.tenantId, text, SMART_POOL);
          if (hits.length === 0) return [];
          const semScore = new Map(hits.map((hit) => [hit.messageId, hit.score]));
          const window = await listOrEmpty(async () =>
            c.client.gmail.db.messages.list({ limit: SEARCH_WINDOW, offset: 0 }),
          );
          const byId = new Map(
            dedupeByEntityId(window)
              .map(mapMessage)
              .filter((message) => message.hydrated)
              .map((message) => [message.id, message] as const),
          );
          return hits
            .map((hit) => byId.get(hit.messageId))
            .filter((m): m is NonNullable<typeof m> => Boolean(m))
            .filter((m) => matchesFlags(m, parsed) && matchesOperators(m, parsed))
            .filter(FOLDER_FILTERS[input.folder])
            .map((m) => ({
              msg: { ...m, accountId: c.accountId, accountEmail: c.email },
              score: (semScore.get(m.id) ?? 0) + tieredBoost(text, m),
            }));
        } catch {
          // One account's semantic query failing must not 500 the whole search.
          return [];
        }
      });
      const ranked = perAccount
        .flat()
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.msg);
      return {
        items: ranked.slice(0, input.limit),
        hasMore: ranked.length > input.limit,
      };
    }),

  getMessage: authedProcedure
    .input(z.object({ id: z.string().min(1), account: accountInput }))
    .query(async ({ input }) => {
      try {
        const { tenant } = await opAccount(input.account);
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
    .input(paginationSchema.extend({ account: accountInput }))
    .query(async ({ input }) => {
      const clients = await readClients(input.account);
      const per = await mapLimit(clients, READ_CONCURRENCY, async (c) => {
        const drafts = await listOrEmpty(async () =>
          c.client.gmail.db.drafts.list({
            limit: input.limit,
            offset: input.offset,
          }),
        );
        return dedupeByEntityId(drafts).map((draft) => ({
          id: draft.entity_id,
          messageId: draft.data.messageId ?? "",
          createdAt: draft.data.createdAt ?? null,
          accountId: c.accountId,
          accountEmail: c.email,
        }));
      });
      return per.flat();
    }),

  // Fresh sync across every account: walk Gmail pages up to a cap, hydrate, and
  // reset each account's cursor.
  refreshInbox: authedProcedure.mutation(async () => {
    const clients = await getAccountClients();
    let synced = 0;
    await forEachAccount(clients, async (c) => {
      const CAP = 120;
      let pageToken: string | undefined;
      let seen = 0;
      do {
        const result = await c.client.gmail.api.messages.list({
          maxResults: SYNC_PAGE_SIZE,
          pageToken,
        });
        const ids = messageIds(result);
        synced += await hydrateMessages(c.client, ids);
        seen += ids.length;
        pageToken = result.nextPageToken ?? undefined;
      } while (pageToken && seen < CAP);
      await setSyncCursor(c.tenantId, pageToken ?? null);
    });
    return { synced };
  }),

  // Cheap top-up poll across every account: one list call for the newest page,
  // then hydrate only ids the cache has never seen properly (self-heals stubs).
  syncNew: authedProcedure.mutation(async () => {
    const clients = await getAccountClients();
    let found = 0;
    await forEachAccount(clients, async (c) => {
      const result = await c.client.gmail.api.messages.list({
        maxResults: SYNC_PAGE_SIZE,
      });
      const cached = await listOrEmpty(async () =>
        c.client.gmail.db.messages.list({ limit: MAIL_WINDOW, offset: 0 }),
      );
      const hydratedIds = new Set(
        dedupeByEntityId(cached)
          .map(mapMessage)
          .filter((message) => message.hydrated)
          .map((message) => message.id),
      );
      const fresh = messageIds(result).filter((id) => !hydratedIds.has(id));
      await hydrateMessages(c.client, fresh);
      found += fresh.length;
    });
    return { found };
  }),

  // Pages deeper into Gmail when the cached list is exhausted (infinite scroll).
  // Each account advances its own cursor; reports hasMore if any can go deeper.
  syncMore: authedProcedure.mutation(async () => {
    const clients = await getAccountClients();
    let synced = 0;
    let hasMore = false;
    await forEachAccount(clients, async (c) => {
      const [state] = await db
        .select()
        .from(mailSync)
        .where(eq(mailSync.tenantId, c.tenantId));
      const token = state?.nextPageToken;
      if (!token) return;
      const result = await c.client.gmail.api.messages.list({
        maxResults: SYNC_PAGE_SIZE,
        pageToken: token,
      });
      const ids = messageIds(result);
      await hydrateMessages(c.client, ids);
      await setSyncCursor(c.tenantId, result.nextPageToken ?? null);
      synced += ids.length;
      if (result.nextPageToken) hasMore = true;
    });
    return { synced, hasMore };
  }),

  // Label actions, mapped to Gmail label changes server-side, on one account.
  modifyMessage: authedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        account: accountInput,
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
      const { tenant, tenantId } = await opAccount(input.account, {
        requireAccount: true,
      });
      if (input.action === "trash") {
        await withRetry(() => tenant.gmail.api.messages.trash({ id: input.id }));
        // Re-hydrate so a reconcile refetch reads the new labels (TRASH added,
        // INBOX gone) — mirrors bulkModify; without it the row can flicker back.
        await hydrateMessages(tenant, [input.id]);
        notifyTenant(tenantId, "mail");
        return { ok: true };
      }
      if (input.action === "untrash") {
        await withRetry(() =>
          tenant.gmail.api.messages.untrash({ id: input.id }),
        );
        await hydrateMessages(tenant, [input.id]);
        notifyTenant(tenantId, "mail");
        return { ok: true };
      }
      if (input.action === "deleteForever") {
        await withRetry(() => tenant.gmail.api.messages.delete({ id: input.id }));
        await purgeCachedEntity(tenantId, input.id);
        // Best-effort: drop the orphaned embedding, but never let a failed
        // index cleanup surface as a failed delete.
        await deleteMessageEmbeddings(tenantId, [input.id]).catch(() => undefined);
        notifyTenant(tenantId, "mail");
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
      await hydrateMessages(tenant, [input.id]);
      notifyTenant(tenantId, "mail");
      return { ok: true };
    }),

  // Bulk label actions over a multiselect on one account, in one Gmail call.
  bulkModify: authedProcedure
    .input(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(50),
        account: accountInput,
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
      const { tenant, tenantId } = await opAccount(input.account, {
        requireAccount: true,
      });
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
      notifyTenant(tenantId, "mail");
      return { ok: true, count: input.ids.length };
    }),

  // Permanently delete a multiselect on one account (no batch endpoint upstream).
  bulkDelete: authedProcedure
    .input(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(25),
        account: accountInput,
      }),
    )
    .mutation(async ({ input }) => {
      const { tenant, tenantId } = await opAccount(input.account, {
        requireAccount: true,
      });
      for (const id of input.ids) {
        await withRetry(() => tenant.gmail.api.messages.delete({ id }));
        await purgeCachedEntity(tenantId, id);
      }
      // Best-effort: clear the deleted messages' embeddings so search can't
      // return rows that no longer exist; a failure here never breaks the delete.
      await deleteMessageEmbeddings(tenantId, input.ids).catch(() => undefined);
      notifyTenant(tenantId, "mail");
      return { ok: true, count: input.ids.length };
    }),

  // Spam, trash and sent aren't part of the normal inbox sync; pull them on
  // demand across every account when those folders are opened.
  syncFolder: authedProcedure
    .input(z.object({ folder: z.enum(["spam", "trash", "sent", "starred"]) }))
    .mutation(async ({ input }) => {
      const label =
        input.folder === "spam"
          ? "SPAM"
          : input.folder === "trash"
            ? "TRASH"
            : input.folder === "sent"
              ? "SENT"
              : "STARRED";
      const clients = await getAccountClients();
      let synced = 0;
      await forEachAccount(clients, async (c) => {
        const result = await c.client.gmail.api.messages.list({
          maxResults: input.folder === "starred" ? 50 : 30,
          labelIds: [label],
          includeSpamTrash:
            input.folder === "spam" || input.folder === "trash",
        });
        const ids = messageIds(result);
        await hydrateMessages(c.client, ids);
        synced += ids.length;
      });
      return { synced };
    }),

  getDraft: authedProcedure
    .input(z.object({ id: z.string().min(1), account: accountInput }))
    .query(async ({ input }) => {
      const { tenant } = await opAccount(input.account);
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
    .input(composeSchema.extend({ draftId: z.string().min(1), account: accountInput }))
    .mutation(async ({ input }) => {
      const { tenant } = await opAccount(input.account, {
        requireAccount: true,
      });
      const raw = encodeRawEmail(input);
      const draft = await tenant.gmail.api.drafts.update({
        id: input.draftId,
        draft: { message: { raw } },
      });
      return { id: draft.id ?? input.draftId };
    }),

  deleteDraft: authedProcedure
    .input(z.object({ draftId: z.string().min(1), account: accountInput }))
    .mutation(async ({ input }) => {
      const { tenant, tenantId } = await opAccount(input.account, {
        requireAccount: true,
      });
      await tenant.gmail.api.drafts.delete({ id: input.draftId });
      await purgeCachedEntity(tenantId, input.draftId);
      return { ok: true };
    }),

  createDraft: authedProcedure
    .input(composeSchema.extend({ account: accountInput }))
    .mutation(async ({ input }) => {
      const { tenant } = await opAccount(input.account);
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
    .input(z.object({ draftId: z.string().min(1), account: accountInput }))
    .mutation(async ({ input }) => {
      const { tenant, tenantId } = await opAccount(input.account, {
        requireAccount: true,
      });
      const message = await tenant.gmail.api.drafts.send({ id: input.draftId });
      // Gmail deletes the draft on send; mirror that in the cache.
      await purgeCachedEntity(tenantId, input.draftId);
      return {
        id: message.id ?? "",
        threadId: message.threadId ?? "",
      };
    }),

  sendEmail: authedProcedure
    .input(composeSchema.extend({ account: accountInput }))
    .mutation(async ({ input }) => {
      const { tenant } = await opAccount(input.account);
      const raw = encodeRawEmail(input);
      const message = await tenant.gmail.api.messages.send(
        input.threadId ? { raw, threadId: input.threadId } : { raw },
      );
      return {
        id: message.id ?? "",
        threadId: message.threadId ?? "",
      };
    }),

  // The address of an account (used to drop self from reply-all). The API
  // doesn't expose the profile, so read the From of a Sent message.
  profile: authedProcedure
    .input(z.object({ account: accountInput }).optional())
    .query(async ({ input }) => {
      try {
        const { tenant } = await opAccount(input?.account);
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
    .input(z.object({ id: z.string().min(1), account: accountInput }))
    .query(async ({ input }) => {
      try {
        const { tenant } = await opAccount(input.account);
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
