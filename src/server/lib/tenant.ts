import "server-only";
import { corsair } from "@/server/corsair";
import { getTenantId } from "@/server/lib/session";

/**
 * Corsair client scoped to the signed-in user's tenant. Throws "not
 * authenticated" when there is no session, which the read procedures treat
 * as an empty result (see listOrEmpty) and the UI as "connect your account".
 */
export async function getTenant() {
  const tenantId = await getTenantId();
  if (!tenantId) throw new Error("not authenticated: no session");
  return corsair.withTenant(tenantId);
}
