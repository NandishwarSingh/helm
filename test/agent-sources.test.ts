import { describe, expect, it } from "vitest";

import { createSourceRegistry } from "@/server/lib/agent-sources";

const accounts = [
  { accountId: "acc-a", email: "a@x.com" },
  { accountId: "acc-b", email: "b@x.com" },
];

describe("createSourceRegistry — harvest + resolve", () => {
  it("cites a flat inbox list of emails", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([
      { id: "m1", from: "x@y.com", subject: "Hi", account: "a@x.com" },
      { id: "m2", from: "z@y.com", subject: "Yo", account: "a@x.com" },
    ]);
    const out = reg.resolve();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: "email",
      id: "m1",
      title: "Hi",
      account: "a@x.com",
      accountId: "acc-a",
      from: "x@y.com",
    });
  });

  it("does NOT over-cite a thread's nested child messages (M3)", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([
      {
        id: "t1",
        subject: "Thread",
        from: "x@y.com",
        messages: [
          { id: "c1", subject: "child1", from: "p@q.com" },
          { id: "c2", subject: "child2", from: "p@q.com" },
        ],
      },
    ]);
    expect(reg.resolve().map((s) => s.id)).toEqual(["t1"]);
  });

  it("descends a wrapper object's array fields", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest({ inbox: [{ id: "m1", subject: "Hi", from: "x@y.com" }] });
    expect(reg.resolve().map((s) => s.id)).toEqual(["m1"]);
  });

  it("never echoes an unconnected (spoofed) account — shows '' (M5)", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([
      { id: "m1", subject: "Hi", from: "x@y.com", account: "security@evil.com" },
    ]);
    expect(reg.resolve()[0]?.account).toBe("");
  });

  it("does not collide distinct same-id messages from different accounts (M4)", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([
      { id: "same", subject: "From A", from: "x@y.com", account: "a@x.com" },
      { id: "same", subject: "From B", from: "z@y.com", account: "b@x.com" },
    ]);
    const out = reg.resolve();
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.account).sort()).toEqual(["a@x.com", "b@x.com"]);
  });

  it("classifies a summarized email (summary+from, no subject) as email, keeps from (M11)", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([{ id: "m1", summary: "A note", from: "x@y.com" }]);
    expect(reg.resolve()[0]).toMatchObject({ kind: "email", from: "x@y.com" });
  });

  it("classifies an event (summary+start, no from) as event with no from", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([
      { id: "e1", summary: "Standup", start: "2026-06-18T09:00:00+05:30" },
    ]);
    expect(reg.resolve()[0]).toMatchObject({
      kind: "event",
      from: undefined,
      date: "2026-06-18T09:00:00+05:30",
    });
  });

  it("derives a date from a numeric ts (fan-out shape)", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([
      { account: "a@x.com", id: "m1", from: "x@y.com", subject: "Hi", ts: 1700000000000 },
    ]);
    expect(reg.resolve()[0]?.date).toBe(new Date(1700000000000).toISOString());
  });

  it("ignores shapeless objects (no id, or no title)", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest([{ id: "x" }, { subject: "no id" }, { foo: "bar" }]);
    expect(reg.resolve()).toHaveLength(0);
  });

  it("caps the list at 8", () => {
    const reg = createSourceRegistry(accounts, "acc-a");
    reg.harvest(
      Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        subject: `S${i}`,
        from: "x@y.com",
      })),
    );
    expect(reg.resolve()).toHaveLength(8);
  });
});
