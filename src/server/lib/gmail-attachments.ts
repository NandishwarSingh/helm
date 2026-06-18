import "server-only";

import { freshAccessToken } from "@/server/lib/gmail-watch";

// Hard ceiling on a single fetched attachment. Gmail allows up to ~50MB; the
// bytes are buffered whole here, so cap to bound server memory on BOTH callers
// that funnel through this function (the preview-stream route + scan extraction).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Fetch one attachment's bytes via the Gmail REST API with the access token
 * Corsair manages. Corsair's Gmail plugin exposes no attachments endpoint, so we
 * call Gmail directly — the same proven pattern as armGmailWatch / getGmailEmail.
 * Large attachments carry only an attachmentId (no inline data), so this fetch is
 * required. Returns null on any failure (incl. oversize); callers treat that as
 * "bytes missing".
 */
export async function fetchAttachmentBytes(
  tenantId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  try {
    const token = await freshAccessToken(tenantId);
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: string; size?: number };
    if (!data.data) return null;
    // Gmail reports the decoded size; reject oversize before allocating the buffer.
    if (typeof data.size === "number" && data.size > MAX_ATTACHMENT_BYTES) {
      return null;
    }
    // Gmail returns base64url; Buffer's "base64url" handles the -_ alphabet.
    const buf = Buffer.from(data.data, "base64url");
    if (buf.length > MAX_ATTACHMENT_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}
