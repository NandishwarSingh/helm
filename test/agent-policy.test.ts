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
});
