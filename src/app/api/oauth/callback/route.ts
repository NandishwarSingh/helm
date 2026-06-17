import { after, type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import {
  armGmailWatch,
  getGmailEmail,
  rememberGmailTenant,
} from "@/server/lib/gmail-watch";
import {
  exchangeCode,
  PKCE_COOKIE,
  storeGoogleTokens,
  verifyState,
} from "@/server/lib/google-oauth";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";

/**
 * Completes the combined Google consent: verifies state, exchanges the code
 * once, and stores the token under both the Gmail and Calendar accounts.
 */
export async function GET(request: NextRequest) {
  const { ok } = await rateLimit(`oauth:${clientIp(request.headers)}`, 10, 60_000);
  if (!ok) {
    return NextResponse.redirect(new URL("/?error=rate_limited", env.NEXT_PUBLIC_SITE_URL));
  }

  const params = request.nextUrl.searchParams;

  if (params.get("error")) {
    return NextResponse.redirect(new URL("/?error=denied", env.NEXT_PUBLIC_SITE_URL));
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/?error=missing_code", env.NEXT_PUBLIC_SITE_URL));
  }

  const tenantId = verifyState(state, Date.now());
  if (!tenantId) {
    return NextResponse.redirect(new URL("/?error=bad_state", env.NEXT_PUBLIC_SITE_URL));
  }

  // The state must belong to THIS browser's session. Without this check a
  // crafted consent link could land a victim's Google account in the
  // attacker's tenant (OAuth login-CSRF).
  const sessionTenantId = await getTenantId();
  if (sessionTenantId !== tenantId) {
    return NextResponse.redirect(new URL("/?error=bad_state", env.NEXT_PUBLIC_SITE_URL));
  }

  // Must be byte-identical to the redirect_uri sent in /oauth/start — build it
  // from the canonical site URL, not the proxied env.NEXT_PUBLIC_SITE_URL.
  const redirectUri = new URL(
    "/api/oauth/callback",
    env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  // The PKCE verifier that /oauth/start stashed; the token exchange can't
  // complete without it (Google rejects a code-only redemption once a challenge
  // was sent), so a missing cookie means a stale or forged callback.
  const codeVerifier = request.cookies.get(PKCE_COOKIE)?.value;
  if (!codeVerifier) {
    return NextResponse.redirect(new URL("/?error=bad_state", env.NEXT_PUBLIC_SITE_URL));
  }

  try {
    const tokens = await exchangeCode(code, redirectUri, codeVerifier);
    await storeGoogleTokens(tenantId, tokens);
    // Wire realtime for this mailbox after the redirect: map its address to this
    // tenant (so pushes route here) and arm the Gmail watch. Best-effort — a
    // failure must not block the connect; the renewal cron catches up.
    after(async () => {
      try {
        const email = await getGmailEmail(tenantId);
        if (email) await rememberGmailTenant(tenantId, email);
        await armGmailWatch(tenantId);
      } catch (error) {
        console.error(
          "[oauth] watch registration failed:",
          error instanceof Error ? error.message : error,
        );
      }
    });
    const done = NextResponse.redirect(
      new URL("/?connected=1", env.NEXT_PUBLIC_SITE_URL),
    );
    done.cookies.delete(PKCE_COOKIE);
    return done;
  } catch (error) {
    console.error(
      "oauth callback failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.redirect(new URL("/?error=oauth_callback", env.NEXT_PUBLIC_SITE_URL));
  }
}
