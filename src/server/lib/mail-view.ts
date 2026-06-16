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
    archived:
      labels.length > 0 &&
      !labels.includes("INBOX") &&
      !labels.includes("SPAM") &&
      !labels.includes("TRASH"),
    timestamp: messageTimestamp(
      message.data.internalDate,
      message.data.createdAt,
    ),
  };
}

export type MappedMessage = ReturnType<typeof mapMessage>;

export function sortMessagesNewestFirst<
  T extends { timestamp: number },
>(messages: T[]): T[] {
  return [...messages].sort((a, b) => b.timestamp - a.timestamp);
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
  .enum(["inbox", "starred", "archived", "spam", "trash"])
  .default("inbox");

export type Folder = z.infer<typeof folderSchema>;

export const FOLDER_FILTERS: Record<Folder, (m: MappedMessage) => boolean> = {
  inbox: (m) => !m.archived && !m.trashed && !m.spam,
  starred: (m) => m.starred && !m.trashed && !m.spam,
  archived: (m) => m.archived,
  spam: (m) => m.spam,
  trash: (m) => m.trashed,
};
