import { describe, expect, it, vi } from "vitest";

import {
  forEachAccount,
  mapLimit,
  MAX_ACCOUNTS,
  requireExplicitAccount,
} from "@/server/lib/concurrency";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  it("maps every item and preserves INPUT order, not completion order", async () => {
    const items = [10, 20, 30, 40];
    // Earlier items resolve later, proving order comes from the index, not timing.
    const out = await mapLimit(items, 2, async (n, i) => {
      await tick((items.length - i) * 4);
      return n + i;
    });
    expect(out).toEqual([10, 21, 32, 43]);
  });

  it("passes the item index to fn", async () => {
    const out = await mapLimit(["a", "b", "c"], 3, async (s, i) => `${s}${i}`);
    expect(out).toEqual(["a0", "b1", "c2"]);
  });

  it("never runs more than `limit` tasks concurrently", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 8 }, (_, i) => i),
      3,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(5);
        active -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(3); // honours the cap
    expect(peak).toBeGreaterThan(1); // but does parallelize up to it
  });

  it("returns [] for no items and never calls fn", async () => {
    const fn = vi.fn(async (n: number) => n);
    expect(await mapLimit([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects the whole call when fn throws (its documented contract)", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("forEachAccount", () => {
  it("runs fn for every item, sequentially in order", async () => {
    const seen: number[] = [];
    await forEachAccount([1, 2, 3], async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("ISOLATES a failing item: the others still run and it never rejects", async () => {
    const seen: number[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The core resilience guarantee — one revoked/expired mailbox must not
    // abort sync for the rest.
    await expect(
      forEachAccount([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("account 2 revoked");
        seen.push(n);
      }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([1, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("keeps going when EVERY item fails (still resolves, logs each)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      forEachAccount([1, 2], async () => {
        throw new Error("down");
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("is a no-op for an empty list", async () => {
    const fn = vi.fn(async () => undefined);
    await forEachAccount([], fn);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("MAX_ACCOUNTS", () => {
  it("bounds fan-out width to a sane cap", () => {
    expect(MAX_ACCOUNTS).toBe(6);
  });
});

describe("requireExplicitAccount (destructive-write guard)", () => {
  it("refuses an omitted account ONLY when the user is multi-account", () => {
    expect(requireExplicitAccount(undefined, true, 3)).toBe(true);
    expect(requireExplicitAccount(undefined, true, 2)).toBe(true);
  });

  it("lets a single-account session fall back to its one mailbox", () => {
    expect(requireExplicitAccount(undefined, true, 1)).toBe(false);
    expect(requireExplicitAccount(undefined, true, 0)).toBe(false);
  });

  it("never trips when an explicit account is given", () => {
    expect(requireExplicitAccount("acc-1", true, 5)).toBe(false);
  });

  it("never trips for non-guarded ops (reads, new-compose)", () => {
    expect(requireExplicitAccount(undefined, false, 5)).toBe(false);
    expect(requireExplicitAccount("acc-1", false, 5)).toBe(false);
  });
});
