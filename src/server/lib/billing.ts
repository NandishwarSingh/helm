import "server-only";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import { getActiveAccount, getUserAccounts } from "@/server/lib/users";

/** Razorpay subscription statuses that grant Pro access. */
const PRO_STATES = new Set(["active", "authenticated"]);

/** Normalize an email to a stable subscription key (empty/missing → null). */
function key(email: string | undefined | null): string | null {
  const e = email?.trim().toLowerCase();
  if (!e) return null;
  return e;
}

/**
 * The billing identity for WRITES: the active account's Google email. Email is
 * stable across logout/login (the session/tenant id is NOT), so a subscription
 * persists when the same Google account signs back in. Null when no email is
 * known yet (e.g. mid first-connect) — callers treat that as "can't bill".
 */
export async function getSubscriberId(): Promise<string | null> {
  return key((await getActiveAccount())?.email);
}

export type ProStatus = {
  pro: boolean;
  status: string;
  currentEnd: string | null;
};

/**
 * Pro status for the session: Pro if ANY of the session's connected account
 * emails has an active subscription. So a multi-account user stays Pro whichever
 * account is active, and signing back in restores Pro (it's keyed by email, not
 * the ephemeral session id).
 */
export async function getProStatus(): Promise<ProStatus> {
  const emails = (await getUserAccounts())
    .map((a) => key(a.email))
    .filter((e): e is string => e !== null);
  if (emails.length === 0) return { pro: false, status: "none", currentEnd: null };
  const rows = await db
    .select()
    .from(subscriptions)
    .where(inArray(subscriptions.subscriberId, emails));
  const active = rows.find((r) => PRO_STATES.has(r.status));
  const row = active ?? rows[0];
  return {
    pro: Boolean(active),
    status: row?.status ?? "none",
    currentEnd: row?.currentEnd ? row.currentEnd.toISOString() : null,
  };
}

/**
 * The Razorpay subscription id we recorded for this subscriber when they hit
 * `subscribe`. Verify binds against this so a caller can't confirm a different
 * (or someone else's) subscription with a stray signature.
 */
export async function ownedSubscriptionId(
  subscriberId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: subscriptions.razorpaySubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.subscriberId, subscriberId))
    .limit(1);
  return row?.id ?? null;
}

/** Upsert the subscription row for a subscriber (from subscribe + verify). */
export async function upsertSubscription(opts: {
  subscriberId: string;
  razorpaySubscriptionId: string;
  status: string;
  currentEnd?: Date | null;
}): Promise<void> {
  await db
    .insert(subscriptions)
    .values({
      subscriberId: opts.subscriberId,
      razorpaySubscriptionId: opts.razorpaySubscriptionId,
      status: opts.status,
      currentEnd: opts.currentEnd ?? null,
    })
    .onConflictDoUpdate({
      target: subscriptions.subscriberId,
      set: {
        razorpaySubscriptionId: opts.razorpaySubscriptionId,
        status: opts.status,
        currentEnd: opts.currentEnd ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Set status by Razorpay subscription id (webhook-driven, the source of truth).
 * `eventAt` is the webhook event time: when given, the write is applied ONLY if
 * it's at least as new as the last event we recorded — so a retried or
 * out-of-order event can't clobber a newer state (e.g. a stale "charged"
 * arriving after a "cancelled"). With no `eventAt` it applies unconditionally.
 */
export async function setStatusByRazorpayId(
  razorpaySubscriptionId: string,
  status: string,
  currentEnd?: Date | null,
  eventAt?: Date | null,
): Promise<void> {
  await db
    .update(subscriptions)
    .set({
      status,
      ...(currentEnd !== undefined ? { currentEnd } : {}),
      ...(eventAt ? { lastEventAt: eventAt } : {}),
      updatedAt: new Date(),
    })
    .where(
      eventAt
        ? and(
            eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId),
            or(
              isNull(subscriptions.lastEventAt),
              lte(subscriptions.lastEventAt, eventAt),
            ),
          )
        : eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId),
    );
}
