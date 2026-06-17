import { after, type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import { linkAddedAccount } from "@/server/lib/accounts";
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
import { getSession, getTenantId } from "@/server/lib/session";

function err(code: string): NextResponse {
  return NextResponse.redirect(new URL(`/?error=${code}`, env.NEXT_PUBLIC_SITE_URL));
}

/**
 * Completes the combined Google consent: verifies state, exchanges the code
 * once, stores the token under the (new or existing) tenant, then either links
 * the new account to the user (intent=add) or finishes a normal first connect.
 */
export async function GET(request: NextRequest) {
  const { ok } = await rateLimit(`oauth:${clientIp(request.headers)}`, 10, 60_000);
  if (!ok) return err("rate_limited");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return err("denied");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return err("missing_code");

  const parsed = verifyState(state, Date.now());
  if (!parsed) return err("bad_state");
  const { tenantId, intent, ownerKind, ownerId } = parsed;

  // The PKCE verifier /oauth/start stashed; a missing cookie means a stale or
  // forged callback (Google rejects a code-only redemption once a challenge was
  // sent).
  const codeVerifier = request.cookies.get(PKCE_COOKIE)?.value;
  if (!codeVerifier) return err("bad_state");

  // CSRF: bind the callback to the session that initiated this flow. For "add"
  // the new tenant isn't the session's, so we match the initiating session id
  // instead; for a connect the session's active tenant must equal the consent's.
  if (intent === "add") {
    const session = await getSession();
    if (!session || session.kind !== ownerKind || session.id !== ownerId) {
      return err("bad_state");
    }
  } else {
    const sessionTenantId = await getTenantId();
    if (sessionTenantId !== tenantId) return err("bad_state");
  }

  const redirectUri = new URL(
    "/api/oauth/callback",
    env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  try {
    const tokens = await exchangeCode(code, redirectUri, codeVerifier);
    await storeGoogleTokens(tenantId, tokens);

    if (intent === "add") {
      // Need the verified email synchronously to link + dedupe the account.
      const email = await getGmailEmail(tenantId);
      if (!email) return err("oauth_callback");
      await linkAddedAccount({ ownerKind, ownerId, newTenantId: tenantId, email });
      after(async () => {
        try {
          await rememberGmailTenant(tenantId, email);
          await armGmailWatch(tenantId);
        } catch (error) {
          console.error(
            "[oauth] watch registration failed:",
            error instanceof Error ? error.message : error,
          );
        }
      });
    } else {
      // First connect: wire realtime for this mailbox after the redirect.
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
    }

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
    return err("oauth_callback");
  }
}
