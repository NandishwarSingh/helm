import { type NextRequest, NextResponse } from "next/server";

import {
  exchangeCode,
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
    return NextResponse.redirect(new URL("/?error=rate_limited", request.url));
  }

  const params = request.nextUrl.searchParams;

  if (params.get("error")) {
    return NextResponse.redirect(new URL("/?error=denied", request.url));
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/?error=missing_code", request.url));
  }

  const tenantId = verifyState(state, Date.now());
  if (!tenantId) {
    return NextResponse.redirect(new URL("/?error=bad_state", request.url));
  }

  // The state must belong to THIS browser's session. Without this check a
  // crafted consent link could land a victim's Google account in the
  // attacker's tenant (OAuth login-CSRF).
  const sessionTenantId = await getTenantId();
  if (sessionTenantId !== tenantId) {
    return NextResponse.redirect(new URL("/?error=bad_state", request.url));
  }

  const redirectUri = new URL("/api/oauth/callback", request.url).toString();
  try {
    const tokens = await exchangeCode(code, redirectUri);
    await storeGoogleTokens(tenantId, tokens);
    return NextResponse.redirect(new URL("/?connected=1", request.url));
  } catch (error) {
    console.error(
      "oauth callback failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.redirect(new URL("/?error=oauth_callback", request.url));
  }
}
