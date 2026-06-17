import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import {
  buildAuthUrl,
  createPkcePair,
  PKCE_COOKIE,
} from "@/server/lib/google-oauth";
import { type OAuthState } from "@/server/lib/oauth-state";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { ensureTenantId, getSession } from "@/server/lib/session";
import { verifyTurnstile } from "@/server/lib/turnstile";

/** User-facing redirect base — canonical site, with a dev fallback. */
function appUrl(request: NextRequest, path: string): URL {
  return new URL(path, env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin);
}

/**
 * Arms PKCE and redirects to Google's combined Gmail + Calendar consent. A
 * normal connect provisions the session's own tenant; an "add" provisions a
 * FRESH tenant for the new mailbox and binds the flow to the initiating session
 * (re-verified at the callback) so it can only ever attach to that user.
 */
async function startConsent(
  request: NextRequest,
  intent: "connect" | "add",
): Promise<NextResponse> {
  const { ok } = await rateLimit(`oauth:${clientIp(request.headers)}`, 10, 60_000);
  if (!ok) {
    return NextResponse.redirect(appUrl(request, "/?error=rate_limited"), 303);
  }

  let state: OAuthState;
  if (intent === "add") {
    const session = await getSession();
    if (session) {
      state = {
        tenantId: randomUUID(),
        intent: "add",
        ownerKind: session.kind,
        ownerId: session.id,
      };
    } else {
      // No session to add to — degrade to a normal first connect.
      state = { tenantId: await ensureTenantId(), intent: "connect" };
    }
  } else {
    state = { tenantId: await ensureTenantId(), intent: "connect" };
  }

  // Build the redirect_uri from the canonical site URL — behind nginx the
  // proxied request is plain http on an internal host, which would send the
  // wrong redirect_uri and trip Google's redirect_uri_mismatch.
  const redirectUri = new URL(
    "/api/oauth/callback",
    env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  const { verifier, challenge } = createPkcePair();
  // 303 See Other: reached via the Turnstile-gated POST form; a 307 would
  // re-POST to Google's auth endpoint (which expects a GET).
  const res = NextResponse.redirect(
    buildAuthUrl(state, redirectUri, Date.now(), challenge),
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
 * The human path. The landing's "Connect Google" form posts a Turnstile token
 * here for a first connect. An authenticated "Add account" (hidden intent=add)
 * is gated by the existing session itself, so it skips Turnstile but stays
 * rate-limited.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const intent = form?.get("intent") === "add" ? "add" : "connect";

  if (intent === "add" && (await getSession())) {
    return startConsent(request, "add");
  }

  const value = form?.get("cf-turnstile-response");
  const token = typeof value === "string" ? value : null;
  const passed = await verifyTurnstile(token, clientIp(request.headers));
  if (!passed) {
    return NextResponse.redirect(appUrl(request, "/?error=verify"), 303);
  }
  return startConsent(request, "connect");
}

/**
 * Direct GET. When Turnstile is configured the bot check is mandatory, so a
 * token-less GET is bounced to the landing; otherwise (dev) it starts consent.
 */
export async function GET(request: NextRequest) {
  if (env.TURNSTILE_SECRET_KEY) {
    return NextResponse.redirect(appUrl(request, "/"));
  }
  return startConsent(request, "connect");
}
