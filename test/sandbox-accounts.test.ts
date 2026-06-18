import { describe, expect, it } from "vitest";

import {
  resolveAccountTarget,
  type AccountBridge,
} from "@/server/lib/sandbox-accounts";

// Distinct client objects stand in for tenant-scoped Corsair clients; the gate
// only ever decides WHICH one a script may reach via corsair.account("email").
const clientA = { tag: "A" };
const clientB = { tag: "B" };
const active = { tag: "active" };
const accounts: AccountBridge[] = [
  { email: "a@x.com", client: clientA },
  { email: "b@x.com", client: clientB },
];

describe("resolveAccountTarget (run_script account ownership gate)", () => {
  it("resolves an empty email to the active account", () => {
    expect(resolveAccountTarget(accounts, active, "")).toEqual({
      ok: true,
      client: active,
    });
  });

  it("resolves a connected email to that account's own client", () => {
    expect(resolveAccountTarget(accounts, active, "b@x.com")).toEqual({
      ok: true,
      client: clientB,
    });
  });

  it("fails closed on a foreign email (not one of the session's accounts)", () => {
    const r = resolveAccountTarget(accounts, active, "attacker@evil.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not one of your connected accounts/);
  });

  it("fails closed when the session has no connected accounts", () => {
    expect(resolveAccountTarget([], active, "a@x.com").ok).toBe(false);
  });

  it("matches exactly — no case/whitespace normalization that could widen reach", () => {
    expect(resolveAccountTarget(accounts, active, "A@x.com").ok).toBe(false);
    expect(resolveAccountTarget(accounts, active, " a@x.com").ok).toBe(false);
  });
});
