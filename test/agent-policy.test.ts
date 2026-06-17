import { describe, expect, it } from "vitest";

import {
  DESTRUCTIVE_BUDGET,
  isAffirmation,
  isAllowedPath,
  isDestructive,
} from "@/server/lib/agent-policy";

describe("isAllowedPath (run_script allowlist)", () => {
  it("allows gmail/googlecalendar api + db operations", () => {
    expect(isAllowedPath("gmail.api.messages.list")).toBe(true);
    expect(isAllowedPath("gmail.db.messages.search")).toBe(true);
    expect(isAllowedPath("googlecalendar.api.events.getMany")).toBe(true);
    expect(isAllowedPath("googlecalendar.db.events.list")).toBe(true);
  });

  it("rejects host escapes and any non-allowlisted surface", () => {
    expect(isAllowedPath("process.env")).toBe(false);
    expect(isAllowedPath("gmail.keys.get_access_token")).toBe(false);
    expect(isAllowedPath("gmail.api")).toBe(false); // no leaf
    expect(isAllowedPath("slack.api.messages.send")).toBe(false);
    expect(isAllowedPath("constructor.constructor")).toBe(false);
    expect(isAllowedPath("gmail.api.messages.list; fetch('x')")).toBe(false);
    expect(isAllowedPath("")).toBe(false);
  });
});

describe("isDestructive (confirmation-gated operations)", () => {
  it("flags every outward-facing / irreversible op", () => {
    for (const path of [
      "gmail.api.messages.send",
      "gmail.api.messages.trash",
      "gmail.api.messages.delete",
      "gmail.api.messages.batchDelete",
      "gmail.api.drafts.send",
      "googlecalendar.api.events.insert",
      "googlecalendar.api.events.create",
      "googlecalendar.api.events.update",
      "googlecalendar.api.events.patch",
      "googlecalendar.api.events.delete",
      "googlecalendar.api.events.move",
    ]) {
      expect(isDestructive(path)).toBe(true);
    }
  });

  it("leaves reads and draft-saving ungated", () => {
    for (const path of [
      "gmail.api.messages.list",
      "gmail.api.messages.get",
      "gmail.api.messages.modify", // label changes are reversible, not gated
      "gmail.db.messages.search",
      "gmail.api.drafts.create",
      "googlecalendar.api.events.getMany",
    ]) {
      expect(isDestructive(path)).toBe(false);
    }
  });

  it("authorizes exactly one destructive op per confirmation", () => {
    expect(DESTRUCTIVE_BUDGET).toBe(1);
  });
});

describe("isAffirmation (does the user actually confirm?)", () => {
  it("accepts a bare affirmation, with or without punctuation/case", () => {
    for (const text of [
      "confirm",
      "Confirm",
      "confirmed",
      "yes",
      "yes!",
      "yes.",
      "  ok  ",
      "okay",
      "sure",
      "go ahead",
      "do it",
      "send it",
      "proceed",
      "yes please",
      "yes, send it",
    ]) {
      expect(isAffirmation(text)).toBe(true);
    }
  });

  it("rejects hedges, redirections, and questions that merely start with yes/ok", () => {
    for (const text of [
      "yes but don't send it yet",
      "ok what's on my calendar?",
      "sure, what's next",
      "yes, actually cancel that",
      "no",
      "not yet",
      "don't send it",
      "wait",
      "maybe later",
      "ok so why did that fail",
      "yes I changed my mind about the whole thing",
    ]) {
      expect(isAffirmation(text)).toBe(false);
    }
  });

  it("rejects empty, blank, and missing input", () => {
    expect(isAffirmation("")).toBe(false);
    expect(isAffirmation("   ")).toBe(false);
    expect(isAffirmation(undefined)).toBe(false);
    expect(isAffirmation(null)).toBe(false);
  });

  it("does not treat an initial 'send an email…' request as confirmation", () => {
    expect(isAffirmation("send an email to bob about the q3 report")).toBe(false);
    expect(isAffirmation("can you delete the newsletter emails")).toBe(false);
  });
});
