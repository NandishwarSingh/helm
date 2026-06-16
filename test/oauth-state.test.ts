import { describe, expect, it } from "vitest";

import { signState, verifyState } from "@/server/lib/oauth-state";

const NOW = 1_700_000_000_000;

describe("oauth state token", () => {
  it("round-trips a tenant id", () => {
    const state = signState("tenant-abc", NOW);
    expect(verifyState(state, NOW)).toBe("tenant-abc");
  });

  it("rejects a tampered signature", () => {
    const state = signState("tenant-abc", NOW);
    const forged = state.slice(0, -2) + (state.endsWith("aa") ? "bb" : "aa");
    expect(verifyState(forged, NOW)).toBeNull();
  });

  it("rejects a swapped payload (signature won't match)", () => {
    const a = signState("tenant-a", NOW);
    const b = signState("tenant-b", NOW);
    const spliced = a.split(".")[0] + "." + b.split(".")[1];
    expect(verifyState(spliced, NOW)).toBeNull();
  });

  it("rejects an expired token (older than 10 minutes)", () => {
    const state = signState("tenant-abc", NOW);
    expect(verifyState(state, NOW + 11 * 60 * 1000)).toBeNull();
    expect(verifyState(state, NOW + 9 * 60 * 1000)).toBe("tenant-abc");
  });

  it("rejects malformed input", () => {
    expect(verifyState("", NOW)).toBeNull();
    expect(verifyState("nodot", NOW)).toBeNull();
    expect(verifyState(".onlyдsig", NOW)).toBeNull();
  });
});
