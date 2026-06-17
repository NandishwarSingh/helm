import "server-only";

import { env } from "@/env";

const SITEVERIFY =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verifies a Cloudflare Turnstile token server-side before a sensitive action
 * (here: starting the Google OAuth flow). Returns true when the token is valid.
 *
 * Fails OPEN when Turnstile isn't configured — no secret means dev and an
 * un-keyed prod still connect — but fails CLOSED once a secret is set: a
 * missing or rejected token is denied. The remote IP is forwarded when known so
 * Cloudflare can factor it into scoring.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured → skip the check
  if (!token) return false;

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== "local") form.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[turnstile] siteverify HTTP", res.status);
      return false;
    }
    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    if (!data.success) {
      console.warn(
        "[turnstile] rejected:",
        data["error-codes"]?.join(",") ?? "unknown",
      );
    }
    return Boolean(data.success);
  } catch (error) {
    console.error(
      "[turnstile] verify error:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** True once Turnstile is fully configured (both keys present). */
export function turnstileConfigured(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}
