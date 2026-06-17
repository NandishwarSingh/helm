import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import { corsair } from "@/server/corsair";

export const maxDuration = 30;

// The Pub/Sub topic the Gmail watch publishes to. Stable per deploy; override
// with GMAIL_PUBSUB_TOPIC if the Google Cloud project ever changes.
const GMAIL_TOPIC =
  process.env.GMAIL_PUBSUB_TOPIC ?? "projects/helm-499111/topics/helm-gmail";

function authorized(request: NextRequest): boolean {
  const expected = env.WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = request.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Re-arms the Gmail watch so push notifications keep flowing. Google caps a
 * Gmail watch at ~7 days, so a cron on the box calls this every few days. Corsair
 * doesn't expose `users.watch` as a typed operation, so we get a fresh access
 * token through it (a cheap api.list call forces a refresh + persist) and call
 * Gmail's watch endpoint directly. This only re-arms the watch — it never touches
 * the Pub/Sub push subscription, so the endpoint's `?secret=` stays intact.
 * Protected by the same shared secret as the webhook (via `x-cron-secret`).
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const tenant = corsair.withTenant(env.TENANT_ID);
    // A cheap call forces Corsair to refresh + persist a fresh access token.
    await tenant.gmail.api.messages.list({ maxResults: 1 });
    const token = await tenant.gmail.keys.get_access_token();

    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topicName: GMAIL_TOPIC, labelIds: ["INBOX"] }),
      },
    );
    const data = (await res.json()) as {
      historyId?: string;
      expiration?: string;
    };
    if (!res.ok) {
      console.error("[renew-watch] users.watch failed:", res.status);
      return NextResponse.json({ ok: false, status: res.status }, { status: 502 });
    }
    const expires = data.expiration
      ? new Date(Number(data.expiration)).toISOString()
      : null;
    console.log("[renew-watch] Gmail watch re-armed; expires", expires);
    return NextResponse.json({ ok: true, expiration: data.expiration, expires });
  } catch (error) {
    console.error(
      "[renew-watch] failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
