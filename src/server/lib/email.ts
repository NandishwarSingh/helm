import "server-only";
import { randomBytes } from "node:crypto";

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

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Wrap a base64 string to 76-char lines (RFC 2045). */
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** A file to attach to an outgoing message. */
export type OutgoingAttachment = {
  name: string;
  mimeType: string;
  bytes: Buffer;
};

/**
 * Rebuild a base64url RFC 2822 message (the simple text email the agent
 * composed) into a multipart/mixed message carrying the given attachments. The
 * original address/subject/threading headers are preserved verbatim; only the
 * Content-* / MIME-Version headers are replaced. Returns the new base64url raw,
 * or null when it can't safely rebuild (un-decodable, no header/body split, or
 * the original is ALREADY multipart — in which case the caller sends as-is).
 * Filenames and MIME types are CR/LF-stripped so they can't inject headers.
 */
export function buildRawWithAttachments(
  rawBase64Url: string,
  attachments: OutgoingAttachment[],
): string | null {
  if (attachments.length === 0) return null;
  let mime: string;
  try {
    mime = decodeBase64Url(rawBase64Url);
  } catch {
    return null;
  }
  if (!mime) return null;
  const sep = mime.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const idx = mime.indexOf(sep);
  if (idx < 0) return null;
  const head = mime.slice(0, idx);
  const body = mime.slice(idx + sep.length);

  const kept: string[] = [];
  let bodyContentType = 'text/plain; charset="UTF-8"';
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const name = (colon > 0 ? line.slice(0, colon) : line).trim().toLowerCase();
    if (name === "content-type") {
      const value = line.slice(colon + 1).trim();
      if (value.toLowerCase().includes("multipart")) return null; // already MIME
      if (value.toLowerCase().startsWith("text/")) bodyContentType = value;
      continue; // we set our own multipart Content-Type
    }
    if (name === "content-transfer-encoding" || name === "mime-version") continue;
    if (line.trim()) kept.push(line);
  }

  const boundary = `helm_${randomBytes(16).toString("hex")}`;
  const safeHeader = (v: string) => v.replace(/[\r\n"]+/g, "_");
  const lines: string[] = [
    ...kept,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: ${headerValue(bodyContentType)}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(body, "utf-8").toString("base64")),
  ];
  for (const att of attachments) {
    const name = safeHeader(att.name) || "attachment";
    const type = headerValue(att.mimeType) || "application/octet-stream";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(att.bytes.toString("base64")),
    );
  }
  lines.push(`--${boundary}--`, "");
  return toBase64Url(Buffer.from(lines.join("\r\n"), "utf-8"));
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
