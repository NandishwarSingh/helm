import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import {
  buildAuthUrl,
  createPkcePair,
  PKCE_COOKIE,
} from "@/server/lib/google-oauth";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { ensureTenantId } from "@/server/lib/session";

/**
 * Starts the combined Google consent. Mints the user's tenant if needed, then
 * redirects to a single consent screen covering both Gmail and Calendar.
 */
export async function GET(request: NextRequest) {
  const { ok } = await rateLimit(`oauth:${clientIp(request.headers)}`, 10, 60_000);
  if (!ok) {
    return NextResponse.redirect(new URL("/?error=rate_limited", env.NEXT_PUBLIC_SITE_URL));
  }

  const tenantId = await ensureTenantId();
  // Build the redirect_uri from the canonical site URL, not env.NEXT_PUBLIC_SITE_URL —
  // behind nginx the proxied request is plain http on an internal host, which
  // would send the wrong redirect_uri and trip Google's redirect_uri_mismatch.
  const redirectUri = new URL(
    "/api/oauth/callback",
    env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  // PKCE: keep the verifier server-side in an httpOnly cookie and send only the
  // challenge to Google. sameSite=lax still rides the top-level redirect back to
  // /callback, where the verifier is replayed into the token exchange.
  const { verifier, challenge } = createPkcePair();
  const res = NextResponse.redirect(
    buildAuthUrl(tenantId, redirectUri, Date.now(), challenge),
  );
  res.cookies.set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
