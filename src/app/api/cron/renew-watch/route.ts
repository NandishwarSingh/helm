import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import {
  allCalendarWatchTenants,
  armCalendarWatch,
} from "@/server/lib/calendar-watch";
import {
  allWatchTenants,
  armGmailWatch,
  getGmailEmail,
  rememberGmailTenant,
} from "@/server/lib/gmail-watch";

export const maxDuration = 60;

function authorized(request: NextRequest): boolean {
  const expected = env.WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = request.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Re-arms every connected tenant's Gmail watch so push notifications keep
 * flowing. Google caps a Gmail watch at ~7 days, so a cron on the box calls this
 * every few days. The token refresh + users.watch call lives in gmail-watch
 * (armGmailWatch); here we just fan out across all mapped tenants plus the
 * pinned TENANT_ID (covers the original single-tenant deploy, whose address may
 * predate the email map). Re-arming only touches the watch, never the Pub/Sub
 * push subscription, so the endpoint's `?secret=` stays intact. Protected by the
 * same shared secret as the webhook (via `x-cron-secret`).
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const tenants = await allWatchTenants();
  if (!tenants.includes(env.TENANT_ID)) tenants.push(env.TENANT_ID);

  const results = await Promise.all(
    tenants.map(async (tenantId) => {
      // Self-heal the email->tenant map for tenants that connected before it
      // existed (no callback row), so their pushes route precisely instead of
      // riding the TENANT_ID fallback.
      const email = await getGmailEmail(tenantId);
      if (email) await rememberGmailTenant(tenantId, email);
      return { tenantId, expiration: await armGmailWatch(tenantId) };
    }),
  );
  const renewed = results.filter((r) => r.expiration !== null).length;
  console.log(`[renew-watch] re-armed ${renewed}/${tenants.length} watch(es)`);

  // Calendar push channels also expire — re-arm every tenant that has a calendar
  // channel, unioned with the gmail-watch set (self-heals a missing channel).
  const calTenants = [
    ...new Set([...tenants, ...(await allCalendarWatchTenants())]),
  ];
  const calRenewed = (
    await Promise.all(calTenants.map((t) => armCalendarWatch(t)))
  ).filter((e) => e !== null).length;
  console.log(`[renew-watch] re-armed ${calRenewed} calendar channel(s)`);

  // A partial failure (a tenant whose token expired/was revoked) isn't a server
  // error — report counts and let the next run retry the laggards.
  return NextResponse.json({
    ok: renewed === tenants.length,
    renewed,
    total: tenants.length,
    calendarRenewed: calRenewed,
  });
}
