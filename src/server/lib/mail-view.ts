import "server-only";
import { z } from "zod";

/**
 * Shared shaping of cached Gmail rows into list-view messages. Folder
 * membership is derived from Gmail labels, which Corsair keeps current
 * from API responses.
 */

export function messageTimestamp(
  internalDate?: string | null,
  createdAt?: Date | null,
): number {
  if (internalDate) return Number(internalDate);
  if (createdAt) return createdAt.getTime();
  return 0;
}

export function mapMessage(message: {
  entity_id: string;
  data: {
    threadId?: string;
    snippet?: string;
    subject?: string;
    from?: string;
    to?: string;
    body?: string;
    internalDate?: string;
    createdAt?: Date | null;
    labelIds?: string[];
  };
}) {
  const labels = message.data.labelIds ?? [];
  return {
    id: message.entity_id,
    threadId: message.data.threadId ?? "",
    snippet: message.data.snippet ?? "",
    subject: message.data.subject ?? "",
    from: message.data.from ?? "",
    to: message.data.to ?? "",
    date: message.data.internalDate ?? null,
    // messages.list upserts bare id stubs before hydration fills them in; a
    // failed hydration leaves them empty, and empty rows must never render.
    hydrated: [
      message.data.from,
      message.data.subject,
      message.data.snippet,
    ].some(Boolean),
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    spam: labels.includes("SPAM"),
    trashed: labels.includes("TRASH"),
    sent: labels.includes("SENT"),
    // Archived = received mail pulled out of the inbox. Sent/draft/chat lack
    // INBOX too, so exclude them or they'd masquerade as archived.
    archived:
      labels.length > 0 &&
      !labels.includes("INBOX") &&
      !labels.includes("SPAM") &&
      !labels.includes("TRASH") &&
      !labels.includes("SENT") &&
      !labels.includes("DRAFT") &&
      !labels.includes("CHAT"),
    timestamp: messageTimestamp(
      message.data.internalDate,
      message.data.createdAt,
    ),
  };
}

export type MappedMessage = ReturnType<typeof mapMessage>;

export function sortMessagesNewestFirst<
  T extends { timestamp: number; id: string },
>(messages: T[]): T[] {
  // Tiebreak equal timestamps on id so the order is identical across refetches.
  // Without it, same-second messages can swap places between polls and the list
  // visibly reshuffles / rows pop in and out.
  return [...messages].sort(
    (a, b) =>
      b.timestamp - a.timestamp ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

export function dedupeByEntityId<
  T extends { entity_id: string; updated_at: Date },
>(items: T[]): T[] {
  const byEntityId = new Map<string, T>();
  for (const item of items) {
    const existing = byEntityId.get(item.entity_id);
    if (!existing || item.updated_at > existing.updated_at) {
      byEntityId.set(item.entity_id, item);
    }
  }
  return Array.from(byEntityId.values());
}

export const folderSchema = z
  .enum(["inbox", "starred", "archived", "spam", "trash", "sent"])
  .default("inbox");

export type Folder = z.infer<typeof folderSchema>;

export const FOLDER_FILTERS: Record<Folder, (m: MappedMessage) => boolean> = {
  inbox: (m) => !m.archived && !m.trashed && !m.spam && !m.sent,
  starred: (m) => m.starred && !m.trashed && !m.spam,
  archived: (m) => m.archived,
  spam: (m) => m.spam,
  trash: (m) => m.trashed,
  sent: (m) => m.sent && !m.trashed,
};
