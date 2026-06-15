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
    // Active Corsair tenant. Single-tenant in development; per-user in production.
    TENANT_ID: z.string().min(1).default("dev"),
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
  },

  /**
   * Edge runtimes and the client can't destructure `process.env`, so the
   * values are mapped through explicitly.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    CORSAIR_KEK: process.env.CORSAIR_KEK,
    TENANT_ID: process.env.TENANT_ID,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
