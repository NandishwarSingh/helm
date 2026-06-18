import "server-only";
import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";

import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import { PRO_STATES } from "@/server/lib/billing-policy";
import { getActiveAccount, getUserAccounts } from "@/server/lib/users";

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
  if (emails.length === 0)
    return { pro: false, status: "none", currentEnd: null };
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
 * Whether ANY of these emails currently grants Pro (a subscription in
 * PRO_STATES). The owner-keyed entitlement check used by `linkAddedAccount`'s
 * server-side backstop, which runs in the OAuth callback and so can't read the
 * session the way `getProStatus` does — it's handed the owner's email(s)
 * explicitly. Mirrors `getProStatus`'s rule. Empty/blank emails → false.
 */
export async function isProForEmails(
  emails: (string | null | undefined)[],
): Promise<boolean> {
  const ids = emails.map(key).filter((e): e is string => e !== null);
  if (ids.length === 0) return false;
  const rows = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(inArray(subscriptions.subscriberId, ids));
  return rows.some((r) => PRO_STATES.has(r.status));
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
 * `eventAt` orders writes (see `shouldApplyStatus`): a Pro-granting status must
 * be STRICTLY newer than the last recorded event, while a cancellation/other
 * status wins an exact-second tie — so a stale OR same-second "charged" can never
 * revive a "cancelled" sub regardless of delivery order (Razorpay's `created_at`
 * is only 1-second resolution). With no `eventAt` it applies unconditionally.
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
            // Mirrors shouldApplyStatus(): a Pro-granting status needs a STRICTLY
            // newer event (lt) so a stale/same-second "charged" can't revive a
            // cancelled sub; any other status wins an exact tie (lte) so a
            // cancellation always beats a same-second charge, whatever the order.
            or(
              isNull(subscriptions.lastEventAt),
              PRO_STATES.has(status)
                ? lt(subscriptions.lastEventAt, eventAt)
                : lte(subscriptions.lastEventAt, eventAt),
            ),
          )
        : eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId),
    );
}
