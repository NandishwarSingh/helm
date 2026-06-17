import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import { buildAuthUrl } from "@/server/lib/google-oauth";
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
  return NextResponse.redirect(buildAuthUrl(tenantId, redirectUri, Date.now()));
}
