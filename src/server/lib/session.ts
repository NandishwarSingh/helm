import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";

import { env } from "@/env";
import { db } from "@/server/db";
import { userAccounts } from "@/server/db/schema";
import {
  packToken,
  packUserToken,
  unpackToken,
  type Session,
} from "@/server/lib/session-token";

/**
 * Identity is the signed httpOnly cookie. A session is either a single connected
 * account (a Corsair tenant — the original passwordless model) or, once a user
 * connects a second account, a `user` that owns several account-tenants. The
 * tenant data plane is unchanged; this layer only resolves which tenant(s) the
 * cookie can act on.
 */
const COOKIE = "helm_session";
// Which account a multi-account user is currently viewing. NOT a security
// boundary (resolveAccountTenant enforces ownership), so it only needs to
// persist the selection across requests.
const ACTIVE_COOKIE = "helm_active_account";
// The cookie lifetime doubles as the data-retention window in this
// passwordless model; the signed token carries the same expiry inside it.
const SESSION_MAX_AGE = 60 * 60 * 24 * 90; // seconds

function cookieOpts() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

/** The raw session (a single-account tenant, or a multi-account user), or null. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return unpackToken(env.AUTH_SECRET, store.get(COOKIE)?.value, Date.now());
}

/** The user id if this is a multi-account session, else null. */
export async function getUserId(): Promise<string | null> {
  const s = await getSession();
  return s?.kind === "user" ? s.id : null;
}

/**
 * Tenant id of the session's ACTIVE account — back-compat for every
 * single-account procedure. A tenant session is its own account; a user session
 * resolves to the active-account cookie (if it belongs to them) or the primary.
 */
export async function getTenantId(): Promise<string | null> {
  const s = await getSession();
  if (!s) return null;
  if (s.kind === "tenant") return s.id;
  const accounts = await db
    .select()
    .from(userAccounts)
    .where(eq(userAccounts.userId, s.id));
  if (accounts.length === 0) return null;
  const store = await cookies();
  const activeId = store.get(ACTIVE_COOKIE)?.value;
  const active =
    accounts.find((a) => a.id === activeId) ??
    accounts.find((a) => a.isPrimary) ??
    accounts[0];
  return active?.tenantId ?? null;
}

/**
 * Returns the current active tenant id, minting + persisting a fresh
 * single-account (tenant) cookie if there's no session. Only call from a Route
 * Handler or Server Action — it writes a cookie.
 */
export async function ensureTenantId(): Promise<string> {
  const existing = await getTenantId();
  if (existing) return existing;
  const id = randomUUID();
  const store = await cookies();
  store.set(
    COOKIE,
    packToken(env.AUTH_SECRET, id, Date.now() + SESSION_MAX_AGE * 1000),
    cookieOpts(),
  );
  return id;
}

/** Promote the session to a multi-account user cookie (set during account linking). */
export async function issueUserCookie(userId: string): Promise<void> {
  const store = await cookies();
  store.set(
    COOKIE,
    packUserToken(env.AUTH_SECRET, userId, Date.now() + SESSION_MAX_AGE * 1000),
    cookieOpts(),
  );
}

/** Persist which account a multi-account user is viewing. */
export async function setActiveAccountCookie(accountId: string): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_COOKIE, accountId, cookieOpts());
}

export async function getActiveAccountCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_COOKIE)?.value ?? null;
}

/** Clears the session, signing the user out of this browser. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
  store.delete(ACTIVE_COOKIE);
}
