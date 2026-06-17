import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { mailTriage } from "@/server/db/schema";
import { listOrEmpty } from "@/server/lib/corsair-errors";
import {
  dedupeByEntityId,
  FOLDER_FILTERS,
  type MappedMessage,
  mapMessage,
  sortMessagesNewestFirst,
} from "@/server/lib/mail-view";
import { type AccountClient, getAccountClients } from "@/server/lib/tenant";
import { classifyEmails } from "@/server/lib/triage";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

export const PRIORITIES = ["urgent", "reply", "fyi", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

// Each run classifies at most this many messages per account (two model calls).
const RUN_CAP = 40;
// Triage looks at the same cached window the mail views read from.
const CACHE_WINDOW = 300;

type AccountMessage = MappedMessage & {
  accountId: string;
  accountEmail: string;
};
type TriagedMessage = AccountMessage & { reason: string };

// One classification run per account at a time within this instance, so two
// open tabs don't pay the model twice for the same batch.
const runningTriage = new Map<
  string,
  Promise<{ classified: number; remaining: number }>
>();

async function inboxFor(c: AccountClient): Promise<AccountMessage[]> {
  const rows = await listOrEmpty(async () =>
    c.client.gmail.db.messages.list({ limit: CACHE_WINDOW, offset: 0 }),
  );
  return sortMessagesNewestFirst(dedupeByEntityId(rows).map(mapMessage))
    .filter((message) => message.hydrated)
    .filter(FOLDER_FILTERS.inbox)
    .map((message) => ({
      ...message,
      accountId: c.accountId,
      accountEmail: c.email,
    }));
}

export const triageRouter = createTRPCRouter({
  // The Priority view: cached verdicts joined onto the inbox of every account,
  // grouped by priority, plus how many inbox messages still await classification.
  overview: authedProcedure.query(async () => {
    const clients = await getAccountClients();
    const per = await Promise.all(
      clients.map(async (c) => {
        const [messages, verdicts] = await Promise.all([
          inboxFor(c),
          db
            .select()
            .from(mailTriage)
            .where(eq(mailTriage.tenantId, c.tenantId)),
        ]);
        return {
          messages,
          verdictById: new Map(verdicts.map((v) => [v.messageId, v])),
        };
      }),
    );

    const groups = emptyGroups();
    let pendingCount = 0;
    for (const { messages, verdictById } of per) {
      for (const message of messages) {
        const verdict = verdictById.get(message.id);
        if (!verdict) {
          pendingCount += 1;
          continue;
        }
        const priority = (PRIORITIES as readonly string[]).includes(
          verdict.priority,
        )
          ? (verdict.priority as Priority)
          : "fyi";
        groups[priority].push({ ...message, reason: verdict.reason });
      }
    }
    // Keep each group newest-first across the merged accounts.
    for (const key of PRIORITIES) {
      groups[key] = sortMessagesNewestFirst(groups[key]);
    }
    return { groups, pendingCount };
  }),

  // Classify the next slice of untriaged inbox mail for every account. Verdicts
  // are written once and never recomputed — that cache keeps this affordable.
  run: authedProcedure.mutation(async () => {
    const clients = await getAccountClients();
    let classified = 0;
    let remaining = 0;
    for (const c of clients) {
      const inflight = runningTriage.get(c.tenantId);
      const work =
        inflight ??
        classifyNextBatch(c).finally(() => runningTriage.delete(c.tenantId));
      if (!inflight) runningTriage.set(c.tenantId, work);
      const res = await work;
      classified += res.classified;
      remaining += res.remaining;
    }
    return { classified, remaining };
  }),
});

async function classifyNextBatch(
  c: AccountClient,
): Promise<{ classified: number; remaining: number }> {
  const [messages, existing] = await Promise.all([
    inboxFor(c),
    db
      .select({ messageId: mailTriage.messageId })
      .from(mailTriage)
      .where(eq(mailTriage.tenantId, c.tenantId)),
  ]);
  const done = new Set(existing.map((row) => row.messageId));
  const pending = messages.filter((message) => !done.has(message.id));
  const batch = pending.slice(0, RUN_CAP);
  if (batch.length === 0) return { classified: 0, remaining: 0 };

  const verdicts = await classifyEmails(
    batch.map((message) => ({
      id: message.id,
      from: message.from,
      subject: message.subject,
      snippet: message.snippet,
    })),
  );
  if (verdicts.length > 0) {
    await db
      .insert(mailTriage)
      .values(
        verdicts.map((verdict) => ({
          tenantId: c.tenantId,
          messageId: verdict.messageId,
          priority: verdict.priority,
          reason: verdict.reason,
        })),
      )
      .onConflictDoNothing();
  }

  const remaining =
    verdicts.length === 0 ? 0 : pending.length - verdicts.length;
  return { classified: verdicts.length, remaining: Math.max(0, remaining) };
}

function emptyGroups(): Record<Priority, TriagedMessage[]> {
  return { urgent: [], reply: [], fyi: [], low: [] };
}
