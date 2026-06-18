import { describe, expect, it } from "vitest";

import {
  accountCap,
  FREE_ACCOUNT_LIMIT,
  shouldApplyStatus,
} from "@/server/lib/billing-policy";

// Razorpay created_at is epoch SECONDS; same-second events share an instant.
const at = (sec: number) => new Date(sec * 1000);

describe("shouldApplyStatus (webhook event ordering)", () => {
  it("applies the first event for a subscription (no prior event)", () => {
    expect(
      shouldApplyStatus({
        newStatus: "active",
        lastEventAt: null,
        eventAt: at(100),
      }),
    ).toBe(true);
    expect(
      shouldApplyStatus({
        newStatus: "cancelled",
        lastEventAt: null,
        eventAt: at(100),
      }),
    ).toBe(true);
    // No event time at all → unconditional (idempotent retries handled upstream).
    expect(
      shouldApplyStatus({
        newStatus: "active",
        lastEventAt: at(100),
        eventAt: null,
      }),
    ).toBe(true);
  });

  it("applies a strictly newer event of any status", () => {
    expect(
      shouldApplyStatus({
        newStatus: "active",
        lastEventAt: at(100),
        eventAt: at(200),
      }),
    ).toBe(true);
    expect(
      shouldApplyStatus({
        newStatus: "cancelled",
        lastEventAt: at(100),
        eventAt: at(200),
      }),
    ).toBe(true);
  });

  it("does NOT revive on a same-second Pro-granting event (cancelled@T then charged@T)", () => {
    // cancelled@T is recorded; a same-second charged@T must not flip back to active.
    expect(
      shouldApplyStatus({
        newStatus: "active",
        lastEventAt: at(100),
        eventAt: at(100),
      }),
    ).toBe(false);
    expect(
      shouldApplyStatus({
        newStatus: "authenticated",
        lastEventAt: at(100),
        eventAt: at(100),
      }),
    ).toBe(false);
  });

  it("lets a cancellation win a same-second tie (charged@T then cancelled@T)", () => {
    // charged@T is recorded; a same-second cancelled@T must still cancel.
    expect(
      shouldApplyStatus({
        newStatus: "cancelled",
        lastEventAt: at(100),
        eventAt: at(100),
      }),
    ).toBe(true);
    expect(
      shouldApplyStatus({
        newStatus: "expired",
        lastEventAt: at(100),
        eventAt: at(100),
      }),
    ).toBe(true);
  });

  it("ignores a stale (older) event regardless of status", () => {
    expect(
      shouldApplyStatus({
        newStatus: "active",
        lastEventAt: at(200),
        eventAt: at(100),
      }),
    ).toBe(false);
    expect(
      shouldApplyStatus({
        newStatus: "cancelled",
        lastEventAt: at(200),
        eventAt: at(100),
      }),
    ).toBe(false);
  });
});

describe("accountCap (multi-account entitlement)", () => {
  it("caps a free session at the primary account only", () => {
    expect(accountCap({ pro: false, max: 6 })).toBe(FREE_ACCOUNT_LIMIT);
    expect(accountCap({ pro: false, max: 6 })).toBe(1);
  });

  it("unlocks the full fan-out for Pro", () => {
    expect(accountCap({ pro: true, max: 6 })).toBe(6);
  });

  it("tracks the max it's given (so the cap follows MAX_ACCOUNTS)", () => {
    expect(accountCap({ pro: true, max: 3 })).toBe(3);
    expect(accountCap({ pro: false, max: 3 })).toBe(1);
  });
});
