import { type NextRequest, NextResponse } from "next/server";

import { setStatusByRazorpayId } from "@/server/lib/billing";
import { verifyWebhookSignature } from "@/server/lib/razorpay";

/**
 * Razorpay subscription webhook — the source of truth for ongoing status
 * (activation, renewals, cancellation, dunning). Verifies the signature against
 * RAZORPAY_WEBHOOK_SECRET (fails closed when unset) and maps the event to our
 * stored status. Configure it at Razorpay → Settings → Webhooks pointing here,
 * with the subscription.* events enabled.
 */

// Razorpay subscription event → the status we persist.
const EVENT_STATUS: Record<string, string> = {
  "subscription.authenticated": "authenticated",
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.completed": "completed",
  "subscription.cancelled": "cancelled",
  "subscription.halted": "halted",
  "subscription.paused": "paused",
  "subscription.pending": "pending",
  "subscription.resumed": "active",
};

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: {
    event?: string;
    payload?: {
      subscription?: { entity?: { id?: string; current_end?: number } };
    };
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad payload." }, { status: 400 });
  }

  const status = EVENT_STATUS[body.event ?? ""];
  const sub = body.payload?.subscription?.entity;
  if (sub?.id && status) {
    // Razorpay timestamps are epoch seconds.
    const currentEnd = sub.current_end
      ? new Date(sub.current_end * 1000)
      : undefined;
    await setStatusByRazorpayId(sub.id, status, currentEnd);
  }
  // Always ack a verified webhook so Razorpay doesn't retry a handled event.
  return NextResponse.json({ ok: true });
}
