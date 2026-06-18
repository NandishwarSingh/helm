import "server-only";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import { getSession } from "@/server/lib/session";

/** Razorpay subscription statuses that grant Pro access. */
const PRO_STATES = new Set(["active", "authenticated"]);

/**
 * The billing identity for the current session: the user id for a multi-account
 * session, else the active tenant id (both come back as `session.id`). One
 * subscription per identity.
 */
export async function getSubscriberId(): Promise<string | null> {
  return (await getSession())?.id ?? null;
}

export type ProStatus = {
  pro: boolean;
  status: string;
  currentEnd: string | null;
};

/** Current Pro status for the session. */
export async function getProStatus(): Promise<ProStatus> {
  const subscriberId = await getSubscriberId();
  if (!subscriberId) return { pro: false, status: "none", currentEnd: null };
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.subscriberId, subscriberId))
    .limit(1);
  if (!row) return { pro: false, status: "none", currentEnd: null };
  return {
    pro: PRO_STATES.has(row.status),
    status: row.status,
    currentEnd: row.currentEnd ? row.currentEnd.toISOString() : null,
  };
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

/** Set status by Razorpay subscription id (webhook-driven, the source of truth). */
export async function setStatusByRazorpayId(
  razorpaySubscriptionId: string,
  status: string,
  currentEnd?: Date | null,
): Promise<void> {
  await db
    .update(subscriptions)
    .set({
      status,
      ...(currentEnd !== undefined ? { currentEnd } : {}),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId));
}
