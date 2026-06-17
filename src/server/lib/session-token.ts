import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure codec for the session cookie value, split out from the cookie/runtime
 * plumbing in session.ts so the signing + expiry logic is unit-testable (no
 * `server-only`, no env, no next/headers — the secret is passed in).
 *
 * Three shapes, all HMAC-signed with an embedded expiry so a leaked cookie stops
 * verifying once it lapses:
 *   - "s2:<userId>:<expMs>"   — a multi-account user (owns several accounts)
 *   - "s1:<tenantId>:<expMs>" — a single connected account (the original model,
 *     still issued on first connect)
 *   - legacy bare tenant id   — pre-expiry tokens, still accepted on read
 * unpack reports which kind it is so the caller can resolve a user vs a single
 * tenant.
 */

export type Session =
  | { kind: "user"; id: string }
  | { kind: "tenant"; id: string };

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function pack(secret: string, value: string): string {
  return `${value}.${sign(secret, value)}`;
}

/** Single-account (tenant) cookie value — issued on first connect. */
export function packToken(secret: string, tenantId: string, expMs: number): string {
  return pack(secret, `s1:${tenantId}:${expMs}`);
}

/** Multi-account (user) cookie value — issued once a user has 2+ accounts. */
export function packUserToken(secret: string, userId: string, expMs: number): string {
  return pack(secret, `s2:${userId}:${expMs}`);
}

/** Verify + decode a cookie value, or null if tampered, malformed, expired, or absent. */
export function unpackToken(
  secret: string,
  raw: string | undefined,
  nowMs: number,
): Session | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = raw.slice(0, dot);
  const sig = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(secret, value));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  // Versioned formats: "s2:<userId>:<expMs>" or "s1:<tenantId>:<expMs>".
  const kind =
    value.startsWith("s2:") ? "user" : value.startsWith("s1:") ? "tenant" : null;
  if (kind) {
    const rest = value.slice(3);
    const sep = rest.lastIndexOf(":");
    if (sep <= 0) return null;
    const id = rest.slice(0, sep);
    const expMs = Number(rest.slice(sep + 1));
    if (!id || !Number.isFinite(expMs) || nowMs > expMs) return null;
    return { kind, id };
  }
  // Legacy: the signed value was the bare tenant id (no expiry, no prefix).
  return value ? { kind: "tenant", id: value } : null;
}
