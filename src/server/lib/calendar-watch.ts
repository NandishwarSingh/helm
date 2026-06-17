import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { env } from "@/env";
import { db } from "@/server/db";
import { calendarWatch } from "@/server/db/schema";
import { freshAccessToken } from "@/server/lib/gmail-watch";

/**
 * Google Calendar push channels (events.watch). Unlike Gmail's Pub/Sub watch, a
 * Calendar push carries no body — only an X-Goog-Channel-Id header — so we keep
 * a channel -> tenant map to route + notify. A channel expires (Google caps it),
 * so the renewal cron re-arms it and teardown stops it. The combined Google
 * consent means the Gmail access token already carries calendar scope, so we
 * reuse it rather than minting a second one.
 */
const WATCH_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch";
const STOP_URL = "https://www.googleapis.com/calendar/v3/channels/stop";

function webhookAddress(): string {
  // The push lands on /api/webhooks; the ?secret authenticates it (the same
  // shared secret the handler checks), and the channel token is a second guard.
  const secret = env.WEBHOOK_SECRET ?? "";
  return `${env.NEXT_PUBLIC_SITE_URL}/api/webhooks?secret=${encodeURIComponent(secret)}`;
}

/** Stop one channel with Google (best-effort), then forget it. */
async function stopChannel(
  token: string,
  channelId: string,
  resourceId: string | null,
): Promise<void> {
  if (!resourceId) return;
  try {
    await fetch(STOP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  } catch {
    /* a stale channel that won't stop just expires on its own */
  }
}

/** (Re)arm the Calendar watch for a tenant: stop any old channel, open one new. */
export async function armCalendarWatch(
  tenantId: string,
): Promise<number | null> {
  // Without a shared secret we can't authenticate the push that comes back.
  if (!env.WEBHOOK_SECRET) return null;
  try {
    const token = await freshAccessToken(tenantId);

    // Replace any existing channel so we never accumulate duplicates.
    const existing = await db
      .select()
      .from(calendarWatch)
      .where(eq(calendarWatch.tenantId, tenantId));
    for (const row of existing) {
      await stopChannel(token, row.channelId, row.resourceId);
    }
    if (existing.length > 0) {
      await db.delete(calendarWatch).where(eq(calendarWatch.tenantId, tenantId));
    }

    const channelId = randomUUID();
    const res = await fetch(WATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookAddress(),
        token: env.WEBHOOK_SECRET,
      }),
    });
    if (!res.ok) {
      console.error("[calendar-watch] arm failed:", res.status);
      return null;
    }
    const data = (await res.json()) as {
      resourceId?: string;
      expiration?: string;
    };
    await db.insert(calendarWatch).values({
      channelId,
      tenantId,
      resourceId: data.resourceId ?? null,
      expiration: data.expiration ?? null,
    });
    return data.expiration ? Number(data.expiration) : null;
  } catch (error) {
    console.error(
      "[calendar-watch] arm error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** The tenant that owns a calendar push channel (for webhook routing). */
export async function calendarTenantForChannel(
  channelId: string,
): Promise<string | null> {
  const rows = await db
    .select({ tenantId: calendarWatch.tenantId })
    .from(calendarWatch)
    .where(eq(calendarWatch.channelId, channelId))
    .limit(1);
  return rows[0]?.tenantId ?? null;
}

/** Every tenant with a registered calendar channel (for the renewal cron). */
export async function allCalendarWatchTenants(): Promise<string[]> {
  const rows = await db
    .select({ tenantId: calendarWatch.tenantId })
    .from(calendarWatch);
  return [...new Set(rows.map((r) => r.tenantId))];
}

/** Stop + forget every channel for a tenant (account teardown). */
export async function stopCalendarWatch(tenantId: string): Promise<void> {
  const rows = await db
    .select()
    .from(calendarWatch)
    .where(eq(calendarWatch.tenantId, tenantId));
  if (rows.length === 0) return;
  try {
    const token = await freshAccessToken(tenantId);
    for (const row of rows) {
      await stopChannel(token, row.channelId, row.resourceId);
    }
  } catch {
    /* token gone — the channels will expire on their own */
  }
  await db.delete(calendarWatch).where(eq(calendarWatch.tenantId, tenantId));
}
