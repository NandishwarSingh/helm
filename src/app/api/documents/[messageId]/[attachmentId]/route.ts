import "server-only";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/server/db";
import { documents } from "@/server/db/schema";
import { fetchAttachmentBytes } from "@/server/lib/gmail-attachments";
import { rateLimit } from "@/server/lib/rate-limit";
import { resolveAccountTenant } from "@/server/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only these render safely inline; everything else is forced to download so a
// hostile attachment (HTML/SVG/JS) can never script our origin in an <iframe>.
const INLINE_SAFE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

// Map a filename extension to an inline-safe MIME (a subset of INLINE_SAFE only).
// Gmail often labels attachments application/octet-stream; this recovers a real
// renderable type from the name. Deliberately omits svg/html / anything scriptable.
const EXT_RE = /\.([a-z0-9]+)$/;
function extMime(name: string): string | null {
  const ext = EXT_RE.exec(name.toLowerCase())?.[1];
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return null;
  }
}

/**
 * Collapse a filename to a safe ASCII token for the Content-Disposition header;
 * the full UTF-8 name rides separately in filename* (RFC 5987). Replaces control
 * chars, non-ASCII, quotes and path separators so the value can't break out of
 * the header or smuggle a path.
 */
function asciiFilename(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    const unsafe =
      code < 0x20 || code > 0x7e || ch === '"' || ch === "\\" || ch === "/";
    out += unsafe ? "_" : ch;
  }
  out = out.trim();
  return out.length > 0 ? out.slice(0, 200) : "attachment";
}

/**
 * Streams one attachment's bytes for in-app preview (PDF iframe, <img>) or an
 * explicit download (?disposition=attachment). The owning account is named in
 * the query (?account=); ownership is enforced because resolveAccountTenant only
 * resolves accounts the calling session owns — an unowned or unknown id yields no
 * tenant (→ 404), so nobody can stream another mailbox's attachment by guessing.
 * The document row must also exist for that tenant, which proves the attachment
 * belongs to it before we ever fetch the bytes from Gmail.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  const { messageId, attachmentId } = await ctx.params;
  const url = new URL(request.url);
  const account = url.searchParams.get("account") ?? "";
  const wantsDownload = url.searchParams.get("disposition") === "attachment";

  const tenantId = account ? await resolveAccountTenant(account) : null;
  if (!tenantId) {
    return new Response("not found", { status: 404 });
  }

  // Throttle per resolved tenant (mailbox) — unowned ids already 404'd above, so
  // this never burns a bucket on a stranger's id. Each hit re-fetches from Gmail,
  // so cap the loop a single session can drive.
  const { ok, retryAfterMs } = await rateLimit(`docstream:${tenantId}`, 60, 60_000);
  if (!ok) {
    return new Response("too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
    });
  }

  const [row] = await db
    .select({ filename: documents.filename, mimeType: documents.mimeType })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.messageId, messageId),
        eq(documents.attachmentId, attachmentId),
      ),
    )
    .limit(1);
  if (!row) {
    return new Response("not found", { status: 404 });
  }

  const bytes = await fetchAttachmentBytes(tenantId, messageId, attachmentId);
  if (!bytes) {
    return new Response("attachment unavailable", { status: 502 });
  }

  const stored = (row.mimeType || "").toLowerCase();
  const generic =
    stored === "" ||
    stored === "application/octet-stream" ||
    stored === "binary/octet-stream";
  // Recover a renderable type for generic/octet-stream PDFs + images from the
  // filename, but ONLY upgrade into the inline-safe set (never to svg/html).
  const effective = INLINE_SAFE.has(stored)
    ? row.mimeType
    : ((generic ? extMime(row.filename) : null) ?? row.mimeType);
  const safeInline = INLINE_SAFE.has(effective.toLowerCase());
  // Never render an unknown/scriptable type inline, regardless of what was asked.
  const disposition = wantsDownload || !safeInline ? "attachment" : "inline";
  // Under nosniff the browser obeys Content-Type literally, so when we serve
  // inline we must declare the corrected type or the iframe/img refuses to render.
  const contentType = safeInline
    ? effective
    : row.mimeType || "application/octet-stream";
  const ascii = asciiFilename(row.filename);
  const utf8 = encodeURIComponent(row.filename);

  // Buffer → a Uint8Array backed by a plain ArrayBuffer so it satisfies BodyInit
  // (a Node Buffer's backing buffer is ArrayBufferLike, which BodyInit rejects).
  const body = new Uint8Array(bytes);
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`,
      // Per-user bytes — never let a shared proxy cache them.
      "Cache-Control": "private, no-store",
      // Honour the declared type; don't let the browser sniff bytes into HTML.
      "X-Content-Type-Options": "nosniff",
      // Private attachment bytes — keep them out of any search index.
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
