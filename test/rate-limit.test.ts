import { describe, expect, it } from "vitest";

import { clientIp, rateLimit } from "@/server/lib/rate-limit";

// With REDIS_URL unset (the test env), rateLimit uses the in-process window.
describe("rateLimit (in-process)", () => {
  it("allows up to the limit then blocks", async () => {
    const key = `t1-${Math.random()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(key, 3, 60_000));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]!.retryAfterMs).toBeGreaterThan(0);
  });

  it("counts each key independently", async () => {
    const a = await rateLimit(`a-${Math.random()}`, 1, 60_000);
    const b = await rateLimit(`b-${Math.random()}`, 1, 60_000);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("resets once the window elapses", async () => {
    const key = `t2-${Math.random()}`;
    expect((await rateLimit(key, 1, 1)).ok).toBe(true);
    expect((await rateLimit(key, 1, 1)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect((await rateLimit(key, 1, 1)).ok).toBe(true);
  });

  it("reports remaining budget", async () => {
    const key = `t3-${Math.random()}`;
    expect((await rateLimit(key, 5, 60_000)).remaining).toBe(4);
    expect((await rateLimit(key, 5, 60_000)).remaining).toBe(3);
  });
});

describe("clientIp", () => {
  it("trusts the LAST x-forwarded-for hop (the one our proxy appended)", () => {
    // The client can prepend anything; only the last entry is proxy-set, so a
    // spoofed first hop must not become the rate-limit key.
    const h = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" });
    expect(clientIp(h)).toBe("2.2.2.2");
  });
  it("handles a single forwarded value and stray whitespace", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "  3.3.3.3  " }))).toBe("3.3.3.3");
  });
  it("falls back to x-real-ip, then a local key", () => {
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("local");
  });
});
