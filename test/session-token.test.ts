import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { packToken, unpackToken } from "@/server/lib/session-token";

const SECRET = "test-secret-please-ignore";
const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Reconstructs the pre-expiry "<id>.<hmac(id)>" cookie this code used to mint. */
function legacyToken(secret: string, tenantId: string): string {
  const sig = createHmac("sha256", secret).update(tenantId).digest("base64url");
  return `${tenantId}.${sig}`;
}

describe("session-token codec", () => {
  it("round-trips a freshly issued, exp-bound token", () => {
    const token = packToken(SECRET, "tenant-abc", NOW + HOUR);
    expect(unpackToken(SECRET, token, NOW)).toBe("tenant-abc");
  });

  it("rejects a token past its embedded expiry", () => {
    const token = packToken(SECRET, "tenant-abc", NOW + HOUR);
    expect(unpackToken(SECRET, token, NOW + 2 * HOUR)).toBeNull();
  });

  it("rejects a tampered tenant id (the signature covers id + expiry)", () => {
    const token = packToken(SECRET, "tenant-abc", NOW + HOUR);
    const forged = token.replace("tenant-abc", "tenant-xyz");
    expect(unpackToken(SECRET, forged, NOW)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = packToken(SECRET, "tenant-abc", NOW + HOUR);
    expect(unpackToken("other-secret", token, NOW)).toBeNull();
  });

  it("still accepts a legacy bare-id token (backward compat)", () => {
    const token = legacyToken(SECRET, "tenant-legacy");
    expect(unpackToken(SECRET, token, NOW)).toBe("tenant-legacy");
  });

  it("rejects a forged legacy token", () => {
    const token = legacyToken(SECRET, "tenant-legacy").replace(
      "tenant-legacy",
      "tenant-evil",
    );
    expect(unpackToken(SECRET, token, NOW)).toBeNull();
  });

  it("rejects empty, dotless, and undefined input", () => {
    expect(unpackToken(SECRET, undefined, NOW)).toBeNull();
    expect(unpackToken(SECRET, "", NOW)).toBeNull();
    expect(unpackToken(SECRET, "no-dot-here", NOW)).toBeNull();
    expect(unpackToken(SECRET, ".sigonly", NOW)).toBeNull();
  });
});
