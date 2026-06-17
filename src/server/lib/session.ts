import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { env } from "@/env";
import { packToken, unpackToken } from "@/server/lib/session-token";

/**
 * Each browser session maps to one Corsair tenant. The tenant id lives in an
 * httpOnly, HMAC-signed cookie so a user can only ever read their own mail.
 * Identity is the signed cookie — no shared inbox, no separate account system.
 */
const COOKIE = "helm_session";
// The cookie IS the identity in this passwordless, tenant-per-browser model, so
// its lifetime doubles as the data-retention window. 90 days keeps a returning
// user's mailbox from being silently orphaned while bounding how long a stolen
// cookie stays useful — and the signed token now carries the same expiry inside
// it (session-token), so a leaked cookie stops verifying server-side once it
// lapses, not just when the browser forgets it. The cookie is httpOnly + secure
// (prod) + sameSite=lax; clearing it (logout) is the explicit invalidation.
const SESSION_MAX_AGE = 60 * 60 * 24 * 90; // seconds

/** The current user's tenant id, or null if they have no valid session. */
export async function getTenantId(): Promise<string | null> {
  const store = await cookies();
  return unpackToken(env.AUTH_SECRET, store.get(COOKIE)?.value, Date.now());
}

/**
 * Returns the current tenant id, minting and persisting one if absent.
 * Only call from a Route Handler or Server Action — it writes a cookie.
 */
export async function ensureTenantId(): Promise<string> {
  const store = await cookies();
  const existing = unpackToken(env.AUTH_SECRET, store.get(COOKIE)?.value, Date.now());
  if (existing) return existing;

  const id = randomUUID();
  store.set(COOKIE, packToken(env.AUTH_SECRET, id, Date.now() + SESSION_MAX_AGE * 1000), {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return id;
}

/** Clears the session cookie, signing the user out of this browser. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}
