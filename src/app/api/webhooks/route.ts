import { timingSafeEqual } from "node:crypto";

import { processWebhook } from "corsair";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";

import { env } from "@/env";
import { corsair } from "@/server/corsair";
import { gmailPushEmail, tenantsForEmail } from "@/server/lib/gmail-watch";
import { syncNewMailForTenant } from "@/server/lib/mail-sync";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { notifyTenant } from "@/server/lib/realtime";

const isDev = env.NODE_ENV !== "production";

/**
 * One mail sync per tenant at a time within this instance. A burst of Google
 * pushes (or a retry storm) would otherwise launch overlapping syncs that all
 * hammer the Gmail API for the same window; instead the first sync runs and
 * later pushes are coalesced into a plain notify.
 */
const runningSync = new Map<string, Promise<number>>();

/** Constant-time compare of two secrets (mirrors the cookie sig check). */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Sync the newest mail for a tenant, then notify its open connections. The
 * sync is coalesced so concurrent webhooks share one run; either way the
 * tenant is notified once the (in-flight or fresh) sync settles.
 */
function syncAndNotify(tenantId: string): void {
  const inflight = runningSync.get(tenantId);
  if (inflight) {
    // A sync is already pulling this window; just ride it, then notify.
    void inflight.finally(() => notifyTenant(tenantId));
    return;
  }

  const work = syncNewMailForTenant(tenantId)
    .catch((error) => {
      console.error(
        "[webhook] sync failed:",
        error instanceof Error ? error.message : error,
      );
      return -1;
    })
    .finally(() => {
      runningSync.delete(tenantId);
    });
  runningSync.set(tenantId, work);

  void work.then((synced) => {
    if (isDev) {
      console.log("[webhook] synced", synced, "msgs -> notify", tenantId);
    }
    notifyTenant(tenantId);
  });
}

/**
 * Receives Google push notifications (Gmail watch, Calendar channels) and
 * hands them to Corsair, which validates and applies them to the cache. A Gmail
 * push carries the mailbox address, so it routes to whichever tenant owns that
 * address (see gmail-watch); Calendar channels and any unmapped address fall
 * back to the pinned TENANT_ID (the original single-tenant deploy).
 */
export async function POST(request: NextRequest) {
  const { ok } = await rateLimit(`webhook:${clientIp(request.headers)}`, 120, 60_000);
  if (!ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  // Every caller must present the shared secret (header or query) before we run
  // any side effect. Fail closed in production: a missing secret would otherwise
  // skip the check and accept unauthenticated pushes. Env validation requires it
  // in prod, but a SKIP_ENV_VALIDATION build could slip through, so we also
  // refuse at the edge. Locally (dev) an unset secret skips the check.
  if (!isDev && !env.WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "Webhook auth not configured." },
      { status: 503 },
    );
  }
  if (env.WEBHOOK_SECRET) {
    const provided =
      request.headers.get("x-webhook-secret") ??
      new URL(request.url).searchParams.get("secret") ??
      "";
    if (!secretMatches(provided, env.WEBHOOK_SECRET)) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const contentType = request.headers.get("content-type");
  let body: string | Record<string, unknown>;
  if (contentType?.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  } else {
    const text = await request.text().catch(() => "");
    body = text.trim() ? text : {};
  }

  try {
    // Route the push to the tenant(s) that own the mailbox. A Gmail push carries
    // the address; the same mailbox may be connected from several sessions, so
    // fan out to all of them. Calendar channels and any unmapped address fall
    // back to the pinned tenant (the original single-tenant deploy).
    const pushEmail = gmailPushEmail(body);
    const mapped = pushEmail ? await tenantsForEmail(pushEmail) : [];
    const routedTenants = mapped.length > 0 ? mapped : [env.TENANT_ID];

    // The ack is identical for every tenant (same historyId), so validate once
    // against the primary; the per-tenant cache pull happens in syncAndNotify.
    const result = await processWebhook(corsair, headers, body, {
      tenantId: routedTenants[0]!,
    });

    if (isDev) {
      console.log("[webhook] matched handler:", Boolean(result.response));
    }

    const nextHeaders = new Headers();
    if (result.responseHeaders) {
      for (const [key, value] of Object.entries(result.responseHeaders)) {
        nextHeaders.set(key, value);
      }
    }

    if (!result.response) {
      return NextResponse.json(
        { error: "No matching webhook handler." },
        { status: 404, headers: nextHeaders },
      );
    }

    // Gmail's push only carries a historyId, so the new mail has to be pulled
    // into the cache before the client refetches. That sync is slow, so ack
    // Google immediately and run it after the response — overlapping pushes are
    // coalesced so a retry storm can't pile up syncs.
    after(async () => {
      for (const tenantId of routedTenants) syncAndNotify(tenantId);
    });

    return NextResponse.json(result.response, { headers: nextHeaders });
  } catch (error) {
    console.error(
      "webhook processing failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "Webhook failed." }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
