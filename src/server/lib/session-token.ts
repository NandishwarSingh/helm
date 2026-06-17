import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure codec for the session cookie value, split out from the cookie/runtime
 * plumbing in session.ts so the signing + expiry logic is unit-testable (no
 * `server-only`, no env, no next/headers — the secret is passed in).
 *
 * New tokens embed an expiry — "s1:<tenantId>:<expMs>" — so a leaked cookie
 * stops verifying once it lapses, not merely when the browser drops it. Legacy
 * tokens signed the bare tenant id; unpack still accepts those (we can't
 * retroactively stamp an expiry on one already issued) but every freshly minted
 * token is bounded.
 */

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function packToken(
  secret: string,
  tenantId: string,
  expMs: number,
): string {
  const value = `s1:${tenantId}:${expMs}`;
  return `${value}.${sign(secret, value)}`;
}

/** Returns the tenant id, or null if tampered, malformed, expired, or absent. */
export function unpackToken(
  secret: string,
  raw: string | undefined,
  nowMs: number,
): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = raw.slice(0, dot);
  const sig = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(secret, value));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  // Current format: "s1:<tenantId>:<expMs>" — reject once past the expiry.
  if (value.startsWith("s1:")) {
    const rest = value.slice(3);
    const sep = rest.lastIndexOf(":");
    if (sep <= 0) return null;
    const id = rest.slice(0, sep);
    const expMs = Number(rest.slice(sep + 1));
    if (!id || !Number.isFinite(expMs) || nowMs > expMs) return null;
    return id;
  }
  // Legacy format: the signed value was the bare tenant id (no expiry).
  return value || null;
}
