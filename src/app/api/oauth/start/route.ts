import { type NextRequest, NextResponse } from "next/server";

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
    return NextResponse.redirect(new URL("/?error=rate_limited", request.url));
  }

  const tenantId = await ensureTenantId();
  const redirectUri = new URL("/api/oauth/callback", request.url).toString();
  return NextResponse.redirect(buildAuthUrl(tenantId, redirectUri, Date.now()));
}
