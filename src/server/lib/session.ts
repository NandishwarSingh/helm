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
const ONE_YEAR = 60 * 60 * 24 * 365;

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
    maxAge: ONE_YEAR,
  });
  return id;
}

/** Clears the session cookie, signing the user out of this browser. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}
