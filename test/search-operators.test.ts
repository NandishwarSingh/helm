import { describe, expect, it } from "vitest";

import {
  buildFilters,
  hasFilters,
  matchesFlags,
  matchesOperators,
  parseQuery,
  queryChips,
  tieredBoost,
} from "@/lib/search-operators";

describe("parseQuery", () => {
  it("parses field operators, a quoted value, a flag, and free text", () => {
    expect(parseQuery('from:alice subject:"q3 invoice" is:unread budget')).toEqual({
      from: "alice",
      subject: "q3 invoice",
      isUnread: true,
      text: "budget",
    });
  });

  it("parses to: and is:starred", () => {
    expect(parseQuery("to:bob@x.com is:starred")).toEqual({
      to: "bob@x.com",
      isStarred: true,
    });
  });

  it("maps is:unstarred / is:read to their booleans", () => {
    expect(parseQuery("is:unstarred")).toEqual({ isStarred: false });
    expect(parseQuery("is:read")).toEqual({ isRead: true });
  });

  it("treats a bare query as free text", () => {
    expect(parseQuery("project deadline")).toEqual({ text: "project deadline" });
  });

  it("returns an empty object for blank input", () => {
    expect(parseQuery("   ")).toEqual({});
  });
});

describe("buildFilters", () => {
  it("ANDs field operators in a single filter", () => {
    expect(buildFilters({ from: "alice", subject: "invoice" })).toEqual([
      { from: { contains: "alice" }, subject: { contains: "invoice" } },
    ]);
  });

  it("fans free text across fields, ANDing operators and never overwriting them", () => {
    expect(buildFilters({ from: "alice", text: "budget" })).toEqual([
      { from: { contains: "alice" }, subject: { contains: "budget" } },
      { from: { contains: "alice" }, snippet: { contains: "budget" } },
    ]);
  });

  it("searches subject/snippet/from for plain free text", () => {
    expect(buildFilters({ text: "budget" })).toEqual([
      { subject: { contains: "budget" } },
      { snippet: { contains: "budget" } },
      { from: { contains: "budget" } },
    ]);
  });

  it("returns no filters when only flags are present", () => {
    expect(buildFilters({ isUnread: true })).toEqual([]);
  });
});

describe("matchesFlags", () => {
  it("filters by unread/read/starred state", () => {
    expect(matchesFlags({ unread: true, starred: false }, { isUnread: true })).toBe(true);
    expect(matchesFlags({ unread: false, starred: false }, { isUnread: true })).toBe(false);
    expect(matchesFlags({ unread: false, starred: false }, { isRead: true })).toBe(true);
    expect(matchesFlags({ unread: false, starred: true }, { isStarred: true })).toBe(true);
    expect(matchesFlags({ unread: false, starred: true }, { isStarred: false })).toBe(false);
  });

  it("passes everything when no flags are set", () => {
    expect(matchesFlags({ unread: true, starred: true }, { text: "x" })).toBe(true);
  });
});

describe("hasFilters / queryChips", () => {
  it("hasFilters is false only for an empty parse", () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ isUnread: true })).toBe(true);
    expect(hasFilters({ text: "x" })).toBe(true);
  });

  it("queryChips renders one chip per operator", () => {
    expect(queryChips({ from: "alice", isUnread: true, text: "budget" })).toEqual([
      { key: "from", label: "from: alice" },
      { key: "unread", label: "unread" },
      { key: "text", label: "“budget”" },
    ]);
  });
});

describe("tieredBoost (adaptive keyword boost over semantic score)", () => {
  const m = (subject: string, snippet = "", from = "") => ({ subject, snippet, from });
  it("strong lift for an exact phrase in the subject", () => {
    expect(tieredBoost("project deadline", m("Project Deadline reminder"))).toBeCloseTo(0.35);
  });
  it("medium lift when every term is present but not as a phrase", () => {
    expect(tieredBoost("budget report", m("Q3 budget", "the report is attached"))).toBeCloseTo(0.2);
  });
  it("scaled lift for partial overlap (>= 0.6)", () => {
    expect(tieredBoost("alpha beta gamma", m("alpha beta"))).toBeCloseTo(0.2 * (2 / 3));
  });
  it("zero for weak overlap (paraphrase/conceptual) or empty text", () => {
    expect(tieredBoost("nothing here", m("unrelated", "different", "x"))).toBe(0);
    expect(tieredBoost("", m("anything"))).toBe(0);
  });
});

describe("matchesOperators", () => {
  it("requires each from/to/subject value to be contained (case-insensitive)", () => {
    const msg = { from: "alice@x.com", to: "bob@y.com", subject: "Invoice 12" };
    expect(matchesOperators(msg, { from: "alice" })).toBe(true);
    expect(matchesOperators(msg, { from: "carol" })).toBe(false);
    expect(matchesOperators(msg, { subject: "invoice" })).toBe(true);
    expect(matchesOperators(msg, {})).toBe(true);
  });
});
