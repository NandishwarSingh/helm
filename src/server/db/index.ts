import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/env";
import * as schema from "./schema";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

// Bounded pool so concurrent requests share connections instead of opening
// one each (the driver default is 10). Sized for a VPS; with several
// instances behind a load balancer, keep total below Postgres max_connections.
export const conn =
  globalForDb.conn ??
  postgres(env.DATABASE_URL, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });
if (env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
