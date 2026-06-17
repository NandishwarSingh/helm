import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { gmailWatch, userAccounts, users } from "@/server/db/schema";
import { getGmailEmail } from "@/server/lib/gmail-watch";
import { issueUserCookie, setActiveAccountCookie } from "@/server/lib/session";

/** A small palette so each account gets a distinct dot in the UI. */
export const ACCOUNT_COLORS = [
  "#38bdf8",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#a78bfa",
  "#fb7185",
  "#22d3ee",
];

function pickColor(index: number): string {
  return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length]!;
}

/** The verified address for a tenant — from the watch map, else a live lookup. */
async function emailForTenant(tenantId: string): Promise<string> {
  const rows = await db
    .select({ email: gmailWatch.email })
    .from(gmailWatch)
    .where(eq(gmailWatch.tenantId, tenantId))
    .limit(1);
  if (rows[0]?.email) return rows[0].email;
  return (await getGmailEmail(tenantId)) ?? "";
}

/**
 * Links a newly-consented account to the session that initiated the "add" flow.
 * The first time a single-account (tenant) session adds a second mailbox, a user
 * is materialized that owns BOTH the original tenant (primary) and the new one,
 * and the session cookie is promoted to that user. A session that's already a
 * user just gains another account row. Sets the new account active so the user
 * lands on what they just connected. Idempotent on the (user, email) unique.
 */
export async function linkAddedAccount(opts: {
  ownerKind?: "user" | "tenant";
  ownerId?: string;
  newTenantId: string;
  email: string;
}): Promise<void> {
  const { ownerKind, ownerId, newTenantId, email } = opts;
  if (!ownerId) return;

  if (ownerKind === "user") {
    const existing = await db
      .select({ id: userAccounts.id })
      .from(userAccounts)
      .where(eq(userAccounts.userId, ownerId));
    await db
      .insert(userAccounts)
      .values({
        id: randomUUID(),
        userId: ownerId,
        tenantId: newTenantId,
        email,
        color: pickColor(existing.length),
        isPrimary: false,
      })
      .onConflictDoNothing();
    const added = await db
      .select({ id: userAccounts.id })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.userId, ownerId),
          eq(userAccounts.tenantId, newTenantId),
        ),
      )
      .limit(1);
    if (added[0]) await setActiveAccountCookie(added[0].id);
    return;
  }

  // Single-account (tenant) session → materialize a user owning old + new.
  const oldEmail = await emailForTenant(ownerId);
  // Re-consenting the SAME mailbox (oldEmail is "" when unknown, which never
  // matches the new non-empty email): nothing to add, keep the simple model.
  if (oldEmail.toLowerCase() === email.toLowerCase()) return;

  const userId = randomUUID();
  await db.insert(users).values({ id: userId });
  await db.insert(userAccounts).values({
    id: randomUUID(),
    userId,
    tenantId: ownerId,
    email: oldEmail,
    isPrimary: true,
    color: pickColor(0),
  });
  const newId = randomUUID();
  await db
    .insert(userAccounts)
    .values({
      id: newId,
      userId,
      tenantId: newTenantId,
      email,
      isPrimary: false,
      color: pickColor(1),
    })
    .onConflictDoNothing();
  await issueUserCookie(userId);
  await setActiveAccountCookie(newId);
}
