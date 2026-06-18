/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

// App-level Content-Security-Policy. Permissive where the app genuinely needs it
// (Next's inline bootstrap/hydration scripts, the veil WebAssembly loader, blob
// workers) but it blocks external scripts, plugins, base-uri/form-action hijacks
// and cross-origin connections — the client only ever talks to its own origin.
// The sole external dependency is Cloudflare Turnstile, which gates the landing's
// "Connect Google" CTA: it loads api.js, renders a challenge iframe, and posts
// the solution back to challenges.cloudflare.com — allowlisted on the three
// directives it touches and nowhere else.
const TURNSTILE = "https://challenges.cloudflare.com";
// Razorpay Checkout loads its script from checkout.razorpay.com, opens the
// payment UI in an iframe from api.razorpay.com, and posts telemetry to
// lumberjack.razorpay.com — allowlisted only on the directives it needs.
const RAZORPAY_SCRIPT = "https://checkout.razorpay.com";
const RAZORPAY_FRAME = "https://api.razorpay.com https://checkout.razorpay.com";
const RAZORPAY_CONNECT =
  "https://api.razorpay.com https://lumberjack.razorpay.com https://*.razorpay.com";
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  // 'self' for the Connect form's POST to /api/oauth/start; Google's OAuth
  // origin because that POST 303-redirects to the consent screen and Chrome
  // enforces form-action against the redirect target.
  "form-action 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${TURNSTILE} ${RAZORPAY_SCRIPT}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${TURNSTILE} ${RAZORPAY_CONNECT}`,
  `frame-src 'self' ${TURNSTILE} ${RAZORPAY_FRAME}`,
  "worker-src 'self' blob:",
  "media-src 'self' https: data:",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

/** @type {import("next").NextConfig} */
const config = {
  // Minimal self-contained server (server.js + traced deps) for a small Docker
  // image — built in CI, never on the RAM-tight VPS.
  output: "standalone",
  // Lets a production build target a separate output dir (NEXT_DIST_DIR) so it
  // never clobbers the turbopack dev cache in .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // isolated-vm is a native addon (.node) that powers the run_script sandbox.
  // It must never be bundled by webpack — require it at runtime so Next's file
  // tracing copies the compiled binary into the standalone output instead.
  // unpdf/mammoth/xlsx parse attachment bytes server-side for Documents text
  // extraction — keep them out of the client/edge bundle.
  serverExternalPackages: ["isolated-vm", "unpdf", "mammoth", "xlsx"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
