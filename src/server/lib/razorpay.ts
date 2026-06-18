import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";

/**
 * Razorpay subscription helpers — API calls + signature verification. Everything
 * is gated on `razorpayConfigured()`: with the keys unset the Pro flow is inert
 * (the app still builds, deploys and runs), and it activates the moment the four
 * RAZORPAY_* env vars are present. No secret ever lives in code.
 */

const API = "https://api.razorpay.com/v1";
// Razorpay requires a finite billing-cycle count for a subscription; this keeps
// a monthly plan running for 10 years. The user can cancel any time.
const TOTAL_COUNT = 120;

/** True only when every credential needed to charge is set. */
export function razorpayConfigured(): boolean {
  return Boolean(
    env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_PLAN_ID,
  );
}

function authHeader(): string {
  const basic = Buffer.from(
    `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`,
  ).toString("base64");
  return `Basic ${basic}`;
}

/** Create a monthly subscription against the configured plan; returns its id. */
export async function createRazorpaySubscription(
  notifyEmail?: string,
): Promise<string> {
  const res = await fetch(`${API}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      plan_id: env.RAZORPAY_PLAN_ID,
      total_count: TOTAL_COUNT,
      customer_notify: 1,
      ...(notifyEmail ? { notes: { email: notifyEmail } } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { description?: string };
  };
  if (!res.ok || !data.id) {
    throw new Error(data.error?.description ?? "Could not create subscription.");
  }
  return data.id;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify the Checkout callback for a subscription:
 * HMAC_SHA256(payment_id + "|" + subscription_id, key_secret) === signature.
 */
export function verifySubscriptionPayment(
  paymentId: string,
  subscriptionId: string,
  signature: string,
  secret: string | undefined = env.RAZORPAY_KEY_SECRET,
): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
  return safeEqualHex(signature, expected);
}

/** Verify a webhook body against the webhook secret (fails closed when unset). */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string | undefined = env.RAZORPAY_WEBHOOK_SECRET,
): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return safeEqualHex(signature, expected);
}
