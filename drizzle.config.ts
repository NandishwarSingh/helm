import { type Config } from "drizzle-kit";

import { env } from "@/env";

export default {
  schema: "./src/server/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  // Timestamp-prefixed migration filenames (e.g. 20260611123000_add_x.sql).
  migrations: {
    prefix: "timestamp",
  },
  tablesFilter: ["corsair_*", "mail_sync", "mail_triage", "users", "user_accounts"],
} satisfies Config;
