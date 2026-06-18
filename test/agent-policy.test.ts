import { describe, expect, it } from "vitest";

import { isAllowedPath, isDestructive } from "@/server/lib/agent-policy";

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

  it("rejects prototype-chain segments that the charset would otherwise admit", () => {
    expect(isAllowedPath("gmail.api.messages.constructor")).toBe(false);
    expect(isAllowedPath("gmail.api.__proto__.send")).toBe(false);
    expect(isAllowedPath("gmail.api.messages.__proto__")).toBe(false);
    expect(isAllowedPath("googlecalendar.api.events.prototype")).toBe(false);
  });
});

describe("isDestructive (confirmation-gated operations)", () => {
  it("flags every outward-facing / irreversible op", () => {
    for (const path of [
      "gmail.api.messages.send",
      "gmail.api.messages.trash",
      "gmail.api.messages.delete",
      "gmail.api.messages.batchDelete",
      "gmail.api.messages.batchModify", // bulk label write — mass-trash blast radius
      "gmail.api.messages.untrash",
      "gmail.api.threads.trash",
      "gmail.api.threads.delete",
      "gmail.api.threads.untrash",
      "gmail.api.drafts.send",
      "gmail.api.drafts.update",
      "gmail.api.drafts.delete",
      "gmail.api.labels.create",
      "gmail.api.labels.update",
      "gmail.api.labels.delete",
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
      "gmail.api.threads.modify", // same — reversible label toggle
      "gmail.db.messages.search",
      "gmail.api.drafts.create", // saving a new draft is benign
      "gmail.api.labels.list",
      "googlecalendar.api.events.getMany",
    ]) {
      expect(isDestructive(path)).toBe(false);
    }
  });
});
