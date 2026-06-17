import "server-only";
import { corsair } from "@/server/corsair";
import { getTenantId } from "@/server/lib/session";
import { getUserAccounts, resolveAccountTenant } from "@/server/lib/users";

/**
 * Corsair client scoped to the signed-in session's ACTIVE account. Throws "not
 * authenticated" when there is no session, which the read procedures treat as an
 * empty result (see listOrEmpty) and the UI as "connect your account".
 */
export async function getTenant() {
  const tenantId = await getTenantId();
  if (!tenantId) throw new Error("not authenticated: no session");
  return corsair.withTenant(tenantId);
}

/**
 * Corsair client for a SPECIFIC account the session owns. Throws if the account
 * id isn't one of the caller's — the authorization gate for per-account ops.
 */
export async function getTenantForAccount(accountId: string) {
  const tenantId = await resolveAccountTenant(accountId);
  if (!tenantId) throw new Error("not authorized: unknown account");
  return corsair.withTenant(tenantId);
}

export type AccountClient = {
  accountId: string;
  tenantId: string;
  email: string;
  client: ReturnType<typeof corsair.withTenant>;
};

/**
 * One Corsair client per account the session owns, for unified fan-out across a
 * user's mailboxes. Single-account sessions yield exactly one entry, so callers
 * can use this uniformly.
 */
export async function getAccountClients(): Promise<AccountClient[]> {
  const accounts = await getUserAccounts();
  return accounts.map((a) => ({
    accountId: a.id,
    tenantId: a.tenantId,
    email: a.email,
    client: corsair.withTenant(a.tenantId),
  }));
}
