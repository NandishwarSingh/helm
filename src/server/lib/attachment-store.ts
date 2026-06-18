import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Short-lived, owner-scoped store for the BYTES of files the user uploads to the
 * agent. The extracted text rides with the chat turn for context; the bytes live
 * here only long enough to be folded into a staged email's MIME at send time
 * (then they're embedded in the signed `raw`, so the store isn't read at confirm).
 * Process-local + TTL'd, like the app's other in-memory state — single-instance
 * by design. A random token gates access AND the owner is re-checked on read.
 */
type Entry = {
  ownerId: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
  expiresAt: number;
};

const store = new Map<string, Entry>();
const TTL_MS = 30 * 60 * 1000;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

function sweep(): void {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

function totalBytes(): number {
  let n = 0;
  for (const entry of store.values()) n += entry.bytes.length;
  return n;
}

/** Stash a file's bytes, returning an unguessable token to reference it by. */
export function putAttachment(
  ownerId: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
): string {
  sweep();
  // Evict oldest entries while over the global cap so a burst can't exhaust RAM.
  while (totalBytes() + bytes.length > MAX_TOTAL_BYTES && store.size > 0) {
    let oldestToken: string | null = null;
    let oldestAt = Infinity;
    for (const [token, entry] of store) {
      if (entry.expiresAt < oldestAt) {
        oldestAt = entry.expiresAt;
        oldestToken = token;
      }
    }
    if (!oldestToken) break;
    store.delete(oldestToken);
  }
  const token = randomUUID();
  store.set(token, {
    ownerId,
    name,
    mimeType,
    bytes,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

/** Resolve a token to its bytes — only for the owner that stashed it. */
export function getAttachment(
  ownerId: string,
  token: string,
): { name: string; mimeType: string; bytes: Buffer } | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.ownerId !== ownerId || entry.expiresAt <= Date.now()) return null;
  return { name: entry.name, mimeType: entry.mimeType, bytes: entry.bytes };
}
