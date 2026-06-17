import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";

/**
 * The OAuth `state` parameter: an HMAC-signed, time-bounded payload. It proves
 * the consent callback belongs to a flow this server started, carries the
 * intent (a normal connect vs ADDING an account to an existing user), and for
 * "add" binds the flow to the session that initiated it — so a victim's Google
 * account can't be linked into an attacker's user, or vice versa. Expires so an
 * intercepted link can't be replayed later.
 */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export type OAuthState = {
  // The tenant this consent provisions: the session's own tenant for a normal
  // connect, or a freshly minted tenant when ADDING an account.
  tenantId: string;
  intent: "connect" | "add";
  // For "add": the session that started the flow, re-verified at the callback.
  ownerKind?: "user" | "tenant";
  ownerId?: string;
};

function sign(value: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(value).digest("base64url");
}

export function signState(state: OAuthState, nowMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: state.tenantId,
      i: state.intent,
      ok: state.ownerKind ?? null,
      o: state.ownerId ?? null,
      n: nowMs,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns the decoded state, or null if tampered, malformed, or expired. */
export function verifyState(state: string, nowMs: number): OAuthState | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  const decoded = Buffer.from(payload, "base64url").toString();
  // Current JSON format.
  if (decoded.startsWith("{")) {
    try {
      const o = JSON.parse(decoded) as {
        t?: string;
        i?: string;
        ok?: string | null;
        o?: string | null;
        n?: number;
      };
      if (!o.t || typeof o.n !== "number") return null;
      if (nowMs - o.n > STATE_MAX_AGE_MS) return null;
      const ownerKind =
        o.ok === "user" || o.ok === "tenant" ? o.ok : undefined;
      return {
        tenantId: o.t,
        intent: o.i === "add" ? "add" : "connect",
        ownerKind,
        ownerId: o.o ?? undefined,
      };
    } catch {
      return null;
    }
  }
  // Legacy "tenantId:nowMs" — an in-flight consent during the deploy that
  // introduced this format. Treated as a normal connect.
  const [tenantId, issued] = decoded.split(":");
  if (!tenantId || !issued) return null;
  if (nowMs - Number(issued) > STATE_MAX_AGE_MS) return null;
  return { tenantId, intent: "connect" };
}
