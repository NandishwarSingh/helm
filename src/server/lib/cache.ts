import "server-only";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { corsairAccounts, corsairEntities } from "@/server/db/schema";

/**
 * Removes an entity from Corsair's local cache. Needed after destructive
 * operations (event delete, draft delete/send): the upstream API returns
 * void, so the cache never hears about the removal and the row would
 * otherwise linger in list views until a webhook or full resync.
 */
export async function purgeCachedEntity(
  tenantId: string,
  entityId: string,
): Promise<void> {
  await db
    .delete(corsairEntities)
    .where(
      and(
        eq(corsairEntities.entityId, entityId),
        inArray(
          corsairEntities.accountId,
          db
            .select({ id: corsairAccounts.id })
            .from(corsairAccounts)
            .where(eq(corsairAccounts.tenantId, tenantId)),
        ),
      ),
    );
}
