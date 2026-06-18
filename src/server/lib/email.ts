import "server-only";

// Header values must never contain CR/LF — a newline in a crafted subject
// would otherwise inject extra headers (e.g. a hidden Bcc) into the message.
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// Non-ASCII subjects travel as an RFC 2047 encoded word so strict receivers
// don't mangle them.
function encodeSubject(subject: string): string {
  const clean = headerValue(subject);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf-8").toString("base64")}?=`;
}

export function encodeRawEmail(opts: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    ...(opts.from ? [`From: ${headerValue(opts.from)}`] : []),
    `To: ${headerValue(opts.to)}`,
    ...(opts.cc?.trim() ? [`Cc: ${headerValue(opts.cc)}`] : []),
    ...(opts.bcc?.trim() ? [`Bcc: ${headerValue(opts.bcc)}`] : []),
    `Subject: ${encodeSubject(opts.subject)}`,
    // Threading headers tie a reply to its conversation so Gmail nests it.
    ...(opts.inReplyTo ? [`In-Reply-To: ${headerValue(opts.inReplyTo)}`] : []),
    ...(opts.references ? [`References: ${headerValue(opts.references)}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    opts.body,
  ];
  const message = lines.join("\r\n");
  const base64 = Buffer.from(message, "utf-8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

export function extractBodyFromPayload(payload?: GmailPart): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const text = extractBodyFromPayload(part);
    if (text) return text;
  }

  // Intentionally no generic body fallback: an HTML-only message must not leak
  // its raw markup here. HTML is handled separately by extractHtmlFromPayload.
  return "";
}

type AttachmentPart = {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { attachmentId?: string; size?: number };
  parts?: AttachmentPart[];
};

/** A real (non-inline) attachment located in a message payload. */
export type RawAttachment = {
  partId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId: string;
  inline: boolean;
};

/**
 * Recurse the payload collecting real attachment parts (a filename + a
 * body.attachmentId). Inline body parts have no attachmentId → skipped. A part
 * marked Content-Disposition: inline, or an image/* with a Content-ID (cid:
 * signature graphics), is flagged `inline` so the Documents grid can hide it.
 */
export function extractAttachments(
  payload?: AttachmentPart,
  out: RawAttachment[] = [],
): RawAttachment[] {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    const disp =
      payload.headers
        ?.find((h) => h.name?.toLowerCase() === "content-disposition")
        ?.value?.toLowerCase() ?? "";
    const hasCid = payload.headers?.some(
      (h) => h.name?.toLowerCase() === "content-id",
    );
    const inline =
      disp.startsWith("inline") ||
      (Boolean(hasCid) && (payload.mimeType ?? "").startsWith("image/"));
    out.push({
      partId: payload.partId ?? "",
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      sizeBytes: payload.body.size ?? 0,
      attachmentId: payload.body.attachmentId,
      inline,
    });
  }
  for (const part of payload.parts ?? []) extractAttachments(part, out);
  return out;
}

/** Returns the rich text/html part of a message, if present. */
export function extractHtmlFromPayload(payload?: GmailPart): string {
  if (!payload) return "";

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const html = extractHtmlFromPayload(part);
    if (html) return html;
  }

  return "";
}

export function getHeader(
  headers: { name?: string; value?: string }[] | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}
