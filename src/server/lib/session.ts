import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { env } from "@/env";

/**
 * Each browser session maps to one Corsair tenant. The tenant id lives in an
 * httpOnly, HMAC-signed cookie so a user can only ever read their own mail.
 * Identity is the signed cookie — no shared inbox, no separate account system.
 */
const COOKIE = "helm_session";
// The cookie IS the identity in this passwordless, tenant-per-browser model, so
// its lifetime doubles as the data-retention window. 90 days keeps a returning
// user's mailbox from being silently orphaned while bounding how long a stolen
// cookie stays useful. There's no server-side session store to revoke against —
// a deliberate tradeoff of the anonymous-tenant model; clearing the cookie
// (logout) is the only invalidation, and the cookie is httpOnly + secure (prod)
// + sameSite=lax to make theft hard in the first place.
const SESSION_MAX_AGE = 60 * 60 * 24 * 90;

function sign(value: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(value).digest("base64url");
}

function pack(tenantId: string): string {
  return `${tenantId}.${sign(tenantId)}`;
}

function unpack(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const sig = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(id));
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  return id;
}

/** The current user's tenant id, or null if they have no valid session. */
export async function getTenantId(): Promise<string | null> {
  const store = await cookies();
  return unpack(store.get(COOKIE)?.value);
}

/**
 * Returns the current tenant id, minting and persisting one if absent.
 * Only call from a Route Handler or Server Action — it writes a cookie.
 */
export async function ensureTenantId(): Promise<string> {
  const store = await cookies();
  const existing = unpack(store.get(COOKIE)?.value);
  if (existing) return existing;

  const id = randomUUID();
  store.set(COOKIE, pack(id), {
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
