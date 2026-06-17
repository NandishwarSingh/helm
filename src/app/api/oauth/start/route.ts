import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import {
  buildAuthUrl,
  createPkcePair,
  PKCE_COOKIE,
} from "@/server/lib/google-oauth";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { ensureTenantId } from "@/server/lib/session";
import { verifyTurnstile } from "@/server/lib/turnstile";

/** User-facing redirect base — canonical site, with a dev fallback. */
function appUrl(request: NextRequest, path: string): URL {
  return new URL(path, env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin);
}

/**
 * Mints the tenant (if needed), arms PKCE, and redirects to Google's combined
 * Gmail + Calendar consent. Shared by the gated POST and the dev GET.
 */
async function startConsent(request: NextRequest): Promise<NextResponse> {
  const { ok } = await rateLimit(`oauth:${clientIp(request.headers)}`, 10, 60_000);
  if (!ok) {
    return NextResponse.redirect(appUrl(request, "/?error=rate_limited"), 303);
  }

  const tenantId = await ensureTenantId();
  // Build the redirect_uri from the canonical site URL — behind nginx the
  // proxied request is plain http on an internal host, which would send the
  // wrong redirect_uri and trip Google's redirect_uri_mismatch.
  const redirectUri = new URL(
    "/api/oauth/callback",
    env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  // PKCE: keep the verifier server-side in an httpOnly cookie and send only the
  // challenge to Google. sameSite=lax still rides the top-level redirect back to
  // /callback, where the verifier is replayed into the token exchange.
  const { verifier, challenge } = createPkcePair();
  // 303 See Other: this is reached via the Turnstile-gated POST form, and a 307
  // would re-POST to Google's auth endpoint (which expects a GET). 303 makes the
  // browser GET the consent URL. Harmless for the dev GET path too.
  const res = NextResponse.redirect(
    buildAuthUrl(tenantId, redirectUri, Date.now(), challenge),
    303,
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

/**
 * The human path: the landing's "Connect Google" form posts its Turnstile token
 * here. Verify it (a no-op when Turnstile isn't configured) before starting
 * consent, so the OAuth funnel — and tenant minting — isn't reachable by bots.
 */
export async function POST(request: NextRequest) {
  let token: string | null = null;
  try {
    const form = await request.formData();
    const value = form.get("cf-turnstile-response");
    token = typeof value === "string" ? value : null;
  } catch {
    token = null;
  }

  const passed = await verifyTurnstile(token, clientIp(request.headers));
  if (!passed) {
    return NextResponse.redirect(appUrl(request, "/?error=verify"), 303);
  }
  return startConsent(request);
}

/**
 * Direct GET. When Turnstile is configured the bot check is mandatory, so a
 * token-less GET is bounced to the landing (where the widget lives) rather than
 * silently bypassing it; otherwise (dev / un-keyed prod) it starts consent
 * directly so the flow still works.
 */
export async function GET(request: NextRequest) {
  if (env.TURNSTILE_SECRET_KEY) {
    return NextResponse.redirect(appUrl(request, "/"));
  }
  return startConsent(request);
}
