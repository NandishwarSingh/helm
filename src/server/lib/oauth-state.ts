import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";

/**
 * The OAuth `state` parameter: an HMAC-signed, time-bounded tenant id. It
 * proves the consent callback belongs to a flow this server started for this
 * tenant, and expires so an intercepted link can't be replayed later.
 */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function sign(value: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(value).digest("base64url");
}

export function signState(tenantId: string, nowMs: number): string {
  const payload = Buffer.from(`${tenantId}:${nowMs}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns the signed tenant id, or null if tampered, malformed, or expired. */
export function verifyState(state: string, nowMs: number): string | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  const [tenantId, issued] = Buffer.from(payload, "base64url")
    .toString()
    .split(":");
  if (!tenantId || !issued) return null;
  if (nowMs - Number(issued) > STATE_MAX_AGE_MS) return null;
  return tenantId;
}
