import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { corsairAccounts, corsairIntegrations } from "@/server/db/schema";
import { getTenantId } from "@/server/lib/session";

export type ConnectionStatus = {
  gmail: boolean;
  calendar: boolean;
};

/**
 * A plugin is "connected" when the current user's tenant has an authorized
 * account for it. Reads the Corsair tables directly, scoped to the session.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const tenantId = await getTenantId();
  if (!tenantId) return { gmail: false, calendar: false };

  const rows = await db
    .select({ name: corsairIntegrations.name })
    .from(corsairIntegrations)
    .innerJoin(
      corsairAccounts,
      eq(corsairAccounts.integrationId, corsairIntegrations.id),
    )
    .where(eq(corsairAccounts.tenantId, tenantId));

  const connected = new Set(rows.map((row) => row.name));
  return {
    gmail: connected.has("gmail"),
    calendar: connected.has("googlecalendar"),
  };
}
