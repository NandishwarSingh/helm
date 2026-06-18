import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  verifySubscriptionPayment,
  verifyWebhookSignature,
} from "@/server/lib/razorpay";

const hmac = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("verifyWebhookSignature (Razorpay webhook, fails closed)", () => {
  const secret = "whsec_test_123";
  const body = JSON.stringify({ event: "subscription.charged", created_at: 1 });

  it("accepts a body correctly signed with the webhook secret", () => {
    expect(verifyWebhookSignature(body, hmac(body, secret), secret)).toBe(true);
  });

  it("rejects a wrong-secret signature or a tampered body", () => {
    expect(verifyWebhookSignature(body, hmac(body, "other"), secret)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, hmac(body, secret), secret)).toBe(
      false,
    );
  });

  it("fails closed when the webhook secret is unset", () => {
    // Explicit empty, and the env-backed default (RAZORPAY_WEBHOOK_SECRET is
    // not set under test) — both must refuse rather than accept anything.
    expect(verifyWebhookSignature(body, hmac(body, secret), "")).toBe(false);
    expect(verifyWebhookSignature(body, hmac(body, secret), undefined)).toBe(
      false,
    );
  });

  it("rejects a malformed/empty signature without throwing", () => {
    expect(verifyWebhookSignature(body, "not-a-real-signature", secret)).toBe(
      false,
    );
    expect(verifyWebhookSignature(body, "", secret)).toBe(false);
  });
});

describe("verifySubscriptionPayment (Checkout callback)", () => {
  const secret = "key_secret_test";
  const paymentId = "pay_123";
  const subId = "sub_456";
  const sig = hmac(`${paymentId}|${subId}`, secret);

  it("accepts a signature over payment_id|subscription_id", () => {
    expect(verifySubscriptionPayment(paymentId, subId, sig, secret)).toBe(true);
  });

  it("rejects when the subscription id is swapped under a stolen signature", () => {
    expect(verifySubscriptionPayment(paymentId, "sub_OTHER", sig, secret)).toBe(
      false,
    );
  });

  it("fails closed when the key secret is unset", () => {
    expect(verifySubscriptionPayment(paymentId, subId, sig, "")).toBe(false);
  });
});
