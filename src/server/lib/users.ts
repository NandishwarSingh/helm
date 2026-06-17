import "server-only";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { gmailWatch, userAccounts } from "@/server/db/schema";
import { getActiveAccountCookie, getSession } from "@/server/lib/session";

export type Account = {
  id: string; // account id (== tenant id for single-account sessions)
  tenantId: string; // the Corsair tenant backing this account
  email: string;
  label: string | null;
  color: string | null;
  isPrimary: boolean;
};

/**
 * Every Google account the current session can act on. A multi-account user gets
 * their linked rows; a single-account (tenant) session gets one synthetic
 * account (the tenant itself), with the email read from gmail_watch if known.
 * Primary first, then by email — a stable order for the UI and "active" fallback.
 */
export async function getUserAccounts(): Promise<Account[]> {
  const s = await getSession();
  if (!s) return [];
  if (s.kind === "user") {
    const rows = await db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.userId, s.id));
    return rows
      .map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        email: r.email,
        label: r.label,
        color: r.color,
        isPrimary: r.isPrimary,
      }))
      .sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          a.email.localeCompare(b.email),
      );
  }
  // Single-account (tenant) session → one synthetic account, id == tenant id.
  const watch = await db
    .select()
    .from(gmailWatch)
    .where(eq(gmailWatch.tenantId, s.id))
    .limit(1);
  return [
    {
      id: s.id,
      tenantId: s.id,
      email: watch[0]?.email ?? "",
      label: null,
      color: null,
      isPrimary: true,
    },
  ];
}

/**
 * Resolve a client-supplied account id to its tenant id, ENFORCING that the
 * account belongs to the current session. Returns null when it doesn't — callers
 * MUST treat that as unauthorized. This is the central authorization gate for
 * every per-account operation: never call corsair.withTenant on a client id
 * without passing through here.
 */
export async function resolveAccountTenant(accountId: string): Promise<string | null> {
  const accounts = await getUserAccounts();
  return accounts.find((a) => a.id === accountId)?.tenantId ?? null;
}

/** The active account (active cookie → primary → first), or null if none. */
export async function getActiveAccount(): Promise<Account | null> {
  const accounts = await getUserAccounts();
  if (accounts.length === 0) return null;
  const activeId = await getActiveAccountCookie();
  return (
    accounts.find((a) => a.id === activeId) ??
    accounts.find((a) => a.isPrimary) ??
    accounts[0] ??
    null
  );
}
