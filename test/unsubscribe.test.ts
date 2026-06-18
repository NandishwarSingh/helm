import { describe, expect, it } from "vitest";

import { isSafeUnsubUrl, parseListUnsubscribe } from "@/server/lib/unsubscribe";

describe("parseListUnsubscribe", () => {
  it("picks one-click only when the post directive is present", () => {
    const r = parseListUnsubscribe(
      "<https://news.example.com/u/abc>, <mailto:unsub@example.com>",
      "List-Unsubscribe=One-Click",
    );
    expect(r.oneClick).toBe("https://news.example.com/u/abc");
    expect(r.httpManual).toBeNull();
    expect(r.mailto).toEqual({
      to: "unsub@example.com",
      subject: "Unsubscribe",
    });
  });

  it("treats an HTTPS link without the directive as manual (no auto-POST)", () => {
    const r = parseListUnsubscribe("<https://example.com/unsub?id=1>", "");
    expect(r.oneClick).toBeNull();
    expect(r.httpManual).toBe("https://example.com/unsub?id=1");
  });

  it("never marks a plain http (non-TLS) link as one-click", () => {
    const r = parseListUnsubscribe(
      "<http://example.com/unsub>",
      "List-Unsubscribe=One-Click",
    );
    expect(r.oneClick).toBeNull();
    expect(r.httpManual).toBe("http://example.com/unsub");
  });

  it("parses a mailto with a custom subject", () => {
    const r = parseListUnsubscribe(
      "<mailto:leave@list.example.com?subject=unsubscribe%20me>",
      "",
    );
    expect(r.mailto).toEqual({
      to: "leave@list.example.com",
      subject: "unsubscribe me",
    });
  });

  it("tolerates missing angle brackets and extra whitespace", () => {
    const r = parseListUnsubscribe(
      "  https://x.example/u  ,  mailto:a@b.com ",
      "List-Unsubscribe=One-Click",
    );
    expect(r.oneClick).toBe("https://x.example/u");
    expect(r.mailto?.to).toBe("a@b.com");
  });

  it("returns all-null when there is no usable header", () => {
    expect(parseListUnsubscribe("", "")).toEqual({
      oneClick: null,
      httpManual: null,
      mailto: null,
    });
  });

  it("rejects a malformed mailto address", () => {
    expect(parseListUnsubscribe("<mailto:not-an-email>", "").mailto).toBeNull();
  });
});

describe("isSafeUnsubUrl (SSRF guard)", () => {
  it("allows a normal public HTTPS endpoint", () => {
    expect(isSafeUnsubUrl("https://news.example.com/u/abc")).toBe(true);
    expect(isSafeUnsubUrl("https://1.1.1.1/u")).toBe(true);
  });

  it("rejects non-HTTPS", () => {
    expect(isSafeUnsubUrl("http://example.com/u")).toBe(false);
    expect(isSafeUnsubUrl("ftp://example.com/u")).toBe(false);
  });

  it("rejects embedded credentials", () => {
    expect(isSafeUnsubUrl("https://user:pass@example.com/u")).toBe(false);
  });

  it("rejects loopback / internal hostnames", () => {
    expect(isSafeUnsubUrl("https://localhost/u")).toBe(false);
    expect(isSafeUnsubUrl("https://app.internal/u")).toBe(false);
    expect(isSafeUnsubUrl("https://db.local/u")).toBe(false);
  });

  it("rejects private and reserved IPv4 literals", () => {
    expect(isSafeUnsubUrl("https://127.0.0.1/u")).toBe(false);
    expect(isSafeUnsubUrl("https://10.0.0.5/u")).toBe(false);
    expect(isSafeUnsubUrl("https://192.168.1.1/u")).toBe(false);
    expect(isSafeUnsubUrl("https://172.16.0.1/u")).toBe(false);
    expect(isSafeUnsubUrl("https://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
  });

  it("rejects IPv6 loopback / unique-local / link-local", () => {
    expect(isSafeUnsubUrl("https://[::1]/u")).toBe(false);
    expect(isSafeUnsubUrl("https://[fc00::1]/u")).toBe(false);
    expect(isSafeUnsubUrl("https://[fe80::1]/u")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isSafeUnsubUrl("not a url")).toBe(false);
    expect(isSafeUnsubUrl("")).toBe(false);
  });
});
