import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests cover the pure logic — codecs, label maths, rate limiting,
 * the OAuth state token, calendar geometry. `server-only` is stubbed so those
 * modules import outside Next, and env validation is skipped (the tests set
 * just the vars they need).
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(
        new URL("./test/stubs/server-only.ts", import.meta.url),
      ),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: {
      SKIP_ENV_VALIDATION: "1",
      AUTH_SECRET: "test-secret-0123456789-abcdef",
    },
  },
});
