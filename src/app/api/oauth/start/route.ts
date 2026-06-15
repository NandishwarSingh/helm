import { generateOAuthUrl } from "corsair/oauth";
import { type NextRequest, NextResponse } from "next/server";

import { corsair } from "@/server/corsair";
import { ensureTenantId } from "@/server/lib/session";

const PLUGINS = new Set(["gmail", "googlecalendar"]);

/**
 * Begins the Google OAuth flow for one plugin. Mints the user's tenant if
 * needed, then redirects to Google's consent screen.
 */
export async function GET(request: NextRequest) {
  const plugin = request.nextUrl.searchParams.get("plugin") ?? "gmail";
  if (!PLUGINS.has(plugin)) {
    return NextResponse.redirect(new URL("/?error=unknown_plugin", request.url));
  }

  const tenantId = await ensureTenantId();
  const redirectUri = new URL("/api/oauth/callback", request.url).toString();

  try {
    const { url } = await generateOAuthUrl(corsair, plugin, {
      tenantId,
      redirectUri,
    });
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/?error=oauth_start", request.url));
  }
}
