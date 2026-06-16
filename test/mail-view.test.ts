import { describe, expect, it } from "vitest";

import {
  FOLDER_FILTERS,
  dedupeByEntityId,
  mapMessage,
  sortMessagesNewestFirst,
} from "@/server/lib/mail-view";

function row(id: string, labelIds: string[], extra: Record<string, unknown> = {}) {
  return {
    entity_id: id,
    data: { from: "a@b.com", subject: "s", snippet: "x", labelIds, ...extra },
  };
}

describe("mapMessage", () => {
  it("derives flags from Gmail labels", () => {
    const m = mapMessage(row("1", ["INBOX", "UNREAD", "STARRED"]));
    expect(m.unread).toBe(true);
    expect(m.starred).toBe(true);
    expect(m.spam).toBe(false);
    expect(m.trashed).toBe(false);
    expect(m.archived).toBe(false);
  });

  it("treats a message with labels but no INBOX/SPAM/TRASH as archived", () => {
    expect(mapMessage(row("1", ["IMPORTANT"])).archived).toBe(true);
    expect(mapMessage(row("1", ["INBOX"])).archived).toBe(false);
  });

  it("marks a row hydrated only when it has real metadata", () => {
    expect(mapMessage(row("1", ["INBOX"])).hydrated).toBe(true);
    expect(
      mapMessage({ entity_id: "1", data: { labelIds: ["INBOX"] } }).hydrated,
    ).toBe(false);
  });
});

describe("FOLDER_FILTERS", () => {
  const inbox = mapMessage(row("i", ["INBOX", "UNREAD"]));
  const starred = mapMessage(row("s", ["INBOX", "STARRED"]));
  const archived = mapMessage(row("a", ["IMPORTANT"]));
  const spam = mapMessage(row("p", ["SPAM"]));
  const trash = mapMessage(row("t", ["TRASH"]));

  it("inbox excludes archived, spam and trash", () => {
    expect(FOLDER_FILTERS.inbox(inbox)).toBe(true);
    expect(FOLDER_FILTERS.inbox(archived)).toBe(false);
    expect(FOLDER_FILTERS.inbox(spam)).toBe(false);
    expect(FOLDER_FILTERS.inbox(trash)).toBe(false);
  });
  it("starred keeps starred non-trashed mail", () => {
    expect(FOLDER_FILTERS.starred(starred)).toBe(true);
    expect(FOLDER_FILTERS.starred(inbox)).toBe(false);
  });
  it("spam and trash isolate their own", () => {
    expect(FOLDER_FILTERS.spam(spam)).toBe(true);
    expect(FOLDER_FILTERS.trash(trash)).toBe(true);
    expect(FOLDER_FILTERS.spam(inbox)).toBe(false);
  });
  it("files sent mail under Sent only — never Inbox or Archive", () => {
    const sent = mapMessage(row("se", ["SENT"]));
    expect(sent.sent).toBe(true);
    expect(FOLDER_FILTERS.sent(sent)).toBe(true);
    expect(FOLDER_FILTERS.inbox(sent)).toBe(false);
    expect(FOLDER_FILTERS.archived(sent)).toBe(false);
  });
  it("a trashed sent message leaves Sent for Trash", () => {
    const sentTrashed = mapMessage(row("st", ["SENT", "TRASH"]));
    expect(FOLDER_FILTERS.sent(sentTrashed)).toBe(false);
    expect(FOLDER_FILTERS.trash(sentTrashed)).toBe(true);
  });
});

describe("dedupeByEntityId", () => {
  it("keeps the most recently updated row per id", () => {
    const older = { entity_id: "1", updated_at: new Date(1000), v: "old" };
    const newer = { entity_id: "1", updated_at: new Date(2000), v: "new" };
    const out = dedupeByEntityId([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0]!.v).toBe("new");
  });
});

describe("sortMessagesNewestFirst", () => {
  it("orders by descending timestamp", () => {
    const out = sortMessagesNewestFirst([
      { timestamp: 100, id: "a" },
      { timestamp: 300, id: "b" },
      { timestamp: 200, id: "c" },
    ]);
    expect(out.map((m) => m.timestamp)).toEqual([300, 200, 100]);
  });

  it("breaks timestamp ties deterministically by id (stable across calls)", () => {
    const rows = [
      { timestamp: 100, id: "m1" },
      { timestamp: 100, id: "m3" },
      { timestamp: 100, id: "m2" },
    ];
    const first = sortMessagesNewestFirst(rows).map((m) => m.id);
    // Same input in a different order must yield the same ordering.
    const shuffled = sortMessagesNewestFirst([rows[2]!, rows[0]!, rows[1]!]).map(
      (m) => m.id,
    );
    expect(first).toEqual(shuffled);
  });
});
