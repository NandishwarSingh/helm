import { describe, expect, it, vi } from "vitest";

import { createCallGuard } from "@/server/lib/agent-guard";

const WRITE_TOOLS = new Set(["createDraft", "sendEmail"]);
const newGuard = () => createCallGuard({ readBudget: 3, writeTools: WRITE_TOOLS });

describe("createCallGuard", () => {
  it("runs a tool and returns its result", async () => {
    const guard = newGuard();
    const fn = vi.fn(async (n: number) => ({ doubled: n * 2 }));
    expect(await guard("listRecentMail", 5, fn)).toEqual({ doubled: 10 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("memoizes an identical call instead of re-running it", async () => {
    const guard = newGuard();
    const fn = vi.fn(async () => ({ ok: true }));
    await guard("searchMail", { q: "x" }, fn);
    const second = await guard("searchMail", { q: "x" }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ repeatedCall: true });
  });

  it("enforces the read budget per tool", async () => {
    const guard = newGuard();
    const fn = vi.fn(async (i: number) => i);
    // Distinct args dodge the memo, so only the budget stops the fishing.
    for (let i = 0; i < 3; i++) expect(await guard("searchMail", i, fn)).toBe(i);
    const blocked = await guard("searchMail", 99, fn);
    expect(blocked).toMatchObject({ error: expect.stringContaining("already called") });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not budget-limit write tools", async () => {
    const guard = newGuard();
    const fn = vi.fn(async (i: number) => ({ id: i }));
    for (let i = 0; i < 6; i++) {
      expect(await guard("createDraft", i, fn)).toEqual({ id: i });
    }
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it("refuses a second write with the same recipient+subject signature", async () => {
    const guard = newGuard();
    const create = vi.fn(async () => ({ drafted: true, id: "d1" }));
    const sig = (i: { to: string; subject: string; body: string }) =>
      `createDraft:${i.to}:${i.subject}`;

    const first = await guard(
      "createDraft",
      { to: "a@b.com", subject: "Hi", body: "first version" },
      create,
      sig,
    );
    // Same recipient + subject, DIFFERENT body — the exact-arg memo misses,
    // but the signature catches it.
    const second = await guard(
      "createDraft",
      { to: "a@b.com", subject: "Hi", body: "reworded version" },
      create,
      sig,
    );

    expect(first).toEqual({ drafted: true, id: "d1" });
    expect(second).toMatchObject({ repeatedCall: true });
    expect((second as { previousResult: unknown }).previousResult).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("allows different recipients through", async () => {
    const guard = newGuard();
    const create = vi.fn(async () => ({ drafted: true }));
    const sig = (i: { to: string; subject: string }) => `createDraft:${i.to}:${i.subject}`;
    await guard("createDraft", { to: "a@b.com", subject: "Hi" }, create, sig);
    await guard("createDraft", { to: "c@d.com", subject: "Hi" }, create, sig);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("captures a thrown error as a compact result and memoizes it", async () => {
    const guard = newGuard();
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const out = await guard("readEmail", { id: "1" }, fn);
    expect(out).toMatchObject({ error: "boom" });
    await guard("readEmail", { id: "1" }, fn);
    expect(fn).toHaveBeenCalledTimes(1); // memoized, not retried
  });
});
