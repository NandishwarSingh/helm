import "server-only";

import { corsair } from "@/server/corsair";

/**
 * Pull the newest Gmail page for a tenant and hydrate it into Corsair's cache.
 * Gmail's push only carries a historyId ("something changed"), so on a webhook
 * we sync the latest messages ourselves before notifying the client — otherwise
 * the UI refetches a cache that doesn't have the new mail yet. Bounded + best
 * effort (failures are swallowed by the caller).
 */
export async function syncNewMailForTenant(tenantId: string): Promise<number> {
  const tenant = corsair.withTenant(tenantId);
  const result = await tenant.gmail.api.messages.list({ maxResults: 25 });
  const ids = (result.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));

  let hydrated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(
      ids.slice(i, i + 10).map((id) =>
        tenant.gmail.api.messages
          .get({ id, format: "metadata" })
          .then(() => true)
          .catch(() => false),
      ),
    );
    hydrated += batch.filter(Boolean).length;
  }
  return hydrated;
}
