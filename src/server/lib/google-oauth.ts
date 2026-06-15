import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { env } from "@/env";
import { corsair } from "@/server/corsair";
import { db } from "@/server/db";
import { corsairAccounts, corsairIntegrations } from "@/server/db/schema";

/**
 * A single combined-scope Google consent that connects Gmail and Google
 * Calendar in one step. Corsair's per-plugin OAuth helpers would force two
 * consent screens, so we run the OAuth flow ourselves and store the resulting
 * token under both plugin accounts via Corsair's key API.
 */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

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

function sign(value: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(value).digest("base64url");
}

export function signState(tenantId: string, nowMs: number): string {
  const payload = Buffer.from(`${tenantId}:${nowMs}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string, nowMs: number): string | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  const [tenantId, issued] = Buffer.from(payload, "base64url")
    .toString()
    .split(":");
  if (!tenantId || !issued) return null;
  if (nowMs - Number(issued) > STATE_MAX_AGE_MS) return null;
  return tenantId;
}

export function buildAuthUrl(tenantId: string, redirectUri: string, nowMs: number): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", signState(tenantId, nowMs));
  return url.toString();
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<TokenSet> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return (await res.json()) as TokenSet;
}

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
    await db.insert(corsairAccounts).values({
      id: randomUUID(),
      tenantId,
      integrationId: integration.id,
      config: {},
    });
    return { hadDek: false };
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
