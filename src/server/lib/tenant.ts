import { env } from "@/env";
import { corsair } from "@/server/corsair";

/** Returns the Corsair client scoped to the active tenant's credentials. */
export function getTenant() {
  return corsair.withTenant(env.TENANT_ID);
}
