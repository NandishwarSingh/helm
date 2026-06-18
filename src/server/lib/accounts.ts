import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { corsair } from "@/server/corsair";
import { conn, db } from "@/server/db";
import {
  corsairAccounts,
  corsairEntities,
  corsairEvents,
  gmailWatch,
  mailSync,
  mailTriage,
  userAccounts,
  users,
} from "@/server/db/schema";
import { stopCalendarWatch } from "@/server/lib/calendar-watch";
import { MAX_ACCOUNTS } from "@/server/lib/concurrency";
import { deleteTenantDocuments } from "@/server/lib/documents";
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
 * Fully decommission a tenant: revoke its Google grant (so the refresh token
 * dies) and purge every trace — Corsair's account/cache plus our derived triage,
 * embeddings, sync cursor, and watch routing. Used when an "add" doesn't adopt
 * the freshly-minted tenant (dedupe) and when a user removes an account, so no
 * orphaned, token-bearing tenant is ever left behind. Best-effort + idempotent.
 */
export async function teardownTenant(
  tenantId: string,
  opts: { revoke?: boolean } = {},
): Promise<void> {
  // Revoking an access token revokes the WHOLE Google grant. Only do it for a
  // genuine account removal — never for an "add" dedupe, where the orphan tenant
  // shares its grant with an account the user is keeping (revoking would break
  // that kept account).
  if (opts.revoke ?? true) {
    try {
      const token = await corsair
        .withTenant(tenantId)
        .gmail.keys.get_access_token();
      if (token) {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
          { method: "POST" },
        ).catch(() => undefined);
      }
    } catch {
      /* no token / not connected — nothing to revoke */
    }
  }
  // Purge Corsair's cache (entities/events reference the account rows).
  const accounts = await db
    .select({ id: corsairAccounts.id })
    .from(corsairAccounts)
    .where(eq(corsairAccounts.tenantId, tenantId));
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    await db
      .delete(corsairEntities)
      .where(inArray(corsairEntities.accountId, accountIds));
    await db
      .delete(corsairEvents)
      .where(inArray(corsairEvents.accountId, accountIds));
    await db.delete(corsairAccounts).where(eq(corsairAccounts.tenantId, tenantId));
  }
  await db.delete(mailSync).where(eq(mailSync.tenantId, tenantId));
  await db.delete(mailTriage).where(eq(mailTriage.tenantId, tenantId));
  await db.delete(gmailWatch).where(eq(gmailWatch.tenantId, tenantId));
  await stopCalendarWatch(tenantId);
  // mail_embeddings is a raw (non-Drizzle) table.
  await conn`delete from mail_embeddings where tenant_id = ${tenantId}`;
  // Documents (attachments) + their embeddings, else downloads route to a dead tenant.
  await deleteTenantDocuments(tenantId);
}

/**
 * Links a newly-consented account to the session that initiated the "add" flow.
 * The first time a single-account (tenant) session adds a second mailbox, a user
 * is materialized that owns BOTH the original tenant (primary) and the new one,
 * and the session cookie is promoted to that user. A session that's already a
 * user just gains another account row. Sets the new account active so the user
 * lands on what they just connected. Idempotent on the (user, email) unique —
 * and any tenant we DON'T adopt is torn down so its token never lingers.
 */
export async function linkAddedAccount(opts: {
  ownerKind?: "user" | "tenant";
  ownerId?: string;
  newTenantId: string;
  email: string;
}): Promise<void> {
  const { ownerKind, ownerId, newTenantId, email } = opts;
  if (!ownerId) {
    await teardownTenant(newTenantId);
    return;
  }

  if (ownerKind === "user") {
    const existing = await db
      .select({ id: userAccounts.id })
      .from(userAccounts)
      .where(eq(userAccounts.userId, ownerId));
    // Re-enforce the cap here too: /oauth/start checks it, but two concurrent
    // add flows could each pass that check and then both land here. A genuinely
    // over-cap account is a distinct mailbox/grant, so revoke it as we drop it.
    if (existing.length >= MAX_ACCOUNTS) {
      await teardownTenant(newTenantId);
      return;
    }
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
    if (added[0]) {
      await setActiveAccountCookie(added[0].id);
    } else {
      // The (user, email) dedupe rejected it → the fresh tenant is orphaned.
      // Don't revoke: the duplicate shares its grant with the kept account.
      await teardownTenant(newTenantId, { revoke: false });
    }
    return;
  }

  // Single-account (tenant) session → materialize a user owning old + new.
  const oldEmail = await emailForTenant(ownerId);
  // Re-consenting the SAME mailbox (oldEmail is "" when unknown, which never
  // matches the new non-empty email): nothing to add, tear the new tenant down.
  if (oldEmail.toLowerCase() === email.toLowerCase()) {
    // Same grant as the account they're already on — purge but DON'T revoke.
    await teardownTenant(newTenantId, { revoke: false });
    return;
  }

  const userId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId });
    await tx.insert(userAccounts).values({
      id: randomUUID(),
      userId,
      tenantId: ownerId,
      email: oldEmail,
      isPrimary: true,
      color: pickColor(0),
    });
    await tx
      .insert(userAccounts)
      .values({
        id: randomUUID(),
        userId,
        tenantId: newTenantId,
        email,
        isPrimary: false,
        color: pickColor(1),
      })
      .onConflictDoNothing();
  });

  const newRow = await db
    .select({ id: userAccounts.id })
    .from(userAccounts)
    .where(
      and(eq(userAccounts.userId, userId), eq(userAccounts.tenantId, newTenantId)),
    )
    .limit(1);
  await issueUserCookie(userId);
  if (newRow[0]) await setActiveAccountCookie(newRow[0].id);
  else await teardownTenant(newTenantId, { revoke: false });
}
