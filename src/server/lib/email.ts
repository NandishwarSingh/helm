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
}): string {
  const lines = [
    ...(opts.from ? [`From: ${headerValue(opts.from)}`] : []),
    `To: ${headerValue(opts.to)}`,
    `Subject: ${encodeSubject(opts.subject)}`,
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
