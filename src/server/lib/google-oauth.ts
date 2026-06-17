import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { env } from "@/env";
import { corsair } from "@/server/corsair";
import { db } from "@/server/db";
import { corsairAccounts, corsairIntegrations } from "@/server/db/schema";
import { signState } from "@/server/lib/oauth-state";

export { verifyState } from "@/server/lib/oauth-state";

/**
 * A single combined-scope Google consent that connects Gmail and Google
 * Calendar in one step. Corsair's per-plugin OAuth helpers would force two
 * consent screens, so we run the OAuth flow ourselves and store the resulting
 * token under both plugin accounts via Corsair's key API.
 */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
// Google serves token exchange on several hosts; routes to any one of them
// can flap, so the exchange fails over with tight per-attempt timeouts.
const TOKEN_ENDPOINTS = [
  "https://oauth2.googleapis.com/token",
  "https://www.googleapis.com/oauth2/v4/token",
  "https://accounts.google.com/o/oauth2/token",
];
const TOKEN_TIMEOUT_MS = 8000;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
];

type TokenSet = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

/** Cookie holding the PKCE code_verifier between /oauth/start and /callback. */
export const PKCE_COOKIE = "helm_pkce";

/** A PKCE (S256) verifier/challenge pair — proves the callback came from us. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(
  tenantId: string,
  redirectUri: string,
  nowMs: number,
  codeChallenge: string,
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // PKCE: bind this authorization to a secret only we hold, so an intercepted
  // code can't be redeemed without the verifier (defense-in-depth atop state).
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", signState(tenantId, nowMs));
  return url.toString();
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  }).toString();

  let lastError: unknown;
  // Two passes over the endpoint list: survives one host being unreachable
  // and a transient drop on the others.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const endpoint of TOKEN_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (res.ok) return (await res.json()) as TokenSet;
        // A definitive OAuth rejection (bad/expired/consumed code) is the
        // same on every host — do not fail over, surface it.
        if (res.status >= 400 && res.status < 500) {
          const detail = await res.text().catch(() => "");
          throw new DefinitiveOAuthError(
            `token exchange rejected (${res.status}): ${detail.slice(0, 200)}`,
          );
        }
        lastError = new Error(`token endpoint ${endpoint} -> ${res.status}`);
      } catch (error) {
        if (error instanceof DefinitiveOAuthError) throw error;
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("token exchange failed on all endpoints");
}

class DefinitiveOAuthError extends Error {}

/** Ensures an account row exists for the tenant + plugin; returns whether it already had a DEK. */
async function ensureAccount(
  tenantId: string,
  pluginName: string,
): Promise<{ hadDek: boolean }> {
  const [integration] = await db
    .select({ id: corsairIntegrations.id })
    .from(corsairIntegrations)
    .where(eq(corsairIntegrations.name, pluginName));
  if (!integration) {
    throw new Error(`integration "${pluginName}" is not set up`);
  }

  const [existing] = await db
    .select({ dek: corsairAccounts.dek })
    .from(corsairAccounts)
    .where(
      and(
        eq(corsairAccounts.tenantId, tenantId),
        eq(corsairAccounts.integrationId, integration.id),
      ),
    );

  if (!existing) {
    // Two concurrent consents must not create two account rows — the unique
    // index makes the second insert a no-op and it re-reads the winner.
    await db
      .insert(corsairAccounts)
      .values({
        id: randomUUID(),
        tenantId,
        integrationId: integration.id,
        config: {},
      })
      .onConflictDoNothing();
    const [winner] = await db
      .select({ dek: corsairAccounts.dek })
      .from(corsairAccounts)
      .where(
        and(
          eq(corsairAccounts.tenantId, tenantId),
          eq(corsairAccounts.integrationId, integration.id),
        ),
      );
    return { hadDek: Boolean(winner?.dek) };
  }
  return { hadDek: Boolean(existing.dek) };
}

/**
 * Stores the Google grant under both plugin accounts. Only the durable
 * refresh token and scope are written — Corsair mints fresh access tokens
 * from the refresh token on demand, so there is no expiry to track here.
 */
export async function storeGoogleTokens(
  tenantId: string,
  tokens: TokenSet,
): Promise<void> {
  const scoped = corsair.withTenant(tenantId);

  const gmail = await ensureAccount(tenantId, "gmail");
  if (!gmail.hadDek) await scoped.gmail.keys.issue_new_dek();
  if (tokens.refresh_token) {
    await scoped.gmail.keys.set_refresh_token(tokens.refresh_token);
  }
  if (tokens.scope) await scoped.gmail.keys.set_scope(tokens.scope);

  const calendar = await ensureAccount(tenantId, "googlecalendar");
  if (!calendar.hadDek) await scoped.googlecalendar.keys.issue_new_dek();
  if (tokens.refresh_token) {
    await scoped.googlecalendar.keys.set_refresh_token(tokens.refresh_token);
  }
  if (tokens.scope) await scoped.googlecalendar.keys.set_scope(tokens.scope);
}
