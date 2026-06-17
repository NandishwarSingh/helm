import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Server-side environment. Validated at boot so a misconfigured deploy
   * fails fast instead of erroring on the first request.
   */
  server: {
    DATABASE_URL: z.string().url(),
    // Key-encryption key Corsair uses to envelope-encrypt per-tenant secrets.
    CORSAIR_KEK: z.string().min(1),
    // Secret used to HMAC-sign the session cookie that scopes each user's tenant.
    AUTH_SECRET: z.string().min(16),
    // OpenRouter key powering the agent (DeepSeek chat + embeddings).
    OPENROUTER_API_KEY: z.string().min(1),
    // Optional Redis URL. When set, rate-limit counters are shared across all
    // app instances; without it a per-process window is used (single VPS).
    REDIS_URL: z.string().url().optional(),
    // Google OAuth client (Web application) used for the single combined-scope
    // consent that connects Gmail and Calendar in one flow.
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    // Fallback tenant for CLI/local use when no session cookie is present.
    TENANT_ID: z.string().min(1).default("dev"),
    // Shared secret gating /api/webhooks: callers must present it via the
    // `x-webhook-secret` header or `?secret=` query. Required in production so
    // the webhook is never an unauthenticated trigger; optional in development.
    WEBHOOK_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string().min(16)
        : z.string().min(16).optional(),
    // Cloudflare Turnstile secret, verified server-side before the landing's
    // "Connect Google" CTA starts OAuth. Optional everywhere: when unset the
    // bot check is skipped (so dev and an un-keyed prod still connect), and it
    // activates the moment a key is configured.
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  /**
   * Client-side environment. Must be prefixed with `NEXT_PUBLIC_` to be
   * exposed to the browser.
   */
  client: {
    NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
    // Public Turnstile site key. When set, the landing renders the widget;
    // when unset, the CTA connects without a challenge (paired with the
    // optional secret above).
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  },

  /**
   * Edge runtimes and the client can't destructure `process.env`, so the
   * values are mapped through explicitly.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    CORSAIR_KEK: process.env.CORSAIR_KEK,
    AUTH_SECRET: process.env.AUTH_SECRET,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    REDIS_URL: process.env.REDIS_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    TENANT_ID: process.env.TENANT_ID,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
