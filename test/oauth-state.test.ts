import { describe, expect, it } from "vitest";

import { signState, verifyState } from "@/server/lib/oauth-state";

const NOW = 1_700_000_000_000;

describe("oauth state token", () => {
  it("round-trips a connect", () => {
    const state = signState({ tenantId: "tenant-abc", intent: "connect" }, NOW);
    expect(verifyState(state, NOW)).toEqual({
      tenantId: "tenant-abc",
      intent: "connect",
    });
  });

  it("round-trips an add bound to the initiating session", () => {
    const state = signState(
      { tenantId: "new-tenant", intent: "add", ownerKind: "user", ownerId: "user-1" },
      NOW,
    );
    expect(verifyState(state, NOW)).toEqual({
      tenantId: "new-tenant",
      intent: "add",
      ownerKind: "user",
      ownerId: "user-1",
    });
  });

  it("rejects a tampered signature", () => {
    const state = signState({ tenantId: "tenant-abc", intent: "connect" }, NOW);
    const forged = state.slice(0, -2) + (state.endsWith("aa") ? "bb" : "aa");
    expect(verifyState(forged, NOW)).toBeNull();
  });

  it("rejects a swapped payload (signature won't match)", () => {
    const a = signState({ tenantId: "tenant-a", intent: "connect" }, NOW);
    const b = signState({ tenantId: "tenant-b", intent: "connect" }, NOW);
    const spliced = a.split(".")[0] + "." + b.split(".")[1];
    expect(verifyState(spliced, NOW)).toBeNull();
  });

  it("rejects an expired token (older than 10 minutes)", () => {
    const state = signState({ tenantId: "tenant-abc", intent: "connect" }, NOW);
    expect(verifyState(state, NOW + 11 * 60 * 1000)).toBeNull();
    expect(verifyState(state, NOW + 9 * 60 * 1000)).toEqual({
      tenantId: "tenant-abc",
      intent: "connect",
    });
  });

  it("rejects malformed input", () => {
    expect(verifyState("", NOW)).toBeNull();
    expect(verifyState("nodot", NOW)).toBeNull();
    expect(verifyState(".onlysig", NOW)).toBeNull();
  });
});
