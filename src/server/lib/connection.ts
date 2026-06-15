import { eq } from "drizzle-orm";

import { env } from "@/env";
import { db } from "@/server/db";
import { corsairAccounts, corsairIntegrations } from "@/server/db/schema";

export type ConnectionStatus = {
  gmail: boolean;
  calendar: boolean;
};

/**
 * A plugin is "connected" when its integration exists and the active tenant
 * has an authorized account for it. Reads the Corsair tables directly.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const rows = await db
    .select({ name: corsairIntegrations.name })
    .from(corsairIntegrations)
    .innerJoin(
      corsairAccounts,
      eq(corsairAccounts.integrationId, corsairIntegrations.id),
    )
    .where(eq(corsairAccounts.tenantId, env.TENANT_ID));

  const connected = new Set(rows.map((row) => row.name));
  return {
    gmail: connected.has("gmail"),
    calendar: connected.has("googlecalendar"),
  };
}
