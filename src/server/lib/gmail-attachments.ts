import "server-only";

import { freshAccessToken } from "@/server/lib/gmail-watch";

/**
 * Fetch one attachment's bytes via the Gmail REST API with the access token
 * Corsair manages. Corsair's Gmail plugin exposes no attachments endpoint, so we
 * call Gmail directly — the same proven pattern as armGmailWatch / getGmailEmail.
 * Large attachments carry only an attachmentId (no inline data), so this fetch is
 * required. Returns null on any failure; callers treat that as "bytes missing".
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
    const data = (await res.json()) as { data?: string };
    if (!data.data) return null;
    // Gmail returns base64url; Buffer's "base64url" handles the -_ alphabet.
    return Buffer.from(data.data, "base64url");
  } catch {
    return null;
  }
}
