import { processOAuthCallback } from "corsair/oauth";
import { type NextRequest, NextResponse } from "next/server";

import { corsair } from "@/server/corsair";

/**
 * Completes the Google OAuth flow: exchanges the code for tokens (stored
 * encrypted, scoped to the tenant carried in `state`). After Gmail connects,
 * it chains into Calendar so one click connects both.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const error = params.get("error");
  const code = params.get("code");
  const state = params.get("state");

  if (error) {
    return NextResponse.redirect(new URL("/?error=denied", request.url));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL("/?error=missing_code", request.url));
  }

  const redirectUri = new URL("/api/oauth/callback", request.url).toString();

  try {
    const { plugin } = await processOAuthCallback(corsair, {
      code,
      state,
      redirectUri,
    });

    if (plugin === "gmail") {
      return NextResponse.redirect(
        new URL("/api/oauth/start?plugin=googlecalendar", request.url),
      );
    }
    return NextResponse.redirect(new URL("/?connected=1", request.url));
  } catch {
    return NextResponse.redirect(new URL("/?error=oauth_callback", request.url));
  }
}
