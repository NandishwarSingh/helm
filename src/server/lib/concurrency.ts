import "server-only";

/**
 * Run `fn` over `items` with at most `limit` in flight at once — a bounded
 * alternative to `Promise.all` for fanning out across a user's accounts, so a
 * many-account user can't saturate the DB pool / Gmail API in one request.
 * Preserves input order. A thrown `fn` rejects the whole call, so callers that
 * need per-item resilience should catch inside `fn`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Max Google accounts one user may connect — bounds every fan-out's width. */
export const MAX_ACCOUNTS = 6;

/**
 * Whether a destructive op on an EXISTING entity must NAME its account: true only
 * when no account was given, the op requires one, AND the user has more than one
 * mailbox. A single-account session keeps the active-mailbox fallback (false), so
 * this never trips for them — it only refuses a genuinely ambiguous multi-account
 * write that arrived without an account (a client bug, not intent).
 */
export function requireExplicitAccount(
  account: string | undefined,
  requireAccount: boolean,
  accountCount: number,
): boolean {
  return !account && requireAccount && accountCount > 1;
}

/**
 * Run `fn` for each account sequentially, ISOLATING failures: one account whose
 * grant is revoked/expired or transiently errors is logged and skipped instead
 * of aborting the whole sync. Use for the live-API sync loops (refresh/syncNew/
 * syncMore/syncFolder/refreshEvents) so a single dead mailbox can't freeze the
 * others.
 */
export async function forEachAccount<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      await fn(item);
    } catch (error) {
      console.error(
        "[fan-out] account op failed (skipped):",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
