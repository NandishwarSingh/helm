/**
 * One-click newsletter unsubscribe (RFC 2369 `List-Unsubscribe` + RFC 8058
 * `List-Unsubscribe-Post`). The parser + URL guard are PURE (no `server-only`,
 * no I/O) so they unit-test directly, mirroring billing-policy; only
 * `postOneClickUnsubscribe` touches the network.
 *
 * Why no headless browser: ~all legitimate bulk senders ship `List-Unsubscribe`,
 * and one-click senders also ship `List-Unsubscribe-Post: List-Unsubscribe=
 * One-Click`. That lets us unsubscribe with a single HTTPS POST (or a mailto we
 * send from the user's own box) — no scraping, no clicking links in the body.
 */

export type ParsedUnsub = {
  /** HTTPS endpoint safe to auto-POST per RFC 8058 (sender opted into one-click). */
  oneClick: string | null;
  /** An http(s) link present but NOT one-click — surfaced for the user to open. */
  httpManual: string | null;
  /** A `mailto:` unsubscribe address + subject, sent from the user's mailbox. */
  mailto: { to: string; subject: string } | null;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Pull the address + subject out of a `mailto:` unsubscribe URI. */
function parseMailto(uri: string): { to: string; subject: string } | null {
  const rest = uri.slice("mailto:".length);
  const q = rest.indexOf("?");
  const addrRaw = q >= 0 ? rest.slice(0, q) : rest;
  let to: string;
  try {
    to = decodeURIComponent(addrRaw).trim();
  } catch {
    to = addrRaw.trim();
  }
  if (!EMAIL_RE.test(to)) return null;
  let subject = "Unsubscribe";
  if (q >= 0) {
    const params = new URLSearchParams(rest.slice(q + 1));
    const s = params.get("subject");
    if (s?.trim()) subject = s.trim();
  }
  return { to, subject };
}

/**
 * Parse a `List-Unsubscribe` header (and the optional `List-Unsubscribe-Post`)
 * into the actions we can take. Entries are comma-separated and angle-bracketed
 * per RFC 2369; we tolerate missing brackets. One-click requires BOTH an HTTPS
 * target AND the `List-Unsubscribe=One-Click` post directive.
 */
export function parseListUnsubscribe(
  listUnsub: string,
  listUnsubPost: string,
): ParsedUnsub {
  const entries = (listUnsub ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^<|>$/g, "").trim())
    .filter(Boolean);

  let http: string | null = null;
  let mailto: { to: string; subject: string } | null = null;
  for (const e of entries) {
    const lower = e.toLowerCase();
    if (lower.startsWith("mailto:")) {
      mailto ??= parseMailto(e);
    } else if (lower.startsWith("https://") || lower.startsWith("http://")) {
      http ??= e;
    }
  }

  const postsOneClick = /list-unsubscribe\s*=\s*one-click/i.test(
    listUnsubPost ?? "",
  );
  const httpsTarget = http?.toLowerCase().startsWith("https://");
  const oneClick = postsOneClick && httpsTarget ? http : null;

  return {
    oneClick,
    httpManual: oneClick ? null : http,
    mailto,
  };
}

/** Dotted-quad → 32-bit int, or null if not a plain IPv4 literal. */
function ipv4ToInt(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return (
    ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  );
}

/** True for IPv4 literals in private / loopback / link-local / reserved ranges. */
function isPrivateIpv4(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  const inRange = (base: string, bits: number) => {
    const baseInt = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (baseInt & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // private
    inRange("192.168.0.0", 16) || // private
    inRange("192.0.2.0", 24) || // TEST-NET
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("240.0.0.0", 4) // reserved
  );
}

/**
 * SSRF guard for an auto-POST target. Allows only plain HTTPS to a public host:
 * no credentials, no loopback/internal hostnames, no private/reserved IP
 * literals (so a crafted header can't make us POST at internal infra or the
 * cloud metadata endpoint). DNS-rebinding to a private IP is a residual risk we
 * accept for v1 — the caller also disables redirect-following, so a 3xx can't
 * bounce the request to an unchecked host.
 */
export function isSafeUnsubUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata"
  ) {
    return false;
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (
    host === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host)
  ) {
    return false;
  }
  if (isPrivateIpv4(host)) return false;
  return true;
}

/**
 * Fire the RFC 8058 one-click unsubscribe: POST `List-Unsubscribe=One-Click`.
 * SSRF-guarded, redirect-pinned, and time-bounded. Returns whether the endpoint
 * accepted it (any non-error status). Never throws.
 */
export async function postOneClickUnsubscribe(url: string): Promise<boolean> {
  if (!isSafeUnsubUrl(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual", // don't follow a 3xx to an unchecked host
      signal: controller.signal,
    });
    return res.status > 0 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
