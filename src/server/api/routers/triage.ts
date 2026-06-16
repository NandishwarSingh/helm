import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { mailTriage } from "@/server/db/schema";
import { listOrEmpty } from "@/server/lib/corsair-errors";
import {
  dedupeByEntityId,
  FOLDER_FILTERS,
  mapMessage,
  sortMessagesNewestFirst,
  type MappedMessage,
} from "@/server/lib/mail-view";
import { getTenantId } from "@/server/lib/session";
import { getTenant } from "@/server/lib/tenant";
import { classifyEmails } from "@/server/lib/triage";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

export const PRIORITIES = ["urgent", "reply", "fyi", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

// Each run classifies at most this many messages (two model calls).
const RUN_CAP = 40;
// Triage looks at the same cached window the mail views read from.
const CACHE_WINDOW = 300;

// One classification run per tenant at a time within this instance: two open
// tabs (or a double-click) would otherwise pay the model twice for the same
// batch. Concurrent callers await the in-flight run and return its result.
const runningTriage = new Map<string, Promise<{ classified: number; remaining: number }>>();

async function inboxMessages(): Promise<MappedMessage[]> {
  const rows = await listOrEmpty(async () => {
    const tenant = await getTenant();
    return tenant.gmail.db.messages.list({ limit: CACHE_WINDOW, offset: 0 });
  });
  return sortMessagesNewestFirst(dedupeByEntityId(rows).map(mapMessage))
    .filter((message) => message.hydrated)
    .filter(FOLDER_FILTERS.inbox);
}

export const triageRouter = createTRPCRouter({
  // The Priority view: cached verdicts joined onto the inbox, grouped by
  // priority, plus how many inbox messages still await classification.
  overview: authedProcedure.query(async () => {
    const tenantId = await getTenantId();
    if (!tenantId) return { groups: emptyGroups(), pendingCount: 0 };

    const [messages, verdicts] = await Promise.all([
      inboxMessages(),
      db.select().from(mailTriage).where(eq(mailTriage.tenantId, tenantId)),
    ]);
    const verdictById = new Map(verdicts.map((v) => [v.messageId, v]));

    const groups = emptyGroups();
    let pendingCount = 0;
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
    return { groups, pendingCount };
  }),

  // Classify the next slice of untriaged inbox mail. Verdicts are written
  // once and never recomputed — that cache is what keeps this affordable.
  run: authedProcedure.mutation(async () => {
    const tenantId = await getTenantId();
    if (!tenantId) return { classified: 0, remaining: 0 };

    const inflight = runningTriage.get(tenantId);
    if (inflight) return inflight;

    const work = classifyNextBatch(tenantId).finally(() => {
      runningTriage.delete(tenantId);
    });
    runningTriage.set(tenantId, work);
    return work;
  }),
});

async function classifyNextBatch(
  tenantId: string,
): Promise<{ classified: number; remaining: number }> {
  const [messages, existing] = await Promise.all([
    inboxMessages(),
    db
      .select({ messageId: mailTriage.messageId })
      .from(mailTriage)
      .where(eq(mailTriage.tenantId, tenantId)),
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
          tenantId,
          messageId: verdict.messageId,
          priority: verdict.priority,
          reason: verdict.reason,
        })),
      )
      .onConflictDoNothing();
  }

  // A zero-verdict run means the model output failed to parse; report no
  // remainder so the client does not retry in a loop.
  const remaining =
    verdicts.length === 0 ? 0 : pending.length - verdicts.length;
  return { classified: verdicts.length, remaining: Math.max(0, remaining) };
}

function emptyGroups(): Record<
  Priority,
  (MappedMessage & { reason: string })[]
> {
  return { urgent: [], reply: [], fyi: [], low: [] };
}
