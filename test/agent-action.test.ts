import { describe, expect, it } from "vitest";

import {
  signAction,
  summarizeAction,
  verifyAction,
  type ProposedAction,
} from "@/server/lib/agent-action";

const SECRET = "test-secret-please-ignore";
const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;

const SEND: ProposedAction = {
  tenantId: "tenant-abc",
  op: "gmail.api.messages.send",
  args: { raw: "ignored-for-token-tests" },
};

/** Build the base64url MIME the agent's playbook produces, for summary tests. */
function mime(lines: string[]): string {
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("agent-action token", () => {
  it("round-trips a signed action with its args", () => {
    const token = signAction(SECRET, SEND, NOW);
    expect(verifyAction(SECRET, token, NOW + MIN)).toEqual(SEND);
  });

  it("rejects a token past its 10-minute expiry", () => {
    const token = signAction(SECRET, SEND, NOW);
    expect(verifyAction(SECRET, token, NOW + 11 * MIN)).toBeNull();
    expect(verifyAction(SECRET, token, NOW + 9 * MIN)).toEqual(SEND);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAction(SECRET, SEND, NOW);
    expect(verifyAction("other-secret", token, NOW)).toBeNull();
  });

  it("rejects a tampered payload (sig covers op + args + time)", () => {
    const token = signAction(SECRET, SEND, NOW);
    // Flip the recipient inside the encoded payload → signature no longer matches.
    const forged = signAction(
      SECRET,
      { ...SEND, op: "gmail.api.messages.trash" },
      NOW,
    );
    const spliced = token.split(".")[0] + "." + forged.split(".")[1];
    expect(verifyAction(SECRET, spliced, NOW)).toBeNull();
  });

  it("rejects empty, dotless, and undefined input", () => {
    expect(verifyAction(SECRET, undefined, NOW)).toBeNull();
    expect(verifyAction(SECRET, "", NOW)).toBeNull();
    expect(verifyAction(SECRET, "no-dot-here", NOW)).toBeNull();
    expect(verifyAction(SECRET, ".sigonly", NOW)).toBeNull();
  });

  it("preserves the exact op + args so the replay matches the preview", () => {
    const action: ProposedAction = {
      tenantId: "t1",
      op: "googlecalendar.api.events.create",
      args: { calendarId: "primary", event: { summary: "Sync", attendees: [{ email: "a@b.com" }] } },
    };
    const token = signAction(SECRET, action, NOW);
    expect(verifyAction(SECRET, token, NOW)).toEqual(action);
  });
});

describe("summarizeAction", () => {
  it("derives To / Subject / body from a send's MIME (what you see = what runs)", () => {
    const raw = mime([
      "To: priya@acme.com",
      "Subject: Re: Q3 roadmap review",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hi Priya — yes, I'll join Thursday.",
    ]);
    const s = summarizeAction("gmail.api.messages.send", { raw });
    expect(s.kind).toBe("send");
    expect(s.title).toBe("Send email");
    expect(s.fields).toEqual([
      { label: "To", value: "priya@acme.com" },
      { label: "Subject", value: "Re: Q3 roadmap review" },
    ]);
    expect(s.body).toBe("Hi Priya — yes, I'll join Thursday.");
  });

  it("includes Cc when present", () => {
    const raw = mime(["To: a@b.com", "Cc: c@d.com", "Subject: Hi", "", "Body"]);
    const s = summarizeAction("gmail.api.messages.send", { raw });
    expect(s.fields).toContainEqual({ label: "Cc", value: "c@d.com" });
  });

  it("summarizes a trash by message id", () => {
    const s = summarizeAction("gmail.api.messages.trash", { id: "msg-1" });
    expect(s.kind).toBe("trash");
    expect(s.fields).toEqual([{ label: "Message", value: "msg-1" }]);
  });

  it("summarizes a calendar create with title, time, and invites", () => {
    const s = summarizeAction("googlecalendar.api.events.create", {
      calendarId: "primary",
      event: {
        summary: "Dev sync",
        start: { dateTime: "2026-06-16T09:00:00+05:30" },
        end: { dateTime: "2026-06-16T09:30:00+05:30" },
        attendees: [{ email: "dev@corsair.dev" }],
      },
    });
    expect(s.kind).toBe("event-create");
    expect(s.fields).toEqual([
      { label: "Title", value: "Dev sync" },
      { label: "Start", value: "2026-06-16T09:00:00+05:30" },
      { label: "End", value: "2026-06-16T09:30:00+05:30" },
      { label: "Invites", value: "dev@corsair.dev" },
    ]);
  });

  it("summarizes an event delete by id", () => {
    const s = summarizeAction("googlecalendar.api.events.delete", { id: "ev-9" });
    expect(s.kind).toBe("event-delete");
    expect(s.fields).toEqual([{ label: "Event", value: "ev-9" }]);
  });

  it("falls back to a generic summary for an unmapped op", () => {
    const s = summarizeAction("gmail.api.messages.modify", { id: "x" });
    expect(s.kind).toBe("other");
    expect(s.fields).toEqual([
      { label: "Operation", value: "gmail.api.messages.modify" },
    ]);
  });
});
