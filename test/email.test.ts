import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  encodeRawEmail,
  extractBodyFromPayload,
  getHeader,
} from "@/server/lib/email";

function decodeRaw(raw: string): string {
  return decodeBase64Url(raw);
}

describe("encodeRawEmail", () => {
  it("produces url-safe base64 with no padding", () => {
    const raw = encodeRawEmail({ to: "a@b.com", subject: "Hi", body: "Hello" });
    expect(raw).not.toMatch(/[+/=]/);
  });

  it("round-trips the headers and body", () => {
    const raw = encodeRawEmail({
      to: "dev@corsair.dev",
      subject: "Sync up",
      body: "Line one\nLine two",
    });
    const text = decodeRaw(raw);
    expect(text).toContain("To: dev@corsair.dev");
    expect(text).toContain("Subject: Sync up");
    expect(text).toContain("Line one\nLine two");
  });

  it("strips CR/LF from headers so a subject can't inject a hidden header", () => {
    const raw = encodeRawEmail({
      to: "a@b.com",
      subject: "Hi\r\nBcc: victim@evil.com",
      body: "x",
    });
    const text = decodeRaw(raw);
    const headerBlock = text.split("\r\n\r\n")[0] ?? "";
    // The injected "Bcc:" must survive only as folded text inside the Subject
    // value, never as its own header line.
    const isHeaderLine = headerBlock
      .split("\r\n")
      .some((line) => /^bcc:/i.test(line));
    expect(isHeaderLine).toBe(false);
    expect(text).toContain("Subject: Hi Bcc: victim@evil.com");
  });

  it("encodes a non-ASCII subject as an RFC 2047 word", () => {
    const raw = encodeRawEmail({ to: "a@b.com", subject: "Café ☕", body: "x" });
    const text = decodeRaw(raw);
    expect(text).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it("includes a From header only when given one", () => {
    const without = decodeRaw(
      encodeRawEmail({ to: "a@b.com", subject: "s", body: "b" }),
    );
    expect(without).not.toContain("From:");
    const withFrom = decodeRaw(
      encodeRawEmail({ to: "a@b.com", subject: "s", body: "b", from: "me@x.com" }),
    );
    expect(withFrom).toContain("From: me@x.com");
  });
});

describe("extractBodyFromPayload", () => {
  const b64 = (s: string) =>
    Buffer.from(s, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  it("returns the plain-text part", () => {
    const body = extractBodyFromPayload({
      mimeType: "text/plain",
      body: { data: b64("hello world") },
    });
    expect(body).toBe("hello world");
  });

  it("walks nested multipart to find the text part", () => {
    const body = extractBodyFromPayload({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<b>hi</b>") } },
        { mimeType: "text/plain", body: { data: b64("hi") } },
      ],
    });
    expect(body).toBe("hi");
  });

  it("never leaks raw HTML when there is no text part", () => {
    const body = extractBodyFromPayload({
      mimeType: "text/html",
      body: { data: b64("<h1>secret</h1>") },
    });
    expect(body).toBe("");
  });
});

describe("getHeader", () => {
  const headers = [
    { name: "From", value: "a@b.com" },
    { name: "Subject", value: "Hi" },
  ];
  it("matches case-insensitively", () => {
    expect(getHeader(headers, "from")).toBe("a@b.com");
    expect(getHeader(headers, "SUBJECT")).toBe("Hi");
  });
  it("returns empty string for a missing header", () => {
    expect(getHeader(headers, "Bcc")).toBe("");
    expect(getHeader(undefined, "From")).toBe("");
  });
});
