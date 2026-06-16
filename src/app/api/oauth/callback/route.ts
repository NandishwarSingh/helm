import { type NextRequest, NextResponse } from "next/server";

import {
  exchangeCode,
  storeGoogleTokens,
  verifyState,
} from "@/server/lib/google-oauth";

/**
 * Completes the combined Google consent: verifies state, exchanges the code
 * once, and stores the token under both the Gmail and Calendar accounts.
 */
export async function GET(request: NextRequest) {
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
