import { processWebhook } from "corsair";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { env } from "@/env";
import { corsair } from "@/server/corsair";
import { syncNewMailForTenant } from "@/server/lib/mail-sync";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { notifyTenant } from "@/server/lib/realtime";

/**
 * Receives Google push notifications (Gmail watch, Calendar channels) and
 * hands them to Corsair, which validates and applies them to the cache.
 * Tenant routing is fixed until channels are registered per tenant at
 * deploy time — registration stamps each channel with its tenant id.
 */
export async function POST(request: NextRequest) {
  const { ok } = await rateLimit(`webhook:${clientIp(request.headers)}`, 120, 60_000);
  if (!ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
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
    const result = await processWebhook(corsair, headers, body, {
      tenantId: env.TENANT_ID,
    });

    console.log("[webhook] matched handler:", Boolean(result.response));
    if (result.response) {
      // Gmail's push only carries a historyId, so pull the new mail into the
      // cache BEFORE notifying — otherwise the client refetches stale data and
      // the user still has to hit refresh.
      const synced = await syncNewMailForTenant(env.TENANT_ID).catch((error) => {
        console.error(
          "[webhook] sync failed:",
          error instanceof Error ? error.message : error,
        );
        return -1;
      });
      console.log("[webhook] synced", synced, "msgs -> notify", env.TENANT_ID);
      notifyTenant(env.TENANT_ID);
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
