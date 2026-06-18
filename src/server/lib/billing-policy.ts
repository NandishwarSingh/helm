/**
 * Pure billing policy — no `server-only`/db imports, so it can be unit-tested
 * directly (mirrors the agent-policy pattern). The SQL guard in
 * `setStatusByRazorpayId` implements the same ordering rule.
 */

/** Razorpay subscription statuses that grant Pro access. */
export const PRO_STATES = new Set(["active", "authenticated"]);

/** Mailboxes a free (non-Pro) session may connect: the primary account only. */
export const FREE_ACCOUNT_LIMIT = 1;

/**
 * How many mailboxes a session may connect. Multi-account is a Pro entitlement:
 * free is capped at the primary account, Pro unlocks the full fan-out (`max`,
 * i.e. MAX_ACCOUNTS). The single source of truth for the cap — both
 * `/oauth/start` and `linkAddedAccount` derive their gate from it, so the limit
 * lives server-side and a client can never grant itself a second account.
 */
export function accountCap(opts: { pro: boolean; max: number }): number {
  return opts.pro ? opts.max : FREE_ACCOUNT_LIMIT;
}

/**
 * Whether a webhook status write should apply, given event ordering. Razorpay's
 * `created_at` has only 1-second resolution and webhook delivery is unordered,
 * so a "cancelled" and a "charged" can share a timestamp. Rule:
 *   - a Pro-granting status must be STRICTLY newer than the last recorded event
 *     (so a stale OR same-second "charged" can't revive a cancelled sub), while
 *   - any other status (cancellation/expiry) wins an exact-second tie (so a
 *     cancellation always beats a same-second charge, whatever order they land).
 * The first event for a subscription (no prior `eventAt`) always applies.
 */
export function shouldApplyStatus(opts: {
  newStatus: string;
  lastEventAt: Date | null;
  eventAt: Date | null;
}): boolean {
  if (!opts.eventAt || !opts.lastEventAt) return true;
  const last = opts.lastEventAt.getTime();
  const next = opts.eventAt.getTime();
  return PRO_STATES.has(opts.newStatus) ? last < next : last <= next;
}
