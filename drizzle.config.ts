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
  // Must list EVERY Drizzle-managed table in schema.ts (mail_embeddings is the
  // one deliberate exception — it's raw SQL). NEVER run `db:push` against prod:
  // push diffs live-vs-schema and a table missing here could emit a DROP. Prod
  // only ever runs `db:migrate`.
  tablesFilter: [
    "corsair_*",
    "mail_sync",
    "mail_triage",
    "gmail_watch",
    "calendar_watch",
    "users",
    "user_accounts",
    "subscriptions",
  ],
} satisfies Config;
